import "~/lib/env.server"

import { createHash, createPrivateKey, createSign, X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { Agent } from "undici"
import { XMLParser } from "fast-xml-parser"

/**
 * Cliente do webservice nacional de Distribuição de DF-e da SEFAZ
 * (`NFeDistribuicaoDFe`), **por loja**.
 *
 * Ao contrário do Inter — onde QI e QNE compartilham uma "conta" porque usam a
 * mesma conta corrente —, aqui a chave é o CÓDIGO DA LOJA, não a conta: QI e
 * QNE têm CNPJs diferentes (32907479000130 e 32907479000211, confirmado no
 * cadastro), e a SEFAZ trata cada CNPJ como um interessado à parte — um
 * certificado emitido para o CNPJ da matriz não autentica consulta de nota
 * endereçada à filial. Uma conta bancária compartilhada não muda isso.
 *
 * O restante do desenho copia `inter.server.ts` de propósito: cert/key em PEM
 * lidos do ambiente (arquivo em dev, conteúdo direto em produção), um
 * `undici.Agent` cacheado por loja para o mTLS, erro de configuração ausente
 * como exceção própria em vez de deixar o handshake falhar calado.
 *
 * Diferença central: não há OAuth aqui. É o próprio certificado de cliente
 * que autentica a chamada — não existe token para cachear.
 */

const ENDPOINT = {
  producao: "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
  homologacao: "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
} as const

/**
 * Recepção de evento, para a manifestação do destinatário.
 *
 * Da mesma lista do sped-nfe, UF "AN": método `nfeRecepcaoEvento`, operação
 * `NFeRecepcaoEvento4`, versão 1.00. Repare que produção é `www`, e não o
 * `www1` da distribuição — são hosts diferentes.
 */
const ENDPOINT_EVENTO = {
  producao: "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  homologacao: "https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
} as const

// Confirmado contra a lista de webservices mantida pelo projeto sped-nfe
// (nfephp-org/sped-nfe, storage/wsnfe_4.00_mod55.xml, UF "AN"): método
// nfeDistDFeInteresse, operação NFeDistribuicaoDFe, versão do schema 1.01.
const NAMESPACE_OPERACAO = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"
const NAMESPACE_EVENTO = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"
const NAMESPACE_PORTAL = "http://www.portalfiscal.inf.br/nfe"
const NAMESPACE_DSIG = "http://www.w3.org/2000/09/xmldsig#"
const VERSAO_SCHEMA = "1.01"
const VERSAO_EVENTO = "1.00"

/**
 * "Ciência da Operação": o destinatário diz que sabe que a nota existe.
 *
 * É a mais inofensiva das quatro manifestações — não confirma recebimento de
 * mercadoria nem impede o emitente de cancelar. O que ela faz, e é por isso que
 * existe aqui, é LIBERAR O XML COMPLETO: até a manifestação a SEFAZ distribui
 * só o resumo (`resNFe`), sem itens, e sem itens não há entrada de estoque nem
 * conta a pagar.
 *
 * As outras três — Confirmação, Desconhecimento e Operação não Realizada — são
 * declaração sobre a mercadoria, e não entram aqui de propósito: quem as dá é
 * quem conferiu a carga, não uma rotina.
 */
const TP_EVENTO_CIENCIA = "210210"
const DESCRICAO_CIENCIA = "Ciencia da Operacao"
/** Manifestação é evento do Ambiente Nacional, e o órgão dele é 91. */
const C_ORGAO_AN = 91

/** Código IBGE de cada UF — é o que a consulta chama de `cUFAutor`. */
const CUF_POR_UF: Record<string, number> = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53,
}

type Config = {
  cert: Buffer
  key: Buffer
  cnpj: string
  cUFAutor: number
}

const configPorLoja = new Map<string, Config>()
const agentePorLoja = new Map<string, Agent>()

export class SefazNaoConfigurado extends Error {}

/** Mesma leitura de PEM do ambiente que `inter.server.ts` — ver o comentário lá. */
function pemDeAmbiente(loja: string, sufixo: string): Buffer | null {
  const varConteudo = `SEFAZ_${loja}_${sufixo}`
  const conteudo = process.env[varConteudo]

  if (conteudo) {
    if (conteudo.includes("-----BEGIN")) {
      return Buffer.from(conteudo.replace(/\\n/g, "\n"))
    }
    const decodificado = Buffer.from(conteudo, "base64")
    if (!decodificado.toString("utf8").includes("-----BEGIN")) {
      throw new SefazNaoConfigurado(`${varConteudo} não parece um PEM nem base64 de um PEM`)
    }
    return decodificado
  }

  const caminho = process.env[`SEFAZ_${loja}_${sufixo}_PATH`]
  return caminho ? readFileSync(caminho) : null
}

