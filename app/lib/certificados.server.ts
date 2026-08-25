import "~/lib/env.server"

import { X509Certificate, createPrivateKey } from "node:crypto"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import forge from "node-forge"

import { db } from "~/lib/db.server"
import { certificadoDaConta, interConfigurado, invalidarConfigInter } from "~/lib/inter.server"
import { certificadoSefazDaLoja, invalidarConfigSefaz, sefazConfigurado } from "~/lib/sefaz.server"

/**
 * Renovação de certificado, pela tela — Inter e SEFAZ, no mesmo lugar, porque
 * quem gerencia é o mesmo gerente e o problema é o mesmo (chave privada que
 * vence calada). O que muda entre os dois é só o formato de entrada: SEFAZ
 * vem da certificadora como `.pfx` com senha, Inter vem do próprio portal como
 * dois arquivos já soltos (`.crt`/`.key`, sem senha).
 *
 * Nunca fica em banco — o comentário em `ContaInter` já explica por quê. Isto
 * grava exatamente onde `inter.server.ts`/`sefaz.server.ts` já esperam
 * encontrar (arquivo local), e some da memória do processo assim que grava,
 * via `invalidarConfig*`, para o próximo uso já pegar o novo.
 */

export type TipoCertificado = "inter" | "sefaz"

export type SlotCertificado = {
  tipo: TipoCertificado
  chave: string
  rotulo: string
  lojas: string[]
  cnpjEsperado: string | null
  configurado: boolean
  certificado: ReturnType<typeof certificadoDaConta> | ReturnType<typeof certificadoSefazDaLoja>
}

export async function listarCertificados(): Promise<SlotCertificado[]> {
  const lojas = await db.loja.findMany({
    where: { ativo: true },
    select: { codigo: true, nome: true, conta: true, cnpj: true },
    orderBy: { ordem: "asc" },
  })

  const slots: SlotCertificado[] = []

  const contasVistas = new Map<string, string[]>()
  for (const loja of lojas) {
    contasVistas.set(loja.conta, [...(contasVistas.get(loja.conta) ?? []), loja.codigo])
  }
  for (const [conta, codigos] of contasVistas) {
    slots.push({
      tipo: "inter",
      chave: conta,
      rotulo: `Inter ${conta}`,
      lojas: codigos,
      // O Inter não grava CNPJ no assunto do certificado (é um certificado
      // próprio da API dele, não ICP-Brasil) — não dá para validar contra o
      // cadastro do mesmo jeito que a SEFAZ.
      cnpjEsperado: null,
      configurado: interConfigurado(conta),
      certificado: certificadoDaConta(conta),
    })
  }

  for (const loja of lojas) {
    slots.push({
      tipo: "sefaz",
      chave: loja.codigo,
      rotulo: `SEFAZ ${loja.codigo}`,
      lojas: [loja.codigo],
      cnpjEsperado: loja.cnpj,
      configurado: await sefazConfigurado(loja.codigo),
      certificado: certificadoSefazDaLoja(loja.codigo),
    })
  }

  return slots
}

// ---------------------------------------------------------------------------
// Leitura do arquivo enviado
// ---------------------------------------------------------------------------

export type CertificadoLido =
  | {
      ok: true
      certPem: string
      keyPem: string
      titular: string
      cnpj: string | null
      venceEm: Date
    }
  | { ok: false; erro: string }

/** SEFAZ: um `.pfx` protegido por senha, como a certificadora entrega. */
export function lerPfx(bytes: Buffer, senha: string): CertificadoLido {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bytes.toString("binary")))
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, senha)

    const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]
    const keyBag = (
      p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ??
      p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]
    )?.[0]

    if (!certBag?.cert || !keyBag?.key) {
      return { ok: false, erro: "O arquivo não tem certificado e chave — confira se é o .pfx certo" }
    }

    const certPem = forge.pki.certificateToPem(certBag.cert)
    const keyPem = forge.pki.privateKeyToPem(keyBag.key)
    const cn = certBag.cert.subject.getField("CN")?.value ?? ""
    const cnpj = cn.match(/(\d{14})/)?.[1] ?? null

    return { ok: true, certPem, keyPem, titular: cn, cnpj, venceEm: certBag.cert.validity.notAfter }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro)
    if (/mac|invalid password|integrity/i.test(mensagem)) {
      return { ok: false, erro: "Senha do certificado incorreta" }
    }
    return { ok: false, erro: `Não consegui ler o certificado: ${mensagem}` }
  }
}

