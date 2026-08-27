/**
 * Quando uma venda precisa do gerente, e o vocabulário disso.
 *
 * Módulo puro de propósito: as MESMAS regras decidem o aviso na tela do caixa, o
 * texto que o gerente lê e a guarda que recusa a gravação. Se a tela tivesse a
 * própria cópia do teto de desconto, o dia em que os dois divergissem ninguém
 * notaria — a tela continuaria avisando enquanto o servidor gravava.
 */

/**
 * O teto de desconto que o vendedor dá sozinho, em % do subtotal.
 *
 * Percentual e não valor: R$ 50 numa venda de R$ 200 é liberalidade, numa de
 * R$ 5.000 é arredondamento. É o percentual que mede a mordida na margem.
 */
export const DESCONTO_MAXIMO_PERCENTUAL = 5

/**
 * Dias de tolerância antes de um boleto vencido travar a próxima venda.
 *
 * Existe porque o retorno do banco não é instantâneo: o cliente que pagou ontem
 * no caixa da lotérica ainda aparece como "A_RECEBER" hoje de manhã, e travar a
 * venda dele seria acusar de caloteiro quem está em dia. Três dias cobrem o fim
 * de semana, que é onde a compensação demora.
 */
export const DIAS_DE_CARENCIA = 3

/**
 * Quanto tempo uma aprovação vale.
 *
 * Um turno. Aprovação sem prazo viraria um salvo-conduto: o vendedor guardaria a
 * autorização de terça para fechar a venda de sexta com o desconto que o gerente
 * concedeu uma vez, olhando outra situação.
 */
export const HORAS_DE_VALIDADE = 12

/**
 * A única forma de pagamento que estende crédito novo.
 *
 * É por isso que a inadimplência só trava a venda A PRAZO: quem paga em Pix,
 * dinheiro ou cartão está quitando na hora, e recusar essa venda não protege
 * nada — só perde o faturamento de um cliente que veio pagar. A dívida velha
 * continua sendo cobrada pelo boleto que já existe; o que não se faz é somar
 * dívida nova a quem já está atrasado.
 *
 * O aviso da dívida continua aparecendo em qualquer forma: o vendedor deve saber
 * que o cliente deve, para poder lembrá-lo. O que muda é o bloqueio, não a
 * informação.
 */
export function formaEstendeCredito(forma: string) {
  return forma === "prazo"
}

export const MOTIVOS_DE_AUTORIZACAO = [
  {
    id: "inadimplencia",
    rotulo: "Cliente com boleto vencido",
    /** O que o vendedor lê no balcão, com o cliente na frente. */
    aviso:
      "Este cliente tem boleto vencido — vender A PRAZO precisa da liberação do gerente. À vista (Pix, dinheiro ou cartão) fecha normal.",
  },
  {
    id: "desconto",
    rotulo: `Desconto acima de ${DESCONTO_MAXIMO_PERCENTUAL}%`,
    aviso: `Desconto acima de ${DESCONTO_MAXIMO_PERCENTUAL}% — a venda precisa da liberação do gerente.`,
  },
  {
    id: "link",
    rotulo: "Pagamento por link",
    aviso:
      "O gerente vai gerar o link e mandar ao cliente. A venda fica guardada e você fecha quando ele confirmar que o pagamento caiu.",
  },
] as const

/**
 * A forma que não se fecha no balcão.
 *
 * As outras liberações nascem de RISCO detectado (cliente devendo, desconto
 * alto); esta nasce de uma escolha do vendedor. Mesmo assim passa pelo mesmo
 * caminho: o carrinho fica parado esperando o gerente, e é a máquina que já
 * existe para isso.
 */
export function formaExigeLink(forma: string) {
  return forma === "link"
}

export type MotivoDeAutorizacao = (typeof MOTIVOS_DE_AUTORIZACAO)[number]["id"]

export function rotuloDoMotivo(motivo: string) {
  return MOTIVOS_DE_AUTORIZACAO.find((m) => m.id === motivo)?.rotulo ?? motivo
}

export function avisoDoMotivo(motivo: string) {
  return MOTIVOS_DE_AUTORIZACAO.find((m) => m.id === motivo)?.aviso ?? motivo
}

/** O desconto em % do subtotal. Subtotal zero não tem percentual: seria divisão
 *  por zero disfarçada de "100% de desconto". */
export function percentualDoDesconto(subtotal: number, desconto: number) {
  if (subtotal <= 0) return 0
  return (desconto / subtotal) * 100
}

/** O desconto máximo em reais que o vendedor dá sozinho, para este subtotal. */
export function tetoDeDesconto(subtotal: number) {
  return (subtotal * DESCONTO_MAXIMO_PERCENTUAL) / 100
}

/**
 * Um centavo de folga — em REAIS, e não em pontos percentuais.
 *
 * A folga existe só para o arredondamento: 5% de R$ 33,33 é R$ 1,6665, que o
 * caixa digita como R$ 1,67, e sem folga esse desconto de exatos 5% pediria
 * autorização de vez em quando. Um alarme que dispara sozinho é um alarme que as
 * pessoas aprendem a ignorar.
 *
 * Em pontos percentuais ela seria outra coisa: meio ponto de tolerância numa
 * venda de R$ 10.000 são R$ 50 saindo sem que ninguém precise autorizar, e a
 * folga passaria de conserto de arredondamento a brecha — que cresce junto com o
 * tamanho da venda, ou seja, justamente onde importa.
 */
const FOLGA_EM_REAIS = 0.01

export function descontoExigeAutorizacao(subtotal: number, desconto: number) {
  if (desconto <= 0) return false
  return desconto > tetoDeDesconto(subtotal) + FOLGA_EM_REAIS
}

export const SITUACOES_DE_AUTORIZACAO = {
  pendente: "Aguardando",
  aprovada: "Aprovada",
  negada: "Negada",
  usada: "Usada na venda",
  cancelada: "Cancelada",
} as const

export function rotuloDaSituacao(situacao: string) {
  return (
    SITUACOES_DE_AUTORIZACAO[situacao as keyof typeof SITUACOES_DE_AUTORIZACAO] ??
    situacao
  )
}

/** Aprovada e ainda dentro da validade — o que o caixa pode usar para fechar. */
export function aprovacaoValida(autorizacao: {
  situacao: string
  decididaEm: Date | string | null
}) {
  if (autorizacao.situacao !== "aprovada" || !autorizacao.decididaEm) return false
  const decidida = new Date(autorizacao.decididaEm).getTime()
  return Date.now() - decidida < HORAS_DE_VALIDADE * 60 * 60 * 1000
}