/** As lojas que participam da rede, para resolver CNPJ e UF sem repetir cadastro aqui. */
async function dadosDaLoja(loja: string): Promise<{ cnpj: string; uf: string }> {
  const { db } = await import("~/lib/db.server")
  const registro = await db.loja.findUnique({
    where: { codigo: loja },
    select: { cnpj: true, uf: true },
  })
  if (!registro) throw new SefazNaoConfigurado(`Loja "${loja}" não cadastrada`)
  if (!registro.uf) throw new SefazNaoConfigurado(`Loja "${loja}" sem UF cadastrada`)
  return { cnpj: registro.cnpj, uf: registro.uf }
}

async function lerConfig(loja: string): Promise<Config> {
  const guardada = configPorLoja.get(loja)
  if (guardada) return guardada

  const cert = pemDeAmbiente(loja, "CERT")
  const key = pemDeAmbiente(loja, "KEY")

  const faltando = Object.entries({
    [`SEFAZ_${loja}_CERT`]: cert,
    [`SEFAZ_${loja}_KEY`]: key,
  })
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome)

  if (faltando.length > 0) {
    throw new SefazNaoConfigurado(`Loja ${loja} sem certificado SEFAZ. Faltam: ${faltando.join(", ")}`)
  }

  const { cnpj, uf } = await dadosDaLoja(loja)
  const cUFAutor = CUF_POR_UF[uf]
  if (!cUFAutor) throw new SefazNaoConfigurado(`UF "${uf}" da loja ${loja} não reconhecida`)

  const config: Config = { cert: cert!, key: key!, cnpj, cUFAutor }
  configPorLoja.set(loja, config)
  return config
}

export async function sefazConfigurado(loja: string) {
  try {
    await lerConfig(loja)
    return true
  } catch {
    return false
  }
}

/**
 * Esquece o certificado guardado em memória para esta loja — chamado depois de
 * uma renovação salvar um arquivo novo no mesmo caminho. Sem isto, o processo
 * continuaria usando o certificado antigo (e o mTLS antigo) até reiniciar,
 * porque `lerConfig` só lê o arquivo na primeira vez que a loja é usada.
 */
export function invalidarConfigSefaz(loja: string) {
  configPorLoja.delete(loja)
  agentePorLoja.delete(loja)
}

/**
 * O que o certificado da loja diz sobre si — mesmo formato de
 * `certificadoDaConta` do Inter, para a mesma seção em `/saude`.
 */
export function certificadoSefazDaLoja(loja: string) {
  try {
    const cert = pemDeAmbiente(loja, "CERT")
    if (!cert) return null

    const key = pemDeAmbiente(loja, "KEY")
    const x509 = new X509Certificate(cert)
    const vence = new Date(x509.validTo)
    const dias = Math.floor((vence.getTime() - Date.now()) / 86_400_000)

    return {
      titular: x509.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) ?? null,
      venceEm: vence.toISOString().slice(0, 10),
      diasParaVencer: dias,
      renovar: dias < 30,
      chaveCombina: key ? x509.checkPrivateKey(createPrivateKey(key)) : null,
    }
  } catch {
    return null
  }
}

function agente(loja: string, cert: Buffer, key: Buffer) {
  const guardado = agentePorLoja.get(loja)
  if (guardado) return guardado

  const novo = new Agent({ connect: { cert, key } })
  agentePorLoja.set(loja, novo)
  return novo
}

/**
 * Erro de TLS chega como código do OpenSSL — a mesma tradução de
 * `inter.server.ts`, adaptada: aqui não há ambiente sandbox/produção para
 * confundir, então o motivo mais comum é certificado vencido ou CNPJ do
 * certificado que não bate com o CNPJ da loja.
 */
function traduzirErroDeTls(erro: unknown, loja: string): unknown {
  const codigo =
    (erro as { code?: string })?.code ?? ((erro as { cause?: { code?: string } })?.cause?.code ?? "")

  if (codigo === "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED") {
    return new SefazNaoConfigurado(`O certificado SEFAZ da loja ${loja} está expirado.`)
  }
  if (codigo === "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA" || codigo === "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE") {
    return new SefazNaoConfigurado(
      `A SEFAZ recusou o certificado da loja ${loja}. Confira se é um certificado e-CNPJ A1 ` +
        "válido para o CNPJ desta loja."
    )
  }
  return erro
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  // Sem isto, o parser converte texto que "parece número" para Number — e
  // destrói exatamente os campos que mais importam aqui: CNPJ com zero à
  // esquerda perde o zero (`00909913000125` vira `909913000125`), e a chave
  // de acesso (44 dígitos) estoura a precisão seguro do JS e vira notação
  // científica, ilegível e inútil. Todo campo numérico que este arquivo
  // precisa já é convertido explicitamente com `Number(...)` — não há nada
  // aqui que dependa da conversão automática.
  parseTagValue: false,
})

