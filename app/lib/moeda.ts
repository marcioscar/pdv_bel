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

/** Quantidade sem casas decimais quando é inteira (2 em vez de 2,00). */
export function quantidade(valor: number) {
  return Number.isInteger(valor) ? String(valor) : formatadorNumero.format(valor)
}

/**
 * Quantidade de mercadoria é sempre peça inteira: nenhum produto da rede se
 * vende, compra ou conta fracionado. "2,4 pacotes" não descreve prateleira
 * nenhuma — e cada fração que entra no livro vira um saldo que ninguém consegue
 * contar no inventário.
 *
 * Uma regra só, usada pela tela para avisar e pelo servidor para recusar.
 */
export const QUANTIDADE_INTEIRA = "Quantidade é em peças inteiras — sem casa decimal"

export function quantidadeInteira(valor: number) {
  return Number.isInteger(valor) && valor > 0
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
