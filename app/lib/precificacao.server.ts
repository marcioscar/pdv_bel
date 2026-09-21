import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"

/**
 * Quanto a operação custa, em percentual do que ela fatura.
 *
 * É o par que alimenta a sugestão de preço: fixos e variáveis medidos contra a
 * receita do mesmo período. Sai das coleções `receitas` e `despesas`, que são
 * do sistema de contas da rede — as mesmas que o brassacoAdm edita. Aqui só se
 * lê.
 */

/** Quantos meses FECHADOS entram na conta. */
const MESES = 3

/**
 * A janela: os três últimos meses inteiros, sem o corrente.
 *
 * Sem o corrente porque ele está pela metade — as despesas do mês entram ao
 * longo dele, e medir no dia 5 daria um percentual de custo perto de zero e um
 * preço sugerido barato demais, bem no momento em que ninguém desconfiaria.
 *
 * TRÊS, e não um, porque o número oscila de verdade: nos últimos meses o markup
 * desta rede foi de 1,40 a 1,72 conforme o mês que se olhasse. Um produto que
 * entra hoje não deveria custar mais caro por causa do mês em que a nota chegou.
 */
function janela(hoje = new Date()) {
  const fimExclusivo = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1))
  const inicio = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - MESES, 1))
  return { inicio, fimExclusivo }
}

export type PercentuaisDaOperacao = {
  pctFixas: number
  pctVariaveis: number
  /** Os totais crus, para a tela poder mostrar de onde o percentual saiu. */
  receitas: number
  fixas: number
  variaveis: number
  /** "2026-06" e "2026-08" — as pontas da janela, para dizer o período. */
  de: string
  ate: string
  /** Falso quando não há receita no período: sem ela não há percentual. */
  temDados: boolean
}

export async function percentuaisDaOperacao(
  hoje = new Date()
): Promise<PercentuaisDaOperacao> {
  const { inicio, fimExclusivo } = janela(hoje)
  const periodo = { gte: inicio, lt: fimExclusivo }

  const [receita, despesas] = await Promise.all([
    db.receita.aggregate({ where: { data: periodo }, _sum: { valor: true } }),
    /*
     * Só as PAGAS, como a rotina de origem: despesa lançada e não paga pode ser
     * previsão, duplicata em aberto, coisa que ainda vai mudar. E a janela de
     * três meses fechados já é velha o bastante para quase tudo ter sido pago.
     */
    db.despesa.findMany({
      where: { pago: true, data: periodo },
      select: { tipo: true, conta: true, valor: true },
    }),
  ])

  const receitas = arredondar(receita._sum.valor ?? 0)

  let fixas = 0
  let variaveis = 0
  for (const d of despesas) {
    /*
     * As DUAS grafias. O cadastro gravou "fixa" até fevereiro de 2026 e "fixo"
     * de março em diante, e as duas convivem no banco. Aceitar só uma faria a
     * conta ignorar 3.434 lançamentos sem avisar — e o sintoma seria um preço
     * sugerido barato, que é exatamente o erro que não se percebe olhando.
     */
    if (d.tipo === "fixo" || d.tipo === "fixa") {
      fixas += d.valor
      continue
    }
    /*
     * "Revenda" é a compra da mercadoria, e ela já está no CUSTO do produto que
     * se está precificando. Somá-la aqui cobraria a mercadoria duas vezes: uma
     * no custo, outra no percentual.
     */
    if (d.tipo === "variavel" && d.conta !== "Revenda") variaveis += d.valor
  }

  const mes = (d: Date) => d.toISOString().slice(0, 7)
  const ultimoMes = new Date(fimExclusivo)
  ultimoMes.setUTCMonth(ultimoMes.getUTCMonth() - 1)

  return {
    pctFixas: receitas > 0 ? arredondar((fixas / receitas) * 100) : 0,
    pctVariaveis: receitas > 0 ? arredondar((variaveis / receitas) * 100) : 0,
    receitas,
    fixas: arredondar(fixas),
    variaveis: arredondar(variaveis),
    de: mes(inicio),
    ate: mes(ultimoMes),
    temDados: receitas > 0,
  }
}
