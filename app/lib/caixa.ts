/**
 * O vocabulário do caixa, do lado que as duas pontas usam.
 */

export const TIPOS_DE_MOVIMENTO_DE_CAIXA = {
  abertura: {
    rotulo: "Abertura",
    ajuda: "Troco deixado na gaveta no começo do dia",
    /** Soma ao esperado: o dinheiro estava lá antes de qualquer venda. */
    sinal: 1,
  },
  suprimento: {
    rotulo: "Reforço",
    ajuda: "Dinheiro colocado na gaveta durante o dia",
    sinal: 1,
  },
  sangria: {
    rotulo: "Sangria",
    ajuda: "Dinheiro retirado da gaveta — banco, pagamento, cofre",
    sinal: -1,
  },
} as const

export type TipoMovimentoDeCaixa = keyof typeof TIPOS_DE_MOVIMENTO_DE_CAIXA

export function rotuloDoMovimento(tipo: string) {
  return TIPOS_DE_MOVIMENTO_DE_CAIXA[tipo as TipoMovimentoDeCaixa]?.rotulo ?? tipo
}

export function sinalDoMovimento(tipo: string) {
  return TIPOS_DE_MOVIMENTO_DE_CAIXA[tipo as TipoMovimentoDeCaixa]?.sinal ?? 0
}

export function tipoDeCaixaValido(valor: unknown): valor is TipoMovimentoDeCaixa {
  return typeof valor === "string" && valor in TIPOS_DE_MOVIMENTO_DE_CAIXA
}

/**
 * A partir de quanto uma diferença deixa de ser arredondamento e vira problema.
 *
 * Um real. Abaixo disso é moeda de troco que ficou no bolso de alguém e voltou
 * no dia seguinte; acima, é uma pergunta a fazer. O papel destaca a partir daqui
 * — sem um limite, ou tudo é alarme ou nada é.
 */
export const DIFERENCA_TOLERADA = 1

export function diferencaRelevante(diferenca: number) {
  return Math.abs(diferenca) >= DIFERENCA_TOLERADA
}