/** Inter: dois arquivos já soltos, sem senha, como o portal entrega. */
export function lerCertEKey(certBytes: Buffer, keyBytes: Buffer): CertificadoLido {
  try {
    const x509 = new X509Certificate(certBytes)
    const chave = createPrivateKey(keyBytes)
    if (!x509.checkPrivateKey(chave)) {
      return { ok: false, erro: "O certificado e a chave enviados não são o mesmo par" }
    }

    return {
      ok: true,
      certPem: certBytes.toString("utf8"),
      keyPem: keyBytes.toString("utf8"),
      titular: x509.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) ?? "",
      cnpj: null,
      venceEm: new Date(x509.validTo),
    }
  } catch (erro) {
    return { ok: false, erro: `Não consegui ler o certificado/chave: ${erro instanceof Error ? erro.message : String(erro)}` }
  }
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

export type ResultadoSalvar =
  | { ok: true; blocoEasypanel: string }
  | { ok: false; erro: string }

/**
 * Grava o certificado lido no lugar certo, invalida o cache do processo, e
 * devolve o bloco pronto para colar nas variáveis de ambiente do easypanel —
 * produção usa conteúdo direto na variável (sem `_PATH`), não o arquivo.
 */
export async function salvarCertificado(
  tipo: TipoCertificado,
  chave: string,
  lido: Extract<CertificadoLido, { ok: true }>
): Promise<ResultadoSalvar> {
  if (lido.venceEm.getTime() < Date.now()) {
    return { ok: false, erro: `Este certificado já está vencido (${lido.venceEm.toISOString().slice(0, 10)})` }
  }

  // A checagem que teria evitado o certificado da matriz autenticando a
  // filial (ou vice-versa): o CNPJ do certificado precisa bater com o CNPJ
  // cadastrado da loja. Só se aplica à SEFAZ — o certificado do Inter não
  // carrega CNPJ no assunto.
  if (tipo === "sefaz" && lido.cnpj) {
    const loja = await db.loja.findUnique({ where: { codigo: chave }, select: { cnpj: true } })
    if (loja && loja.cnpj !== lido.cnpj) {
      return {
        ok: false,
        erro:
          `Este certificado é do CNPJ ${lido.cnpj}, mas a loja ${chave} é cadastrada com o CNPJ ` +
          `${loja.cnpj} — não é o certificado desta loja.`,
      }
    }
  }

  const prefixo = tipo === "inter" ? "INTER" : "SEFAZ"
  const varCertPath = `${prefixo}_${chave}_CERT_PATH`
  const varKeyPath = `${prefixo}_${chave}_KEY_PATH`

  const jaConfigurado = Boolean(process.env[varCertPath])
  const destinoCert = process.env[varCertPath] || `./certificados/${tipo}_${chave.toLowerCase()}_cert.pem`
  const destinoKey = process.env[varKeyPath] || `./certificados/${tipo}_${chave.toLowerCase()}_key.pem`

  try {
    mkdirSync("./certificados", { recursive: true })
    writeFileSync(destinoCert, lido.certPem, { mode: 0o600 })
    writeFileSync(destinoKey, lido.keyPem, { mode: 0o600 })
  } catch (erro) {
    return { ok: false, erro: `Falha ao gravar o arquivo: ${erro instanceof Error ? erro.message : String(erro)}` }
  }

  if (!jaConfigurado) {
    process.env[varCertPath] = destinoCert
    process.env[varKeyPath] = destinoKey
    try {
      appendFileSync(
        ".env",
        `\n# Certificado renovado pela tela em ${new Date().toISOString().slice(0, 10)}\n` +
          `${varCertPath}=${destinoCert}\n${varKeyPath}=${destinoKey}\n`
      )
    } catch {
      // Sem escrita no .env, o processo atual já está usando o certificado
      // novo (setamos process.env acima) — só não sobrevive a um restart.
      // Não é motivo para recusar a renovação que já foi feita.
    }
  }

  if (tipo === "inter") invalidarConfigInter(chave)
  else invalidarConfigSefaz(chave)

  const varCertConteudo = `${prefixo}_${chave}_CERT`
  const varKeyConteudo = `${prefixo}_${chave}_KEY`
  const blocoEasypanel =
    `${varCertConteudo}=${Buffer.from(lido.certPem).toString("base64")}\n` +
    `${varKeyConteudo}=${Buffer.from(lido.keyPem).toString("base64")}`

  return { ok: true, blocoEasypanel }
}