/**
 * Um documento como a SEFAZ o entrega: comprimido, com o schema que diz o que
 * ele é e o NSU sob o qual foi distribuído.
 *
 * O NSU vem junto porque é a única forma de responder depois "este documento
 * chegou a passar por aqui?". Sem ele gravado, descobrir se a sincronização
 * pulou alguma coisa exige rebobinar o cursor às cegas e comparar o antes e o
 * depois — que foi exatamente o que precisou ser feito quando quatro notas
 * sumiram sem deixar rastro.
 */
type DocZip = { schema: string; xml: string; nsu: string }

/**
 * Os dois únicos desfechos em que a SEFAZ de fato RESPONDEU a consulta de
 * distribuição: achou documento (138) ou não achou nenhum (137).
 *
 * Qualquer outro código é recusa — serviço paralisado (108/109), consumo
 * indevido (656), rejeição de schema, ambiente errado. Tratar recusa como
 * "não há nada" foi o que fez a tela anunciar "em dia" durante dez dias
 * enquanto quatro notas de fornecedor ficavam do lado de fora.
 */
const CSTAT_COM_DOCUMENTO = "138"
const CSTAT_SEM_DOCUMENTO = "137"

function recusa(cStat: string, xMotivo: string): string {
  if (cStat === "656") return `Limite de consultas por hora excedido nesta loja (${xMotivo})`
  return `A SEFAZ recusou a consulta — cStat ${cStat}: ${xMotivo}`
}

export type ResultadoConsultaChave =
  | {
      ok: true
      cStat: string
      xMotivo: string
      /** null quando a SEFAZ não tinha nenhum documento para esta chave — só isso, sem erro. */
      documento: DocZip | null
    }
  | { ok: false; erro: string }

/**
 * Busca o XML de uma NF-e pela chave de acesso, na conta da loja informada.
 *
 * Limite conhecido da SEFAZ: 20 consultas por hora por CNPJ, com bloqueio de
 * 1h se estourar (cStat 656) — isso não é bug do cliente, é regra do serviço,
 * e por isso vira mensagem específica em vez de erro genérico.
 *
 * O documento devolvido pode vir em dois formatos, e quem chama precisa saber
 * distinguir: `procNFe` é o XML completo (com todos os itens), `resNFe` é só
 * um resumo — acontece quando a SEFAZ ainda não tem o documento completo
 * disponível para distribuição. Isso é decidido pelo prefixo do atributo
 * `schema` do `docZip`, não escondido daqui.
 */
export async function consultarChaveNaSefaz(
  loja: string,
  chave: string,
  ambiente: "producao" | "homologacao" = "producao"
): Promise<ResultadoConsultaChave> {
  const chaveLimpa = chave.replace(/\D/g, "")
  if (chaveLimpa.length !== 44) {
    return { ok: false, erro: "Chave de acesso precisa ter 44 dígitos" }
  }

  const chamada = await chamarDistribuicao(loja, `<consChNFe><chNFe>${chaveLimpa}</chNFe></consChNFe>`, ambiente)
  if (!chamada.ok) return chamada

  const { cStat, xMotivo, retorno } = chamada
  if (cStat !== CSTAT_COM_DOCUMENTO && cStat !== CSTAT_SEM_DOCUMENTO) {
    return { ok: false, erro: recusa(cStat, xMotivo) }
  }

  const docZipBruto = retorno.loteDistDFeInt?.docZip
  if (!docZipBruto) {
    // cStat 137 = nenhum documento localizado para a chave. Não é erro do
    // cliente — é a SEFAZ dizendo "não tenho isso para te dar".
    return { ok: true, cStat, xMotivo, documento: null }
  }

  const doc = Array.isArray(docZipBruto) ? docZipBruto[0] : docZipBruto
  return { ok: true, cStat, xMotivo, documento: descompactarDocZip(doc) }
}

/**
 * Busca UM documento pelo seu NSU (`consNSU`) — o método que a SEFAZ oferece
 * justamente para recuperar um documento pontual.
 *
 * É o contrário de `distNSU`: aqui não se avança cursor nenhum, pede-se um
 * número específico e pronto. E é a única forma legítima de reler o passado —
 * rebobinar o cursor de distribuição para trás a SEFAZ recusa como consumo
 * indevido ("deve ser utilizado o ultNSU nas solicitações subsequentes") e
 * pune com uma hora de bloqueio do CNPJ inteiro.
 *
 * `documento: null` com cStat 137 quer dizer que aquele NSU não tem nada para
 * esta empresa — acontece, a numeração não é densa por interessado.
 */
