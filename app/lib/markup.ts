/**
 * O preço de venda por markup sobre o custo: preço = custo × (1 + markup).
 *
 * Uma conta só para a nota de entrada e a AF — as duas telas propõem e ajustam
 * o preço do produto ao dar entrada, e duas contas acabariam divergindo no
 * arredondamento sem ninguém perceber. Os textos saem com vírgula, como se
 * digita.
 */

export const centavos = (valor: number) => Math.round(valor * 100) / 100
export const textoDePreco = (valor: number) => valor.toFixed(2).replace(".", ",")
export const textoDeMarkup = (valor: number) => valor.toFixed(1).replace(".", ",")

export function precoPorMarkup(custo: number, markup: number) {
  return centavos(custo * (1 + markup / 100))
}

export function markupPorPreco(custo: number, preco: number) {
  return (preco / custo - 1) * 100
}

/**
 * O ponto de partida: MANTER o markup que o produto tinha.
 *
 * O preço de hoje foi feito sobre o custo anterior; esse markup aplicado ao
 * custo novo dá o preço que conserva a margem — se o custo subiu 10%, o preço
 * sobe 10%. Sem custo anterior, parte do preço de hoje sobre o custo novo (nada
 * muda até alguém mexer). Sem preço ou sem custo, começa vazio.
 *
 * Nunca propõe abaixo do preço de hoje. Custo anterior errado (cadastro
 * antigo, produto "usado" com custo simbólico) fazia o markup herdado puxar o
 * preço para baixo — e a caixa de atualizar vem marcada, então um clique
 * distraído baixava o preço no catálogo. Baixar preço fica para quem digita.
 */
export function propostaDeMarkup(entrada: {
  custo: number
  precoHoje: number | null | undefined
  custoAnterior: number | null | undefined
}): { markup: string; preco: string } {
  const { custo, precoHoje, custoAnterior } = entrada
  if (!(custo > 0) || !(precoHoje && precoHoje > 0)) return { markup: "", preco: "" }
  const base = custoAnterior && custoAnterior > 0 ? custoAnterior : custo
  const mantendoMargem = precoPorMarkup(custo, markupPorPreco(base, precoHoje))
  const preco = Math.max(mantendoMargem, centavos(precoHoje))
  return { markup: textoDeMarkup(markupPorPreco(custo, preco)), preco: textoDePreco(preco) }
}
