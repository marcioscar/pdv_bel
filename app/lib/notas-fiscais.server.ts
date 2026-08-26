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

  if (cursor?.proximaConsultaEm && cursor.proximaConsultaEm > new Date()) {
    const minutos = Math.ceil((cursor.proximaConsultaEm.getTime() - Date.now()) / 60_000)
    return {
      ok: false,
      novas: 0,
      erro:
        `Já está em dia com a SEFAZ. Ela bloqueia o CNPJ por uma hora quando se pergunta ` +
        `sem ter novidade — pode tentar de novo em ${minutos} min.`,
    }
  }

  let ultNsu = normalizarNsu(cursor?.ultNsu ?? "0")
  let novas = 0

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const resultado = await consultarNsuNaSefaz(loja, ultNsu)
    if (!resultado.ok) {
      // A recusa por consumo indevido vale para o CNPJ inteiro e dura uma
      // hora: registrar aqui evita que o próximo clique gaste outra tentativa
      // à toa e estenda o castigo.
      if (/consumo indevido|limite de consultas/i.test(resultado.erro)) {
        await guardarCursor(loja, ultNsu, ultNsu, esperaDeUmaHora())
      }
      return { ok: false, erro: resultado.erro, novas }
    }

    for (const doc of resultado.documentos) {
      // procEventoNFe/resEvento são manifestação, cancelamento, carta de
      // correção — não são a nota em si, e a lista é só de notas.
      if (!doc.schema.startsWith("resNFe") && !doc.schema.startsWith("procNFe")) continue
      if (await gravarNota(loja, doc.schema, doc.xml)) novas++
    }

    // Comparação numérica, e não de texto: a SEFAZ devolve o NSU com zeros à
    // esquerda ("000000000021930") e o cursor já foi gravado sem eles
    // ("21930"). Comparar como texto dava "diferente" para o mesmo número, o
    // laço nunca via que tinha chegado ao fim e repetia a mesma consulta até
    // a SEFAZ bloquear o CNPJ por consumo indevido.
    const anterior = ultNsu
    ultNsu = normalizarNsu(resultado.ultNSU)
    const maxNsu = normalizarNsu(resultado.maxNSU)

    const semProgresso = Number(ultNsu) <= Number(anterior)
    const emDia = Number(ultNsu) >= Number(maxNsu)

    // Sem novidade, a SEFAZ manda esperar uma hora antes de perguntar de novo.
    await guardarCursor(loja, ultNsu, maxNsu, semProgresso || emDia ? esperaDeUmaHora() : null)

    if (semProgresso || emDia) {
      return { ok: true, novas, paginas: pagina + 1, completo: true }
    }
  }

  return { ok: true, novas, paginas: maxPaginas, completo: false }
}

/** Os 15 dígitos com zeros à esquerda que a SEFAZ usa — um formato só, sempre. */
function normalizarNsu(valor: string) {
  return (valor.replace(/\D/g, "") || "0").padStart(15, "0").slice(-15)
}

function esperaDeUmaHora() {
  return new Date(Date.now() + 60 * 60_000)
}

function guardarCursor(loja: string, ultNsu: string, maxNsu: string, proximaConsultaEm: Date | null) {
  return db.sincronizacaoSefaz.upsert({
    where: { loja },
    update: { ultNsu, maxNsu, proximaConsultaEm },
    create: { loja, ultNsu, maxNsu, proximaConsultaEm },
  })
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
