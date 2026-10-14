import type { Prisma } from "@prisma/client"

import { db } from "~/lib/db.server"
import { diaAdiante, diaDeHoje, inicioDoDia, meioDiaDe, PRIMEIRO_DIA } from "~/lib/dia"
import { arredondar } from "~/lib/moeda"
import { SITUACOES_A_PAGAR, type FiltroAPagar, type SituacaoAPagar } from "~/lib/contas-a-pagar"

/**
 * As contas a pagar: os títulos que as notas de entrada e as AFs geraram.
 *
 * Moram em `despesas`, coleção que o PDV divide com o brassacoAdm. Lá, despesa
 * é o que JÁ foi pago (`pago: true`, ou sem o campo, que é o lançamento manual
 * de lá); os títulos gerados aqui nascem `pago: false` e ficam fora do
 * resultado do mês até alguém dizer que pagou. Esta tela é quem diz — e ao
 * marcar, a despesa passa a contar lá também, sem nada a fazer no outro lado.
 *
 * Só entra aqui o que tem `pago` gravado (falso ou verdadeiro): o lançamento
 * manual do brassacoAdm, sem o campo, é despesa já paga e não título a pagar.
 */

const DIA = /^\d{4}-\d{2}-\d{2}$/


/** O teto da lista: além disso, o filtro é largo demais para ser lido linha a linha. */
const LIMITE = 500

export function lerFiltroAPagar(url: URL, lojasPermitidas: string[]): FiltroAPagar {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const temDe = DIA.test(texto("de"))
  const temAte = DIA.test(texto("ate"))
  // Por padrão, tudo o que já venceu e o que vence nos próximos 30 dias.
  const de = temDe ? texto("de") : PRIMEIRO_DIA
  const ateBruto = temAte ? texto("ate") : diaAdiante(30)
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const situacao = texto("situacao")
  return {
    de: inicio,
    ate: fim,
    loja: lojasPermitidas.includes(texto("loja")) ? texto("loja") : "todas",
    fornecedor: texto("fornecedor").slice(0, 60),
    situacao: SITUACOES_A_PAGAR.some((s) => s.id === situacao)
      ? (situacao as SituacaoAPagar)
      : "abertas",
  }
}

export async function consultarContasAPagar(filtro: FiltroAPagar) {
  const hoje = inicioDoDia(diaDeHoje())
  const fimDoPeriodo = new Date(inicioDoDia(filtro.ate).getTime() + 86_400_000)

  // O recorte de período, loja e fornecedor; a situação entra por cima.
  // `pago` gravado, verdadeiro ou falso: o documento sem o campo é o
  // lançamento manual do brassacoAdm, despesa já paga e não título a pagar.
  const base: Prisma.DespesaWhereInput = {
    OR: [{ pago: true }, { pago: false }],
    data: { gte: inicioDoDia(filtro.de), lt: fimDoPeriodo },
    ...(filtro.loja !== "todas" ? { loja: filtro.loja } : {}),
    ...(filtro.fornecedor
      ? { fornecedor: { contains: filtro.fornecedor, mode: "insensitive" } }
      : {}),
  }

  const daSituacao: Record<SituacaoAPagar, Prisma.DespesaWhereInput> = {
    abertas: { pago: false },
    vencidas: { pago: false, data: { lt: hoje } },
    pagas: { pago: true },
    todas: {},
  }
  const where: Prisma.DespesaWhereInput = { AND: [base, daSituacao[filtro.situacao]] }

  const soma = async (extra: Prisma.DespesaWhereInput) => {
    const r = await db.despesa.aggregate({
      where: { AND: [base, extra] },
      _sum: { valor: true },
      _count: { _all: true },
    })
    return { valor: arredondar(r._sum.valor ?? 0), quantidade: r._count._all }
  }

  /*
   * Os cartões ignoram o seletor de situação, como no Contas a receber: são a
   * repartição do período, e obedecê-lo deixaria dois deles sempre em zero.
   */
  const [contas, total, aberto, vencido, pago] = await Promise.all([
    db.despesa.findMany({ where, orderBy: { data: "asc" }, take: LIMITE }),
    db.despesa.count({ where }),
    soma({ pago: false }),
    soma({ pago: false, data: { lt: hoje } }),
    soma({ pago: true }),
  ])

  return {
    contas: contas.map((c) => ({
      id: c.id,
      vencimento: c.data.toISOString(),
      fornecedor: c.fornecedor,
      descricao: c.descricao,
      conta: c.conta,
      loja: c.loja,
      valor: c.valor,
      pago: c.pago,
      pagoEm: c.pagoEm?.toISOString() ?? null,
      pagoPor: c.pagoPor,
      // Só o que foi pago AQUI se desfaz aqui: o resto é registro do outro sistema.
      desfazivel: c.pago && Boolean(c.pagoPor),
    })),
    total,
    limite: LIMITE,
    resumo: { aberto, vencido, pago },
  }
}

export type ContaAPagar = Awaited<ReturnType<typeof consultarContasAPagar>>["contas"][number]

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * Marca como paga. Só a partir de "a pagar": marcar de novo uma já paga
 * reescreveria quem pagou e quando — a gravação é condicionada a isso.
 */
export async function marcarPaga(id: string, dia: string, gerente: string) {
  if (!OBJECT_ID.test(id)) return { ok: false as const, erro: "Conta inválida" }
  const pagoEm = meioDiaDe(dia)
  if (!pagoEm) return { ok: false as const, erro: "Data de pagamento inválida" }
  if (pagoEm.getTime() > inicioDoDia(diaAdiante(1)).getTime()) {
    return { ok: false as const, erro: "A data de pagamento não pode ser no futuro" }
  }

  const { count } = await db.despesa.updateMany({
    where: { id, pago: false },
    data: { pago: true, pagoEm, pagoPor: gerente },
  })
  return count === 1
    ? { ok: true as const, mensagem: "Conta marcada como paga" }
    : { ok: false as const, erro: "Esta conta já estava paga" }
}

/** Desfaz um pagamento marcado aqui por engano — volta para "a pagar". */
export async function desfazerPagamento(id: string) {
  if (!OBJECT_ID.test(id)) return { ok: false as const, erro: "Conta inválida" }
  const { count } = await db.despesa.updateMany({
    where: { id, pago: true, pagoPor: { not: null } },
    data: { pago: false, pagoEm: null, pagoPor: null },
  })
  return count === 1
    ? { ok: true as const, mensagem: "Pagamento desfeito — a conta voltou para a pagar" }
    : { ok: false as const, erro: "Só se desfaz o pagamento marcado no Contas a pagar" }
}
