import type { Prisma } from "@prisma/client"

import { db } from "~/lib/db.server"
import { PRIMEIRO_DIA, ULTIMO_DIA, depoisDoDia, inicioDoDia } from "~/lib/dia"
import {
  SITUACOES_NOTA,
  type FiltroNotas,
  type SituacaoNota,
} from "~/lib/notas-fiscais"
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
  // Chave que não tem 44 dígitos é chave corrompida, não chave estranha: já
  // aconteceu (o parser convertia para número e estourava a precisão) e o
  // estrago foi gravar 49 duplicatas inúteis, porque a chave é a identidade
  // do documento. Melhor recusar do que guardar lixo com aparência de nota.
  if (!resumo?.chaveAcesso || !/^\d{44}$/.test(resumo.chaveAcesso)) return false

  const decodificada = decodificarChave(resumo.chaveAcesso)
  const numero = "numero" in resumo && resumo.numero ? Number(resumo.numero) : decodificada?.numero ?? null
  const serie = "serie" in resumo && resumo.serie ? Number(resumo.serie) : decodificada?.serie ?? null

  const dados = {
    loja,
    // 14 dígitos sempre: CNPJ que começa com zero perdia o zero e virava um
    // segundo "fornecedor" na lista, que nunca casava com o cadastro.
    emitenteCnpj: normalizarCnpj(resumo.emitenteCnpj ?? decodificada?.cnpjEmitente ?? ""),
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

/** CNPJ com 14 dígitos, zeros à esquerda inclusive — o formato do cadastro. */
function normalizarCnpj(valor: string) {
  const digitos = (valor ?? "").replace(/\D/g, "")
  return digitos ? digitos.padStart(14, "0") : ""
}

export function listarNotasDaLoja(loja: string) {
  return db.notaFiscalRecebida.findMany({
    where: { loja },
    orderBy: { dataEmissao: "desc" },
  })
}

export const NOTAS_POR_PAGINA = 40

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * Lê o filtro da URL, no mesmo padrão de `lerFiltroPedidos`.
 *
 * O padrão é "tudo": nota de fornecedor chega às dezenas por mês, e um
 * período curto por padrão esconderia a nota do mês passado que é justamente
 * a que se está procurando.
 */
export function lerFiltroNotas(url: URL): FiltroNotas {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const temDe = DIA.test(texto("de"))
  const temAte = DIA.test(texto("ate"))
  const de = temDe ? texto("de") : temAte ? texto("ate") : PRIMEIRO_DIA
  const ateBruto = temAte ? texto("ate") : temDe ? texto("de") : ULTIMO_DIA
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const situacao = texto("situacao")

  return {
    loja: texto("loja").slice(0, 10),
    de: inicio,
    ate: fim,
    fornecedor: texto("fornecedor").slice(0, 60),
    numero: texto("numero").replace(/\D/g, "").slice(0, 9),
    situacao: SITUACOES_NOTA.some((s) => s.id === situacao) ? (situacao as SituacaoNota) : "todas",
    pagina: Math.max(1, Math.trunc(Number(params.get("pagina"))) || 1),
  }
}

/**
 * As notas que casam com o filtro, uma página de cada vez.
 *
 * O resumo ignora de propósito o seletor de situação — como em contas a
 * receber e em pedidos, os cartões SÃO a repartição por situação daquele
 * período e daquele fornecedor. Obedecer ao seletor faria os outros serem
 * sempre zero.
 */
export async function consultarNotas(filtro: FiltroNotas) {
  const periodo: Prisma.NotaFiscalRecebidaWhereInput = {
    dataEmissao: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) },
  }
  const conteudo: Prisma.NotaFiscalRecebidaWhereInput[] = [{ loja: filtro.loja }]

  if (filtro.numero) conteudo.push({ numero: Number(filtro.numero) })
  if (filtro.fornecedor) {
    // Um campo só para nome e CNPJ: quem procura tem um ou outro na mão, e
    // dois campos separados obrigariam a saber de antemão qual deles serve.
    const digitos = filtro.fornecedor.replace(/\D/g, "")
    conteudo.push({
      OR: [
        { emitenteNome: { contains: filtro.fornecedor, mode: "insensitive" } },
        ...(digitos.length >= 3 ? [{ emitenteCnpj: { contains: digitos } }] : []),
      ],
    })
  }

  const base: Prisma.NotaFiscalRecebidaWhereInput = { AND: [periodo, ...conteudo] }
  const where: Prisma.NotaFiscalRecebidaWhereInput =
    filtro.situacao === "todas" ? base : { AND: [periodo, ...conteudo, { situacao: filtro.situacao }] }

  const [pagina, total, agregado, disponiveis, recebidas] = await Promise.all([
    db.notaFiscalRecebida.findMany({
      where,
      orderBy: { dataEmissao: "desc" },
      skip: (filtro.pagina - 1) * NOTAS_POR_PAGINA,
      take: NOTAS_POR_PAGINA,
    }),
    db.notaFiscalRecebida.count({ where }),
    db.notaFiscalRecebida.aggregate({ where, _sum: { valorTotal: true } }),
    db.notaFiscalRecebida.aggregate({
      where: { AND: [base, { situacao: "disponivel" }] },
      _sum: { valorTotal: true },
      _count: { _all: true },
    }),
    db.notaFiscalRecebida.aggregate({
      where: { AND: [base, { situacao: "recebida" }] },
      _sum: { valorTotal: true },
      _count: { _all: true },
    }),
  ])

  // Quando a busca não acha nada no período, dizer isso é melhor que uma tela
  // vazia que parece defeito — a mesma escolha já feita nas outras consultas.
  const foraDoPeriodo =
    total === 0 && (filtro.numero || filtro.fornecedor)
      ? await db.notaFiscalRecebida.count({ where: { AND: conteudo } })
      : 0

  return {
    notas: pagina,
    total,
    foraDoPeriodo,
    paginas: Math.max(1, Math.ceil(total / NOTAS_POR_PAGINA)),
    resumo: {
      valor: agregado._sum.valorTotal ?? 0,
      disponivel: disponiveis._sum.valorTotal ?? 0,
      disponivelQuantidade: disponiveis._count._all,
      recebida: recebidas._sum.valorTotal ?? 0,
      recebidaQuantidade: recebidas._count._all,
    },
  }
}

export type NotaDaConsulta = Awaited<ReturnType<typeof consultarNotas>>["notas"][number]

/** Os fornecedores que já mandaram nota para esta loja, para o seletor da tela. */
export async function fornecedoresComNota(loja: string) {
  const notas = await db.notaFiscalRecebida.findMany({
    where: { loja },
    select: { emitenteCnpj: true, emitenteNome: true },
  })

  const porCnpj = new Map<string, { cnpj: string; nome: string; notas: number }>()
  for (const n of notas) {
    const atual = porCnpj.get(n.emitenteCnpj)
    if (atual) atual.notas++
    else porCnpj.set(n.emitenteCnpj, { cnpj: n.emitenteCnpj, nome: n.emitenteNome, notas: 1 })
  }

  return [...porCnpj.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
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
