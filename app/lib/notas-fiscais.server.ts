import { db } from "~/lib/db.server"
import {
  consultarChaveNaSefaz,
  consultarNsuNaSefaz,
  decodificarChave,
  resumoDoProcNFe,
  resumoDoResNFe,
  type ResultadoConsultaChave,
} from "~/lib/sefaz.server"

/**
 * O catálogo local de NF-e de fornecedor, mantido em dia com a SEFAZ.
 *
 * Isto NÃO é a entrada de estoque — é o que a rede já sabe que existe,
 * disponível para o gerente escolher o que processar. A entrada de verdade
 * (bater item a item com o catálogo, mover o saldo) é a próxima etapa.
 */

/** Até 20 páginas de 50 documentos (1000) por clique — o suficiente para um mês
 * de movimento típico sem travar a tela nem arriscar o limite de consumo da SEFAZ. */
const PAGINAS_POR_SINCRONIZACAO = 20

export type ResultadoSincronizacao =
  | { ok: true; novas: number; paginas: number; completo: boolean }
  | { ok: false; erro: string; novas: number }

/**
 * Avança a sincronização da loja a partir de onde parou da última vez.
 *
 * Cada página gravada some no cursor (`SincronizacaoSefaz`) IMEDIATAMENTE, não
 * só no fim — se a SEFAZ recusar no meio (limite de consumo, rede caiu), o
 * progresso já feito fica e a próxima tentativa continua dali, em vez de
 * repetir tudo.
 */
export async function sincronizarNotasDaLoja(
  loja: string,
  maxPaginas = PAGINAS_POR_SINCRONIZACAO
): Promise<ResultadoSincronizacao> {
  const cursor = await db.sincronizacaoSefaz.findUnique({ where: { loja } })
  let ultNsu = cursor?.ultNsu ?? "0".padStart(15, "0")
  let novas = 0

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const resultado = await consultarNsuNaSefaz(loja, ultNsu)
    if (!resultado.ok) {
      return { ok: false, erro: resultado.erro, novas }
    }

    for (const doc of resultado.documentos) {
      // procEventoNFe/resEvento são manifestação, cancelamento, carta de
      // correção — não são a nota em si, e a lista é só de notas.
      if (!doc.schema.startsWith("resNFe") && !doc.schema.startsWith("procNFe")) continue
      if (await gravarNota(loja, doc.schema, doc.xml)) novas++
    }

    const semProgresso = resultado.ultNSU === ultNsu
    ultNsu = resultado.ultNSU
    await db.sincronizacaoSefaz.upsert({
      where: { loja },
      update: { ultNsu, maxNsu: resultado.maxNSU },
      create: { loja, ultNsu, maxNsu: resultado.maxNSU },
    })

    if (semProgresso || ultNsu === resultado.maxNSU) {
      return { ok: true, novas, paginas: pagina + 1, completo: true }
    }
  }

  return { ok: true, novas, paginas: maxPaginas, completo: false }
}

/**
 * Grava (ou atualiza) uma nota a partir do XML já baixado — usado tanto pela
 * sincronização por NSU quanto pela busca manual por chave, para as duas
 * alimentarem a mesma lista.
 *
 * Nunca sobrescreve `situacao`: é a decisão do gerente sobre a nota, e uma
 * ressincronização não pode apagar o que ele já resolveu.
 */
async function gravarNota(loja: string, schema: string, xml: string): Promise<boolean> {
  const completa = schema.startsWith("procNFe")
  const resumo = completa ? resumoDoProcNFe(xml) : resumoDoResNFe(xml)
  if (!resumo?.chaveAcesso) return false

  const decodificada = decodificarChave(resumo.chaveAcesso)
  const numero = "numero" in resumo && resumo.numero ? Number(resumo.numero) : decodificada?.numero ?? null
  const serie = "serie" in resumo && resumo.serie ? Number(resumo.serie) : decodificada?.serie ?? null

  const dados = {
    loja,
    emitenteCnpj: resumo.emitenteCnpj ?? decodificada?.cnpjEmitente ?? "",
    emitenteNome: resumo.emitenteNome ?? "",
    numero,
    serie,
    dataEmissao: resumo.dataEmissao ? new Date(resumo.dataEmissao) : null,
    valorTotal: resumo.valorTotal,
    situacaoXml: completa ? "completa" : "resumo",
    xml: completa ? xml : null,
  }

  await db.notaFiscalRecebida.upsert({
    where: { chaveAcesso: resumo.chaveAcesso },
    create: { chaveAcesso: resumo.chaveAcesso, nsu: "0", ...dados },
    update: dados,
  })
  return true
}

export function listarNotasDaLoja(loja: string) {
  return db.notaFiscalRecebida.findMany({
    where: { loja },
    orderBy: { dataEmissao: "desc" },
  })
}

export function situacaoSincronizacao(loja: string) {
  return db.sincronizacaoSefaz.findUnique({ where: { loja } })
}

export function notaPorId(id: string) {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return null
  return db.notaFiscalRecebida.findUnique({ where: { id } })
}

export type ResultadoBuscaChave = ResultadoConsultaChave

/** Busca manual por chave — para a nota que ainda não apareceu na sincronização. */
export async function buscarNotaPorChave(loja: string, chave: string): Promise<ResultadoBuscaChave> {
  const resultado = await consultarChaveNaSefaz(loja, chave)
  if (resultado.ok && resultado.documento) {
    await gravarNota(loja, resultado.documento.schema, resultado.documento.xml)
  }
  return resultado
}
