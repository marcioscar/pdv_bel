/**
 * O preço de venda a partir do custo, pelo método do divisor.
 *
 * A fórmula é a mesma que a rede já usa na calculadora do brassacoAdm, e está
 * copiada aqui de propósito em vez de importada: são dois aplicativos
 * separados, e uma cópia que diverge é menos ruim que um acoplamento entre
 * projetos que ninguém lembra que existe. O que os dois compartilham de
 * verdade é o BANCO — as receitas e despesas de onde saem os percentuais.
 *
 * O raciocínio: os custos fixos, os variáveis e o lucro são percentuais do
 * PREÇO, não do custo. Então não se soma nada ao custo — divide-se por quanto
 * sobra dele. Um produto de R$ 10 com 30% de custos e 10% de lucro sai por
 * 10 / 0,60 = R$ 16,67, e não por R$ 14,00 como daria somar 40% ao custo.
 */

export type PrecoCalculado = {
  precoSugerido: number
  /** Onde a operação empata: cobre os custos e não sobra lucro. */
  precoMinimo: number | null
  markup: number
}

export function calcularPrecoVenda(params: {
  custo: number
  pctFixos: number
  pctVariaveis: number
  pctLucro: number
}): PrecoCalculado | null {
  const { custo, pctFixos, pctVariaveis, pctLucro } = params
  const totalPct = pctFixos + pctVariaveis + pctLucro

  /*
   * Em 100% o divisor é zero e o preço vai a infinito — acima disso ele fica
   * NEGATIVO, que é o jeito mais discreto de uma conta dar errado: o número
   * sai, parece um preço, e está do outro lado do zero. Recusar é a resposta
   * honesta, e quem chama mostra que não dá.
   */
  if (totalPct >= 100 || custo <= 0) return null

  const divisor = 1 - totalPct / 100
  const divisorMinimo = 1 - (pctFixos + pctVariaveis) / 100

  return {
    precoSugerido: custo / divisor,
    precoMinimo: divisorMinimo > 0 ? custo / divisorMinimo : null,
    markup: 1 / divisor,
  }
}

export type ConferenciaDePreco = {
  /** (preço − custo) / preço. O que sobra antes dos custos da operação. */
  margemBruta: number
  /** O que sobra DEPOIS de fixos e variáveis — o lucro de verdade da linha. */
  sobraReal: number
  status: "lucrativo" | "empate" | "prejuizo"
}

/**
 * O que o preço que já está no catálogo entrega, dadas as mesmas contas.
 *
 * Existe para a sugestão não aparecer sozinha: "sugerido R$ 16,67" diz pouco;
 * "hoje está R$ 12,00, e nesse preço a linha dá prejuízo" diz o que fazer.
 */
export function conferirPrecoVenda(params: {
  custo: number
  preco: number
  pctFixos: number
  pctVariaveis: number
}): ConferenciaDePreco | null {
  const { custo, preco, pctFixos, pctVariaveis } = params
  if (preco <= 0 || custo < 0) return null

  const margemBruta = ((preco - custo) / preco) * 100
  const sobraReal =
    preco - custo - (preco * pctVariaveis) / 100 - (preco * pctFixos) / 100

  // A tolerância de meio centavo evita chamar de prejuízo o arredondamento.
  const status =
    sobraReal > 0.005 ? "lucrativo" : sobraReal < -0.005 ? "prejuizo" : "empate"

  return { margemBruta, sobraReal, status }
}

/** O padrão da tela. Não é regra da empresa — é de onde a conversa começa. */
export const LUCRO_PADRAO = 10
