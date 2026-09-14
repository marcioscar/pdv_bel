import type { Prisma } from "@prisma/client"

import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * O crédito do cliente: o que ele tem a favor depois de devolver mercadoria
 * sem levar o dinheiro.
 *
 * Existe porque a devolução do balcão nem sempre é em espécie. O cliente traz
 * o que não serviu, não quer o dinheiro de volta, e vai usar numa próxima
 * compra — é um acerto que o comércio faz há sempre, e que até agora ficava num
 * papel na gaveta ou na memória de quem atendeu.
 *
 * Saldo é a SOMA do livro, nunca um campo guardado. Ver `MovimentoCredito`.
 */

/** Entra (+) ou sai (−) do saldo, conforme o tipo. */
const SINAL: Record<string, number> = {
  devolucao: 1,
  estorno: 1,
  uso: -1,
}

export async function saldoDeCredito(clienteId: string | null | undefined): Promise<number> {
  if (!clienteId || !OBJECT_ID.test(clienteId)) return 0

  const movimentos = await db.movimentoCredito.findMany({
    where: { clienteId },
    select: { tipo: true, valor: true },
  })

  return arredondar(
    movimentos.reduce((soma, m) => soma + (SINAL[m.tipo] ?? 0) * m.valor, 0)
  )
}

/**
 * O saldo de vários clientes de uma vez — o caixa carrega a lista inteira e não
 * pode fazer uma ida ao banco por nome.
 */
export async function saldosDeCredito(clienteIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(clienteIds.filter((id) => OBJECT_ID.test(id)))]
  if (ids.length === 0) return new Map()

  const movimentos = await db.movimentoCredito.findMany({
    where: { clienteId: { in: ids } },
    select: { clienteId: true, tipo: true, valor: true },
  })

  const mapa = new Map<string, number>()
  for (const m of movimentos) {
    const atual = mapa.get(m.clienteId) ?? 0
    mapa.set(m.clienteId, atual + (SINAL[m.tipo] ?? 0) * m.valor)
  }
  // Arredonda no fim, uma vez por cliente: somar float a float e arredondar a
  // cada passo acumula o erro que o arredondamento deveria evitar.
  for (const [id, valor] of mapa) mapa.set(id, arredondar(valor))
  return mapa
}

/** O extrato, do mais recente para o mais antigo — a resposta a "por que R$ 37?". */
export function extratoDeCredito(clienteId: string, limite = 40) {
  if (!OBJECT_ID.test(clienteId)) return []
  return db.movimentoCredito.findMany({
    where: { clienteId },
    orderBy: { criadoEm: "desc" },
    take: limite,
  })
}

type Cliente = Prisma.TransactionClient

/**
 * Lança o consumo do crédito numa venda. Recebe o client da TRANSAÇÃO: o uso e
 * a venda caem juntos ou não caem, senão o saldo some sem venda que o explique.
 */
export function gastarCredito(
  tx: Cliente,
  entrada: {
    clienteId: string
    loja: string
    valor: number
    vendaId: string
    vendaNumero: number
    operador: string
  }
) {
  return tx.movimentoCredito.create({
    data: {
      clienteId: entrada.clienteId,
      loja: entrada.loja,
      tipo: "uso",
      valor: arredondar(entrada.valor),
      vendaId: entrada.vendaId,
      vendaNumero: entrada.vendaNumero,
      operador: entrada.operador,
      observacao: `Abatido na venda #${entrada.vendaNumero}`,
    },
  })
}

/**
 * Devolve ao cliente o crédito que uma venda cancelada tinha consumido.
 *
 * Um lançamento NOVO, de tipo "estorno", e não a exclusão do "uso": o livro
 * conta o que aconteceu, inclusive o que foi desfeito. Apagar o uso faria o
 * saldo voltar sem nada explicando por quê.
 *
 * Só estorna o que ainda não foi estornado — cancelar duas vezes a mesma venda
 * não pode creditar duas vezes.
 */
export async function estornarCreditoDaVenda(
  tx: Cliente,
  venda: {
    id: string
    numero: number
    loja: string
    clienteId: string | null
    creditoUsado: number
  },
  operador: string
) {
  if (!venda.clienteId || !(venda.creditoUsado > 0)) return null

  const jaEstornado = await tx.movimentoCredito.findFirst({
    where: { vendaId: venda.id, tipo: "estorno" },
  })
  if (jaEstornado) return null

  return tx.movimentoCredito.create({
    data: {
      clienteId: venda.clienteId,
      loja: venda.loja,
      tipo: "estorno",
      valor: arredondar(venda.creditoUsado),
      vendaId: venda.id,
      vendaNumero: venda.numero,
      operador,
      observacao: `Venda #${venda.numero} cancelada — o crédito abatido volta`,
    },
  })
}