export async function consultarNsuAvulsoNaSefaz(
  loja: string,
  nsu: string,
  ambiente: "producao" | "homologacao" = "producao"
): Promise<ResultadoConsultaChave> {
  const nsuFormatado = (nsu.replace(/\D/g, "") || "0").padStart(15, "0").slice(-15)

  const chamada = await chamarDistribuicao(loja, `<consNSU><NSU>${nsuFormatado}</NSU></consNSU>`, ambiente)
  if (!chamada.ok) return chamada

  const { cStat, xMotivo, retorno } = chamada
  if (cStat !== CSTAT_COM_DOCUMENTO && cStat !== CSTAT_SEM_DOCUMENTO) {
    return { ok: false, erro: recusa(cStat, xMotivo) }
  }

  const docZipBruto = retorno.loteDistDFeInt?.docZip
  if (!docZipBruto) return { ok: true, cStat, xMotivo, documento: null }

  const doc = Array.isArray(docZipBruto) ? docZipBruto[0] : docZipBruto
  return { ok: true, cStat, xMotivo, documento: descompactarDocZip(doc) }
}

/**
 * Busca, a partir de um NSU, os documentos seguintes destinados à loja —
 * até 50 por chamada, conforme a própria SEFAZ devolve. É o mecanismo de
 * sincronização contínua (`distNSU`), diferente da consulta por chave: aqui
 * não se escolhe o documento, pega-se tudo que existe a partir de onde a
 * última sincronização parou.
 *
 * `ultNSU`/`maxNSU` na resposta dizem se ainda falta avançar: `ultNSU` é até
 * onde esta chamada foi, `maxNSU` é o total disponível na SEFAZ agora. Quando
 * os dois batem, a loja está em dia.
 */
export type ResultadoSincronizacaoNsu =
  | {
      ok: true
      cStat: string
      xMotivo: string
      /**
       * Até onde esta chamada foi e o quanto existe na SEFAZ — `null` quando a
       * resposta não trouxe o campo.
       *
       * `null` de propósito, em vez do NSU que nós mesmos mandamos: preenchido
       * com o nosso, "até onde fui" fica igual a "quanto existe" e o cursor se
       * declara em dia sozinho, sem a SEFAZ ter dito isso em momento nenhum.
       * Quem chama precisa poder distinguir "acabou" de "não me disseram".
       */
      ultNSU: string | null
      maxNSU: string | null
      documentos: DocZip[]
    }
  | { ok: false; erro: string }

export async function consultarNsuNaSefaz(
  loja: string,
  ultNsu: string,
  ambiente: "producao" | "homologacao" = "producao"
): Promise<ResultadoSincronizacaoNsu> {
  const nsuFormatado = ultNsu.padStart(15, "0").slice(-15)
  const chamada = await chamarDistribuicao(loja, `<distNSU><ultNSU>${nsuFormatado}</ultNSU></distNSU>`, ambiente)
  if (!chamada.ok) return chamada

  const { cStat, xMotivo, retorno } = chamada
  if (cStat !== CSTAT_COM_DOCUMENTO && cStat !== CSTAT_SEM_DOCUMENTO) {
    return { ok: false, erro: recusa(cStat, xMotivo) }
  }

  const docZipBruto = retorno.loteDistDFeInt?.docZip
  const lista = docZipBruto ? (Array.isArray(docZipBruto) ? docZipBruto : [docZipBruto]) : []

  return {
    ok: true,
    cStat,
    xMotivo,
    ultNSU: retorno.ultNSU != null ? String(retorno.ultNSU) : null,
    maxNSU: retorno.maxNSU != null ? String(retorno.maxNSU) : null,
    documentos: lista.map(descompactarDocZip),
  }
}

function descompactarDocZip(doc: any): DocZip {
  const schema = String(doc["@_schema"] ?? "")
  const nsu = String(doc["@_NSU"] ?? "")
  const base64 = String(doc["#text"] ?? "")
  const xml = gunzipSync(Buffer.from(base64, "base64")).toString("utf8")
  return { schema, xml, nsu }
}

/**
 * O que os dois métodos (`consChNFe` e `distNSU`) têm em comum: montar o
 * envelope, autenticar com o certificado da loja, mandar, e devolver o
 * `retDistDFeInt` já verificado (sem Fault, com `cStat`/`xMotivo` extraídos).
 * Cada método interpreta o resto da forma que só ele entende (um `docZip` ou
 * uma lista, `ultNSU`/`maxNSU` ou não).
 */
