import type { Prisma } from "@prisma/client"

import { curvaAbc as abcDoSistemaAntigo } from "~/lib/abc.server"
import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"
import { NAO_CANCELADA, NAO_E_TRANSFERENCIA } from "~/lib/vendas.server"

/**
 * Os números do painel da administração — das vendas do PDV, com UMA exceção
 * declarada: a curva ABC (ver `curvaAbc`).
 *
 * Já leu o faturamento de `receitas`, o sistema de contas, porque o PDV tinha
 * acabado de entrar e as vendas dele não diziam nada da rede. Foi decisão do
 * Marcio (23/09/2026) que o painel mostre SÓ o que o PDV registrou, mesmo vazio
 * no começo: um painel com duas fontes misturadas não deixa saber qual número
 * é do caixa e qual é de outro sistema, e o do caixa é o que se confere.
 */

/** Venda que conta: da loja pedida, não cancelada, e não transferência da rede. */
function vendasValendo(lojas: string[], criadaEm: Prisma.DateTimeFilter): Prisma.VendaWhereInput {
  return { AND: [{ loja: { in: lojas }, criadaEm }, NAO_CANCELADA, NAO_E_TRANSFERENCIA] }
}

const DIA_MS = 86_400_000

/** "2026-09-21" no fuso local, que é como o negócio conta o dia. */
function diaLocal(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

export type PontoDiario = { dia: string; porLoja: Record<string, number>; total: number }

/** O faturamento dia a dia, por loja, no período pedido: a soma das vendas. */
export async function faturamentoDiario(dias: number, lojas: string[]) {
  const inicio = new Date(Date.now() - dias * DIA_MS)

  const vendas = await db.venda.findMany({
    where: vendasValendo(lojas, { gte: inicio }),
    select: { criadaEm: true, loja: true, total: true },
  })

  const porDia = new Map<string, Map<string, number>>()
  for (const v of vendas) {
    const dia = diaLocal(v.criadaEm)
    if (!porDia.has(dia)) porDia.set(dia, new Map())
    const m = porDia.get(dia)!
    m.set(v.loja, (m.get(v.loja) ?? 0) + v.total)
  }

  /*
   * Todos os dias do período, inclusive os sem lançamento. Sem isto a linha
   * "pula" o domingo e o eixo mente sobre o tempo — dois dias vizinhos no
   * desenho podem estar a uma semana um do outro.
   */
  const pontos: PontoDiario[] = []
  for (let i = dias - 1; i >= 0; i--) {
    const dia = diaLocal(new Date(Date.now() - i * DIA_MS))
    const m = porDia.get(dia) ?? new Map()
    const porLoja = Object.fromEntries(lojas.map((l) => [l, arredondar(m.get(l) ?? 0)]))
    pontos.push({
      dia,
      porLoja,
      total: arredondar(Object.values(porLoja).reduce((a, v) => a + v, 0)),
    })
  }
  return pontos
}

/**
 * A curva ABC do painel — POR ENQUANTO do histórico do sistema antigo.
 *
 * É a exceção à regra "só o PDV" do painel, pedida pelo Marcio em 23/09/2026:
 * com o PDV sem venda, a curva dele seria vazia, e a do antigo (235 dias) é a
 * que orienta compra hoje. A tela diz de onde ela vem. Quando o PDV tiver
 * volume, a troca é por uma curva das vendas daqui com as mesmas faixas.
 */
export async function curvaAbc(limite = 10) {
  const curva = await abcDoSistemaAntigo()
  if (!curva) return null
  return { ...curva, linhas: curva.linhas.slice(0, limite) }
}

/**
 * Quem vendeu e para quem, das vendas do PDV.
 *
 * Aqui o volume é pequeno de propósito — é o que o PDV registrou desde que
 * entrou no ar. A tela diz isso em vez de fingir que o ranking é da rede.
 */
export async function rankingsDoPdv(dias: number, lojas: string[]) {
  const inicio = new Date(Date.now() - dias * DIA_MS)

  const vendas = await db.venda.findMany({
    where: vendasValendo(lojas, { gte: inicio }),
    select: { vendedorId: true, vendedorNome: true, clienteId: true, clienteNome: true, total: true },
  })

  const soma = (chave: "vendedor" | "cliente") => {
    const mapa = new Map<string, { nome: string; total: number; vendas: number }>()
    for (const v of vendas) {
      const id = chave === "vendedor" ? v.vendedorId : v.clienteId
      const nome = chave === "vendedor" ? v.vendedorNome : v.clienteNome
      /*
       * Sem vendedor ou sem cliente fica de FORA do ranking, em vez de virar
       * uma linha "sem identificação" que ganharia de todo mundo: no balcão a
       * maioria das vendas é ao consumidor final sem cadastro, e essa linha
       * seria sempre a primeira, dizendo nada.
       */
      if (!id || !nome) continue
      const atual = mapa.get(id) ?? { nome, total: 0, vendas: 0 }
      atual.total += v.total
      atual.vendas += 1
      mapa.set(id, atual)
    }
    return [...mapa.values()]
      .map((l) => ({ ...l, total: arredondar(l.total) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  }

  return {
    vendedores: soma("vendedor"),
    clientes: soma("cliente"),
    vendasConsideradas: vendas.length,
    semVendedor: vendas.filter((v) => !v.vendedorId).length,
    semCliente: vendas.filter((v) => !v.clienteId).length,
  }
}

/** Os números grandes do topo: mês corrente contra o mês anterior. */
export async function resumoDoMes(lojas: string[]) {
  const agora = new Date()
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1)
  const inicioAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1)

  const [mes, anterior] = await Promise.all([
    db.venda.aggregate({
      where: vendasValendo(lojas, { gte: inicioMes }),
      _sum: { total: true },
      _count: { _all: true },
    }),
    db.venda.aggregate({
      where: vendasValendo(lojas, { gte: inicioAnterior, lt: inicioMes }),
      _sum: { total: true },
    }),
  ])

  const faturamento = arredondar(mes._sum.total ?? 0)
  const faturamentoAnterior = arredondar(anterior._sum.total ?? 0)
  const vendas = mes._count._all

  /*
   * O mês corrente está pela metade, então comparar o total dele com o total do
   * anterior sempre acusaria queda. O que se compara é o RITMO: quanto por dia
   * decorrido, contra quanto por dia o mês anterior fez inteiro.
   */
  const diaDoMes = agora.getDate()
  const diasNoAnterior = new Date(agora.getFullYear(), agora.getMonth(), 0).getDate()
  const porDia = faturamento / diaDoMes
  const porDiaAnterior = faturamentoAnterior / diasNoAnterior
  const variacao = porDiaAnterior > 0 ? ((porDia - porDiaAnterior) / porDiaAnterior) * 100 : null

  return {
    faturamento,
    faturamentoAnterior,
    porDia: arredondar(porDia),
    porDiaAnterior: arredondar(porDiaAnterior),
    variacao: variacao === null ? null : arredondar(variacao),
    diaDoMes,
    vendas,
    ticketMedio: vendas > 0 ? arredondar(faturamento / vendas) : 0,
  }
}
