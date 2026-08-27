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
 * O que sai da gaveta no fim do dia: tudo menos o fundo que fica para amanhã.
 *
 * A conferência continua sendo contra a gaveta INTEIRA — quem conta conta tudo,
 * e a diferença é medida contra o esperado completo. Este número é outro
 * assunto: depois de bater, quanto se leva para o cofre e quanto se deixa para
 * abrir amanhã. Misturar os dois faria a falta de R$ 5 sumir dentro de um
 * "líquido" que ninguém confere.
 *
 * Fica aqui, e não na tela, porque o papel do fechamento mostra o mesmo número —
 * e duas subtrações escritas à mão em lugares diferentes divergem na primeira
 * vez que alguém mudar o critério.
 */
export function retiradaDaGaveta(dinheiroNaGaveta: number, fundo: number) {
  return Math.round((dinheiroNaGaveta - fundo) * 100) / 100
}

/**
 * Sangria acima disto exige a senha de um gerente na hora.
 *
 * Sem um teto, qualquer operador registrava a saída de qualquer quantia — e o
 * fechamento do dia BATIA, porque o esperado caía junto com o dinheiro que
 * saiu. A conferência não pega esse caso; o que pega é uma segunda pessoa.
 *
 * O valor é generoso de propósito para as retiradas de rotina passarem direto:
 * um teto que dispara todo dia vira senha digitada no automático, que é o mesmo
 * que não ter teto.
 */
export const SANGRIA_SEM_AUTORIZACAO = 500

export function sangriaExigeGerente(tipo: string, valor: number) {
  return tipo === "sangria" && valor > SANGRIA_SEM_AUTORIZACAO
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