async function chamarDistribuicao(
  loja: string,
  tagInterna: string,
  ambiente: "producao" | "homologacao"
): Promise<{ ok: true; cStat: string; xMotivo: string; retorno: any } | { ok: false; erro: string }> {
  let config: Config
  try {
    config = await lerConfig(loja)
  } catch (erro) {
    return { ok: false, erro: erro instanceof Error ? erro.message : String(erro) }
  }

  const tpAmb = ambiente === "producao" ? 1 : 2
  const distDFeInt =
    `<distDFeInt xmlns="${NAMESPACE_PORTAL}" versao="${VERSAO_SCHEMA}">` +
    `<tpAmb>${tpAmb}</tpAmb>` +
    `<cUFAutor>${config.cUFAutor}</cUFAutor>` +
    `<CNPJ>${config.cnpj}</CNPJ>` +
    tagInterna +
    `</distDFeInt>`

  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeDistDFeInteresse xmlns="${NAMESPACE_OPERACAO}">` +
    `<nfeDadosMsg xmlns="${NAMESPACE_OPERACAO}">${distDFeInt}</nfeDadosMsg>` +
    `</nfeDistDFeInteresse>` +
    `</soap12:Body>` +
    `</soap12:Envelope>`

  const url = ENDPOINT[ambiente]
  const acao = `${NAMESPACE_OPERACAO}/nfeDistDFeInteresse`

  let resposta: Response
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": `application/soap+xml; charset=utf-8; action="${acao}"`,
      },
      body: envelope,
      dispatcher: agente(loja, config.cert, config.key),
    } as RequestInit)
  } catch (erro) {
    const traduzido = traduzirErroDeTls(erro, loja)
    return { ok: false, erro: traduzido instanceof Error ? traduzido.message : String(traduzido) }
  }

  const texto = await resposta.text()
  if (!resposta.ok) {
    return { ok: false, erro: `SEFAZ respondeu HTTP ${resposta.status}: ${texto.slice(0, 300)}` }
  }

  let dados: any
  try {
    dados = parser.parse(texto)
  } catch {
    return { ok: false, erro: "Resposta da SEFAZ não é um XML válido" }
  }

  // `soap:Fault` é como a SEFAZ recusa o pedido antes de processar (envelope
  // malformado, action errada) — diferente de cStat, que é a resposta de
  // negócio já processada.
  const fault = buscarEmProfundidade(dados, "Fault")
  if (fault) {
    const motivo = fault.Reason?.Text ?? fault.faultstring ?? "Motivo não informado"
    return { ok: false, erro: `SOAP Fault da SEFAZ: ${typeof motivo === "string" ? motivo : JSON.stringify(motivo)}` }
  }

  // Busca por nome do nó, não pelo caminho exato: o wrapper (`nfeDistDFeInteresseResponse`
  // > `nfeDistDFeInteresseResult`) é convenção de serviço .asmx e pode variar de detalhe
  // sem mudar o que importa, que é achar o `retDistDFeInt` em algum lugar da árvore — a
  // mesma estratégia que a referência usada para validar este cliente (sped-nfe,
  // `Standardize::whichIs`) adota via `getElementsByTagName`.
  const retorno = buscarEmProfundidade(dados, "retDistDFeInt")
  if (!retorno) {
    return { ok: false, erro: "Resposta da SEFAZ em formato inesperado — sem retDistDFeInt" }
  }

  return { ok: true, cStat: String(retorno.cStat ?? ""), xMotivo: String(retorno.xMotivo ?? ""), retorno }
}

/** Acha o primeiro nó com este nome em qualquer profundidade — ver o comentário de uso abaixo. */
function buscarEmProfundidade(no: any, alvo: string): any {
  if (no == null || typeof no !== "object") return undefined
  if (alvo in no) return no[alvo]
  for (const valor of Object.values(no)) {
    const filho = Array.isArray(valor) ? valor[0] : valor
    if (filho && typeof filho === "object") {
      const achado = buscarEmProfundidade(filho, alvo)
      if (achado !== undefined) return achado
    }
  }
  return undefined
}

/**
 * O resumo de um `resNFe` — quando a SEFAZ ainda não distribui o documento
 * completo. Sem itens (o resumo nunca traz `det`), mas dá pra mostrar quem
 * emitiu, para quem e por quanto em vez de uma tela em branco.
 */
export function resumoDoResNFe(xml: string) {
  const dados: any = parser.parse(xml)
  const resNFe = dados?.resNFe
  if (!resNFe) return null

  return {
    // resNFe não traz número nem série — só quem emitiu, quando e por quanto.
    // `decodificarChave` completa o resto a partir da própria chave.
    chaveAcesso: resNFe.chNFe ? String(resNFe.chNFe) : null,
    dataEmissao: resNFe.dhEmi ? String(resNFe.dhEmi) : null,
    emitenteCnpj: resNFe.CNPJ ? String(resNFe.CNPJ) : null,
    emitenteNome: resNFe.xNome ? String(resNFe.xNome) : null,
    valorTotal: resNFe.vNF ? Number(resNFe.vNF) : null,
  }
}

/**
 * A chave de acesso não é só um identificador opaco — é 44 dígitos com campos
 * embutidos (UF, ano/mês, CNPJ emitente, série, número...). Vale decodificar
 * porque o resumo de uma nota "podada" (`resNFe`) não traz número nem série
 * em lugar nenhum do XML — só a chave. Sem isto, metade das notas mais antigas
 * apareceria na lista sem número nenhum, mesmo a informação estando ali.
 */
export function decodificarChave(chave: string) {
  if (!/^\d{44}$/.test(chave)) return null
  return {
    cUF: chave.slice(0, 2),
    ano: 2000 + Number(chave.slice(2, 4)),
    mes: Number(chave.slice(4, 6)),
    cnpjEmitente: chave.slice(6, 20),
    modelo: chave.slice(20, 22),
    serie: Number(chave.slice(22, 25)),
    numero: Number(chave.slice(25, 34)),
  }
}

/**
 * Extrai os campos de resumo (emitente, número, valor, itens) de um
 * `procNFe` completo — o suficiente para a tela de prova mostrar algo
 * legível sem exigir o parser completo de NF-e, que só entra na fase de
 * gravar itens.
 */
export function resumoDoProcNFe(xml: string) {
  const dados: any = parser.parse(xml)
  const infNFe = dados?.nfeProc?.NFe?.infNFe ?? dados?.NFe?.infNFe
  if (!infNFe) return null

  const ide = infNFe.ide ?? {}
  const emit = infNFe.emit ?? {}
  const dest = infNFe.dest ?? {}
  const total = infNFe.total?.ICMSTot ?? {}
  const det = infNFe.det
  const itens = Array.isArray(det) ? det : det ? [det] : []

  const id = String(infNFe["@_Id"] ?? "")

  return {
    chaveAcesso: id.startsWith("NFe") ? id.slice(3) : null,
    numero: ide.nNF ? String(ide.nNF) : null,
    serie: ide.serie ? String(ide.serie) : null,
    dataEmissao: ide.dhEmi ? String(ide.dhEmi) : null,
    emitenteCnpj: emit.CNPJ ? String(emit.CNPJ) : null,
    emitenteNome: emit.xNome ? String(emit.xNome) : null,
    emitenteCidade: emit.enderEmit?.xMun ? String(emit.enderEmit.xMun) : null,
    emitenteBairro: emit.enderEmit?.xBairro ? String(emit.enderEmit.xBairro) : null,
    destinatarioCnpj: dest.CNPJ ?? dest.CPF ? String(dest.CNPJ ?? dest.CPF) : null,
    destinatarioNome: dest.xNome ? String(dest.xNome) : null,
    valorTotal: total.vNF ? Number(total.vNF) : null,
    // Despesas que a nota lança no total, não item a item — é o que o rateio
    // de custo precisa distribuir entre os itens proporcionalmente.
    vFrete: Number(total.vFrete ?? 0),
    vSeg: Number(total.vSeg ?? 0),
    vDesc: Number(total.vDesc ?? 0),
    vOutro: Number(total.vOutro ?? 0),
    quantidadeItens: itens.length,
    numeroFatura: infNFe.cobr?.fat?.nFat ? String(infNFe.cobr.fat.nFat) : null,
    // O vencimento de cada parcela — nem toda nota tem `cobr` (a prazo sem
    // boleto formal, ou à vista, não gera duplicata nenhuma).
    duplicatas: (() => {
      const dup = infNFe.cobr?.dup
      const lista = Array.isArray(dup) ? dup : dup ? [dup] : []
      return lista.map((d: any) => ({
        numero: d.nDup ? String(d.nDup) : null,
        vencimento: d.dVenc ? String(d.dVenc) : null,
        valor: d.vDup ? Number(d.vDup) : 0,
      }))
    })(),
    itens: itens.map((item: any) => {
      // O sub-objeto do ICMS muda de nome com o CST/CSOSN (ICMS00, ICMS60,
      // ICMSSN101...) — o valor que importa está sempre um nível abaixo, e
      // pegar o primeiro valor do objeto evita listar as ~20 variantes.
      const icms: any = Object.values(item.imposto?.ICMS ?? {})[0] ?? {}
      const ipi = item.imposto?.IPI?.IPITrib

      return {
        codigo: item.prod?.cProd ? String(item.prod.cProd) : null,
        descricao: item.prod?.xProd ? String(item.prod.xProd) : null,
        ean: item.prod?.cEAN ? String(item.prod.cEAN) : null,
        // A classificação fiscal que o fornecedor usou. É o melhor palpite
        // para o produto que ainda não tem NCM cadastrado — vem da nota de
        // quem fabrica, não de um chute nosso.
        ncm: item.prod?.NCM ? String(item.prod.NCM) : null,
        unidade: item.prod?.uCom ? String(item.prod.uCom) : null,
        quantidade: item.prod?.qCom ? Number(item.prod.qCom) : null,
        valorUnitario: item.prod?.vUnCom ? Number(item.prod.vUnCom) : null,
        valorTotal: item.prod?.vProd ? Number(item.prod.vProd) : null,
        // Somam por fora do valor do produto — ICMS "normal" não entra aqui
        // porque já vem embutido no preço negociado (`vUnCom`/`vProd`).
        vIPI: Number(ipi?.vIPI ?? 0),
        vICMSST: Number(icms.vICMSST ?? 0),
      }
    }),
  }
}

/* ===================== Manifestação do destinatário ===================== */

/**
 * Assina o `infEvento` no padrão XML-DSig que a SEFAZ exige.
 *
 * Não há biblioteca de assinatura XML no projeto, e não precisa haver: o XML é
 * construído AQUI, então dá para construí-lo já na forma canônica e assinar a
 * própria string. O que torna isso seguro é um detalhe só, e é onde todo mundo
 * erra — a canonicalização inclusiva RENDERIZA no elemento assinado o namespace
 * que ele herda do pai. Por isso `infEvento` e `SignedInfo` saem daqui com o
 * `xmlns` escrito neles, e não herdado: a string que eu assino passa a ser,
 * caractere a caractere, a que a SEFAZ vai canonicalizar do outro lado.
 *
 * Declarar o mesmo namespace no pai e no filho é XML válido e não muda o
 * resultado da canonicalização — ela o escreve uma vez de qualquer jeito.
 *
 * SHA-1 e RSA-SHA1 não são escolha: são o que o manual da NF-e especifica.
 */
function assinarInfEvento(infEvento: string, id: string, cert: Buffer, key: Buffer) {
  const digest = createHash("sha1").update(infEvento, "utf8").digest("base64")

  const signedInfo =
    `<SignedInfo xmlns="${NAMESPACE_DSIG}">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#${id}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`

  const assinatura = createSign("RSA-SHA1").update(signedInfo, "utf8").sign(key, "base64")

  // O certificado vai em DER base64, sem cabeçalho PEM e sem quebras de linha.
  // Só o primeiro do arquivo: se o PEM trouxer a cadeia, os intermediários não
  // entram no KeyInfo.
  const primeiro = cert.toString("utf8").match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)
  const x509 = (primeiro?.[1] ?? "").replace(/\s+/g, "")

  return (
    `<Signature xmlns="${NAMESPACE_DSIG}">` +
    signedInfo +
    `<SignatureValue>${assinatura}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${x509}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`
  )
}

