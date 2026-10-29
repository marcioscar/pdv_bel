const formatadorMoeda = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
})

const formatadorNumero = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function moeda(valor: number) {
  return formatadorMoeda.format(valor)
}

export function decimal(valor: number) {
  return formatadorNumero.format(valor)
}

const formatadorQuantidade = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 3,
})

/** Quantidade sem casas decimais quando é inteira (2 em vez de 2,00); 3,5 e 1,375 como são. */
export function quantidade(valor: number) {
  return Number.isInteger(valor) ? String(valor) : formatadorQuantidade.format(valor)
}

/**
 * Quantidade de mercadoria é peça inteira: "2,4 pacotes" não descreve
 * prateleira nenhuma — e cada fração que entra no livro vira um saldo que
 * ninguém consegue contar no inventário.
 *
 * A exceção são os produtos marcados `vendeFracionado` no cadastro, que saem
 * com até três casas (3,5 / 1,375) na venda, na devolução, na transferência e
 * no inventário. Compra continua inteira para todos.
 *
 * Uma regra só, usada pela tela para avisar e pelo servidor para recusar.
 */
export const QUANTIDADE_INTEIRA = "Quantidade é em peças inteiras — sem casa decimal"
export const QUANTIDADE_FRACIONADA = "Quantidade com no máximo 3 casas decimais"

export function quantidadeInteira(valor: number) {
  return Number.isInteger(valor) && valor > 0
}

/** Três casas: o que o produto fracionado aceita, e o que o livro do estoque guarda. */
export function arredondarQuantidade(valor: number) {
  return Math.round(valor * 1000) / 1000
}

/** Se a quantidade serve para este produto: inteira, ou até três casas no fracionado. */
export function quantidadeAceita(valor: number, fracionado: boolean | null | undefined) {
  if (!fracionado) return quantidadeInteira(valor)
  return Number.isFinite(valor) && valor > 0 && Math.abs(valor - arredondarQuantidade(valor)) < 1e-9
}

/** A mensagem de recusa que cabe ao produto. */
export function avisoDeQuantidade(fracionado: boolean | null | undefined) {
  return fracionado ? QUANTIDADE_FRACIONADA : QUANTIDADE_INTEIRA
}

export function arredondar(valor: number) {
  return Math.round(valor * 100) / 100
}

/**
 * Aceita o que o operador digita no teclado numérico: "10", "10,5", "10.5".
 * O ponto só é separador de milhar quando há vírgula ("1.250,90").
 */
export function interpretarValor(entrada: string): number | null {
  const bruto = entrada.trim()
  if (!bruto) return null

  const normalizado = bruto.includes(",")
    ? bruto.replace(/\./g, "").replace(",", ".")
    : bruto

  const valor = Number(normalizado)
  if (!Number.isFinite(valor) || valor < 0) return null

  return arredondar(valor)
}

/**
 * Como `interpretarValor`, mas sem arredondar para centavo: "1,375" de um
 * produto fracionado viraria 1,38. Devolve o número como digitado, e quem
 * decide se ele serve é `quantidadeAceita` — "2,5" de um produto inteiro tem
 * que chegar lá como 2,5 para ser recusado, e não arredondado para passar.
 */
export function interpretarQuantidade(entrada: string): number | null {
  const bruto = entrada.trim()
  if (!bruto) return null

  const normalizado = bruto.includes(",")
    ? bruto.replace(/\./g, "").replace(",", ".")
    : bruto

  const valor = Number(normalizado)
  if (!Number.isFinite(valor) || valor < 0) return null

  return valor
}
