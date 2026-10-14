import { db } from "~/lib/db.server"
import { emailConfigurado, emailValido, enviarEmail, type Anexo } from "~/lib/email.server"
import { urlDoArquivo } from "~/lib/focus.server"
import { escapar } from "~/lib/html"
import { dadosDaLoja } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"

/**
 * O DANFE e o XML da nota por e-mail ao cliente, pela caixa da empresa.
 *
 * Os arquivos são buscados na Focus na hora (não ficam guardados aqui) e vão
 * anexados como chegam: a NF-e em PDF, a NFC-e em HTML (o DANFE de bobina). O
 * XML vai sempre — é o que o contador do cliente pede.
 */

/** O e-mail do cliente da venda da nota, quando há. */
export async function emailDoClienteDaNota(notaId: string) {
  const nota = await db.notaFiscalEmitida.findUnique({
    where: { id: notaId },
    select: { vendaId: true },
  })
  if (!nota?.vendaId) return null
  const venda = await db.venda.findUnique({
    where: { id: nota.vendaId },
    select: { clienteId: true },
  })
  if (!venda?.clienteId) return null
  const cliente = await db.cliente.findUnique({
    where: { id: venda.clienteId },
    select: { email: true },
  })
  return cliente?.email?.trim() || null
}

async function baixar(caminho: string | null) {
  const endereco = urlDoArquivo(caminho)
  if (!endereco) return null
  const resposta = await fetch(endereco, { signal: AbortSignal.timeout(20000) })
  if (!resposta.ok) throw new Error(`A Focus não devolveu o arquivo (${resposta.status})`)
  return {
    conteudo: Buffer.from(await resposta.arrayBuffer()),
    tipo: resposta.headers.get("content-type") ?? "application/octet-stream",
  }
}

export async function enviarNotaPorEmail(entrada: {
  notaId: string
  para: string
  /** Quem mandou — "automático" no envio que sai sozinho ao autorizar. */
  quem: string
}): Promise<{ ok: true; para: string } | { ok: false; erro: string }> {
  const para = entrada.para.trim()
  if (!emailValido(para)) return { ok: false, erro: "E-mail do cliente inválido" }
  if (!emailConfigurado()) {
    return { ok: false, erro: "E-mail não configurado no servidor (SMTP)" }
  }

  const nota = await db.notaFiscalEmitida.findUnique({ where: { id: entrada.notaId } })
  if (!nota) return { ok: false, erro: "Nota não encontrada" }
  if (nota.status !== "autorizado") {
    return { ok: false, erro: `Só nota autorizada vai por e-mail (esta está ${nota.status.replace(/_/g, " ")})` }
  }

  const modelo = nota.modelo === "nfe" ? "NF-e" : "NFC-e"
  const nome = `${modelo} ${nota.numero ?? ""}`.trim()

  let resultado: { ok: true } | { ok: false; erro: string }
  try {
    const [danfe, xml, loja] = await Promise.all([
      baixar(nota.caminhoDanfe),
      baixar(nota.caminhoXml),
      dadosDaLoja(nota.loja),
    ])
    if (!danfe && !xml) {
      return { ok: false, erro: "A Focus ainda não devolveu o DANFE nem o XML desta nota" }
    }

    const anexos: Anexo[] = []
    if (danfe) {
      const extensao = danfe.tipo.includes("pdf") ? "pdf" : "html"
      anexos.push({ nome: `${nome} - DANFE.${extensao}`, conteudo: danfe.conteudo, tipo: danfe.tipo })
    }
    if (xml) {
      anexos.push({
        nome: `${nota.chave ?? nome}.xml`,
        conteudo: xml.conteudo,
        tipo: "application/xml",
      })
    }

    const empresa = loja.razaoSocial ?? loja.nome
    const linhas = [
      `Olá${nota.destinatarioNome ? `, ${nota.destinatarioNome}` : ""}.`,
      "",
      `Segue a ${nome} da sua compra na ${empresa}, no valor de ${moeda(nota.valorTotal)}.`,
      "Em anexo vão o DANFE e o XML da nota.",
      nota.chave ? `Chave de acesso: ${nota.chave}` : "",
      "",
      "Obrigado pela preferência.",
      empresa,
    ].filter((l, i, todas) => l !== "" || todas[i - 1] !== "")

    resultado = await enviarEmail({
      para,
      assunto: `${nome} — ${empresa}`,
      texto: linhas.join("\n"),
      html: linhas.map((l) => (l ? `<p>${escapar(l)}</p>` : "")).join(""),
      anexos,
    })
  } catch (erro) {
    resultado = { ok: false, erro: erro instanceof Error ? erro.message : "Falha ao montar o e-mail" }
  }

  // O registro vale nos dois desfechos: a tela mostra o envio, ou a falha para reenviar.
  await db.notaFiscalEmitida.update({
    where: { id: nota.id },
    data: resultado.ok
      ? { emailEnviadoEm: new Date(), emailEnviadoPara: para, emailEnviadoPor: entrada.quem, emailErro: null }
      : { emailErro: resultado.erro },
  })

  return resultado.ok ? { ok: true, para } : resultado
}

/**
 * O envio automático: NF-e recém-autorizada, cliente com e-mail, e ainda não
 * mandada. Chamado depois de cada atualização de status — por isso a guarda do
 * "ainda não mandada", para não repetir a cada consulta. Nunca lança: o e-mail
 * que falhou fica registrado na nota para reenviar pelo botão.
 */
export async function enviarNfeAoAutorizar(notaId: string) {
  try {
    const nota = await db.notaFiscalEmitida.findUnique({
      where: { id: notaId },
      select: { modelo: true, status: true, emailEnviadoEm: true, emailErro: true },
    })
    if (!nota || nota.modelo !== "nfe" || nota.status !== "autorizado") return
    // Já foi, ou já tentou e falhou: a próxima é pelo botão, com alguém olhando.
    if (nota.emailEnviadoEm || nota.emailErro) return
    if (!emailConfigurado()) return

    const para = await emailDoClienteDaNota(notaId)
    if (!para || !emailValido(para)) return

    const r = await enviarNotaPorEmail({ notaId, para, quem: "automático" })
    if (!r.ok) console.error("[nota e-mail] envio automático falhou:", r.erro)
  } catch (erro) {
    console.error("[nota e-mail]", erro instanceof Error ? erro.message : erro)
  }
}