/** "2026-09-22T10:30:00-03:00" — a SEFAZ recusa data sem fuso. */
function dataHoraComFuso(quando: Date) {
  const doisDigitos = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0")
  const minutos = -quando.getTimezoneOffset()
  const sinal = minutos >= 0 ? "+" : "-"
  const fuso = `${sinal}${doisDigitos(minutos / 60)}:${doisDigitos(minutos % 60)}`

  return (
    `${quando.getFullYear()}-${doisDigitos(quando.getMonth() + 1)}-${doisDigitos(quando.getDate())}` +
    `T${doisDigitos(quando.getHours())}:${doisDigitos(quando.getMinutes())}:${doisDigitos(quando.getSeconds())}${fuso}`
  )
}

export type ResultadoManifestacao =
  | { ok: true; cStat: string; xMotivo: string; protocolo: string | null; jaHavia: boolean }
  | { ok: false; erro: string }

/**
 * Registra a Ciência da Operação de uma nota destinada a esta loja.
 *
 * Depois dela, a próxima sincronização traz o XML completo no lugar do resumo —
 * não é imediato, porque quem distribui é o serviço de distribuição, num ciclo
 * próprio.
 *
 * `nSeqEvento` é 1 sempre: a Ciência é dada uma vez por nota. Repetir devolve
 * cStat 573 ("duplicidade de evento"), que NÃO é falha — é o estado desejado,
 * alcançado antes, e por isso volta como sucesso com `jaHavia`.
 */
