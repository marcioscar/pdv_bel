import { db } from "~/lib/db.server"
import { emDia } from "~/lib/dia"
import { arredondar } from "~/lib/moeda"
import { NAO_CANCELADA, NAO_E_TRANSFERENCIA } from "~/lib/vendas.server"

/**
 * O que um gerente precisa olhar para achar desvio no caixa.
 *
 * Cada quadro responde a um jeito de tirar dinheiro que o sistema, sozinho, não
 * consegue impedir — só tornar visível:
 *
 * - **Cartão por dia**: a venda em dinheiro registrada como débito ou crédito
 *   some da conta da gaveta. O sistema não fala com a maquininha; quem pega é
 *   comparar este número com o extrato dela, loja a loja, dia a dia.
 * - **Desconto por operador**: até o teto o desconto não pede gerente. Cliente
 *   que paga o preço cheio em dinheiro sobre uma venda lançada com desconto
 *   deixa a diferença na gaveta — e a gaveta fecha batendo. O que denuncia é o
 *   padrão: um operador que dá desconto muito mais que os outros, sobretudo em
 *   dinheiro.
 * - **Sangria por operador**: a conferência do fim do dia não pega retirada,
 *   porque o esperado cai junto com o dinheiro.
 * - **Lançamentos cancelados**: cancelar abertura ou reforço baixa o esperado.
 */
export async function auditoriaDoCaixa(
  lojas: string[],
  inicio: Date,
  fim: Date,
  diaInicio: string,
  diaFim: string
) {
  const [vendas, movimentos] = await Promise.all([
    db.venda.findMany({
      where: {
        AND: [{ loja: { in: lojas }, criadaEm: { gte: inicio, lt: fim } }, NAO_CANCELADA, NAO_E_TRANSFERENCIA],
      },
      select: {
        loja: true,
        criadaEm: true,
        forma: true,
        subtotal: true,
        desconto: true,
        total: true,
        operador: true,
      },
    }),
    db.movimentoCaixa.findMany({
      where: { loja: { in: lojas }, dia: { gte: diaInicio, lte: diaFim } },
      orderBy: { criadoEm: "asc" },
    }),
  ])

  // ---- Formas por loja e dia ----
  const porDia = new Map<
    string,
    { loja: string; dia: string; debito: number; credito: number; pix: number; dinheiro: number; vendas: number }
  >()
  for (const v of vendas) {
    const dia = emDia(v.criadaEm)
    const chave = `${v.loja}|${dia}`
    const linha =
      porDia.get(chave) ??
      { loja: v.loja, dia, debito: 0, credito: 0, pix: 0, dinheiro: 0, vendas: 0 }
    if (v.forma === "debito") linha.debito += v.total
    if (v.forma === "credito") linha.credito += v.total
    if (v.forma === "pix") linha.pix += v.total
    if (v.forma === "dinheiro") linha.dinheiro += v.total
    linha.vendas++
    porDia.set(chave, linha)
  }
  const formasPorDia = [...porDia.values()]
    .map((l) => ({
      ...l,
      debito: arredondar(l.debito),
      credito: arredondar(l.credito),
      pix: arredondar(l.pix),
      dinheiro: arredondar(l.dinheiro),
    }))
    .sort((a, b) => (a.dia === b.dia ? a.loja.localeCompare(b.loja) : b.dia.localeCompare(a.dia)))

  // ---- Desconto por operador ----
  const porOperador = new Map<
    string,
    {
      operador: string
      vendas: number
      comDesconto: number
      subtotal: number
      desconto: number
      descontoEmDinheiro: number
      vendasEmDinheiroComDesconto: number
    }
  >()
  for (const v of vendas) {
    const linha =
      porOperador.get(v.operador) ??
      {
        operador: v.operador,
        vendas: 0,
        comDesconto: 0,
        subtotal: 0,
        desconto: 0,
        descontoEmDinheiro: 0,
        vendasEmDinheiroComDesconto: 0,
      }
    linha.vendas++
    linha.subtotal += v.subtotal
    if (v.desconto > 0) {
      linha.comDesconto++
      linha.desconto += v.desconto
      if (v.forma === "dinheiro") {
        linha.descontoEmDinheiro += v.desconto
        linha.vendasEmDinheiroComDesconto++
      }
    }
    porOperador.set(v.operador, linha)
  }
  const descontos = [...porOperador.values()]
    .map((l) => ({
      ...l,
      subtotal: arredondar(l.subtotal),
      desconto: arredondar(l.desconto),
      descontoEmDinheiro: arredondar(l.descontoEmDinheiro),
      // Sobre o que foi vendido: 1% de desconto em R$ 100 mil pesa mais que 5% em R$ 1 mil.
      percentual: l.subtotal > 0 ? arredondar((l.desconto / l.subtotal) * 100) : 0,
      fracaoComDesconto: l.vendas > 0 ? l.comDesconto / l.vendas : 0,
    }))
    .sort((a, b) => b.desconto - a.desconto)

  // ---- Sangria por operador ----
  const valendo = movimentos.filter((m) => !m.canceladoEm)
  const porQuemRetirou = new Map<
    string,
    { operador: string; sangrias: number; total: number; semGerente: number; comGerente: number }
  >()
  for (const m of valendo.filter((m) => m.tipo === "sangria")) {
    const linha =
      porQuemRetirou.get(m.operador) ??
      { operador: m.operador, sangrias: 0, total: 0, semGerente: 0, comGerente: 0 }
    linha.sangrias++
    linha.total += m.valor
    if (m.autorizadaPor) linha.comGerente += m.valor
    else linha.semGerente += m.valor
    porQuemRetirou.set(m.operador, linha)
  }
  const sangrias = [...porQuemRetirou.values()]
    .map((l) => ({
      ...l,
      total: arredondar(l.total),
      semGerente: arredondar(l.semGerente),
      comGerente: arredondar(l.comGerente),
    }))
    .sort((a, b) => b.total - a.total)

  // ---- Lançamentos cancelados ----
  const cancelados = movimentos
    .filter((m) => m.canceladoEm)
    .map((m) => ({
      id: m.id,
      loja: m.loja,
      dia: m.dia,
      tipo: m.tipo,
      valor: m.valor,
      lancadoPor: m.operador,
      canceladoPor: m.canceladoPor ?? "—",
      canceladoEm: m.canceladoEm!,
    }))
    .sort((a, b) => b.canceladoEm.getTime() - a.canceladoEm.getTime())

  const totalCartao = arredondar(formasPorDia.reduce((s, l) => s + l.debito + l.credito, 0))
  const totalDesconto = arredondar(descontos.reduce((s, l) => s + l.desconto, 0))
  const totalSangria = arredondar(sangrias.reduce((s, l) => s + l.total, 0))

  return {
    formasPorDia,
    descontos,
    sangrias,
    cancelados,
    totais: {
      cartao: totalCartao,
      desconto: totalDesconto,
      sangria: totalSangria,
      cancelados: cancelados.length,
    },
  }
}