export async function darCienciaDaOperacao(
  loja: string,
  chave: string,
  ambiente: "producao" | "homologacao" = "producao"
): Promise<ResultadoManifestacao> {
  const chaveLimpa = chave.replace(/\D/g, "")
  if (chaveLimpa.length !== 44) {
    return { ok: false, erro: "Chave de acesso precisa ter 44 dígitos" }
  }

  let config: Config
  try {
    config = await lerConfig(loja)
  } catch (erro) {
    return { ok: false, erro: erro instanceof Error ? erro.message : String(erro) }
  }

  const tpAmb = ambiente === "producao" ? 1 : 2
  const nSeqEvento = "01"
  const id = `ID${TP_EVENTO_CIENCIA}${chaveLimpa}${nSeqEvento}`

  const infEvento =
    `<infEvento xmlns="${NAMESPACE_PORTAL}" Id="${id}">` +
    `<cOrgao>${C_ORGAO_AN}</cOrgao>` +
    `<tpAmb>${tpAmb}</tpAmb>` +
    `<CNPJ>${config.cnpj}</CNPJ>` +
    `<chNFe>${chaveLimpa}</chNFe>` +
    `<dhEvento>${dataHoraComFuso(new Date())}</dhEvento>` +
    `<tpEvento>${TP_EVENTO_CIENCIA}</tpEvento>` +
    `<nSeqEvento>${Number(nSeqEvento)}</nSeqEvento>` +
    `<verEvento>${VERSAO_EVENTO}</verEvento>` +
    `<detEvento versao="${VERSAO_EVENTO}">` +
    `<descEvento>${DESCRICAO_CIENCIA}</descEvento>` +
    `</detEvento>` +
    `</infEvento>`

  const assinatura = assinarInfEvento(infEvento, id, config.cert, config.key)

  const envEvento =
    `<envEvento xmlns="${NAMESPACE_PORTAL}" versao="${VERSAO_EVENTO}">` +
    `<idLote>1</idLote>` +
    `<evento versao="${VERSAO_EVENTO}">${infEvento}${assinatura}</evento>` +
    `</envEvento>`

  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeRecepcaoEvento xmlns="${NAMESPACE_EVENTO}">` +
    `<nfeDadosMsg xmlns="${NAMESPACE_EVENTO}">${envEvento}</nfeDadosMsg>` +
    `</nfeRecepcaoEvento>` +
    `</soap12:Body>` +
    `</soap12:Envelope>`

  let resposta: Response
  try {
    resposta = await fetch(ENDPOINT_EVENTO[ambiente], {
      method: "POST",
      headers: {
        "content-type": `application/soap+xml; charset=utf-8; action="${NAMESPACE_EVENTO}/nfeRecepcaoEvento"`,
      },
      body: envelope,
      dispatcher: agente(loja, config.cert, config.key),
    } as RequestInit)
  } catch (erro) {
    const traduzido = traduzirErroDeTls(erro, loja)
    return { ok: false, erro: traduzido instanceof Error ? traduzido.message : String(traduzido) }
  }

  const texto = await resposta.text()
  if (!resposta.ok) {
    return { ok: false, erro: `SEFAZ respondeu HTTP ${resposta.status}: ${texto.slice(0, 300)}` }
  }

  let dados: any
  try {
    dados = parser.parse(texto)
  } catch {
    return { ok: false, erro: "Resposta da SEFAZ não é um XML válido" }
  }

  const fault = buscarEmProfundidade(dados, "Fault")
  if (fault) {
    const motivo = fault.Reason?.Text ?? fault.faultstring ?? "Motivo não informado"
    return {
      ok: false,
      erro: `SOAP Fault da SEFAZ: ${typeof motivo === "string" ? motivo : JSON.stringify(motivo)}`,
    }
  }

  /*
   * A resposta tem DOIS status: o do lote (`retEnvEvento`) e o do evento
   * (`retEvento/infEvento`). O do lote pode ser 128 ("lote processado") com o
   * evento recusado dentro — ler só o de fora daria sucesso para uma
   * manifestação que não aconteceu.
   */
  const retorno = buscarEmProfundidade(dados, "retEnvEvento")
  if (!retorno) return { ok: false, erro: "Resposta da SEFAZ sem retEnvEvento" }

  const doLote = String(retorno.cStat ?? "")
  const evento = buscarEmProfundidade(retorno, "retEvento")
  const info = evento ? (evento.infEvento ?? evento) : null

  if (!info) {
    return { ok: false, erro: `SEFAZ recusou o lote: ${doLote} ${retorno.xMotivo ?? ""}`.trim() }
  }

  const cStat = String(info.cStat ?? "")
  const xMotivo = String(info.xMotivo ?? "")
  const protocolo = info.nProt ? String(info.nProt) : null

  // 135 registrado e vinculado à NF-e · 136 registrado sem vínculo (a nota
  // ainda não chegou ao Ambiente Nacional) · 573 já havia sido manifestada.
  if (cStat === "135" || cStat === "136") {
    return { ok: true, cStat, xMotivo, protocolo, jaHavia: false }
  }
  if (cStat === "573") {
    return { ok: true, cStat, xMotivo, protocolo, jaHavia: true }
  }

  return { ok: false, erro: `SEFAZ recusou o evento: ${cStat} ${xMotivo}`.trim() }
}
