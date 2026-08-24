/**
 * A política de compra da rede, em números que se pode discutir.
 *
 * Tudo aqui é derivado de duas perguntas de negócio — quanto tempo o fornecedor
 * demora e para quantos dias se compra — e de uma medida: quanto sai por dia.
 * Os parâmetros ficam nomeados e num lugar só porque são a coisa que muda: se o
 * fornecedor melhorar o prazo, é UM número que muda, e o catálogo inteiro se
 * ajusta no próximo recálculo.
 */

/** Dias entre pedir ao fornecedor e a mercadoria estar na prateleira. */
export const DIAS_DE_ENTREGA = 15

/** Para quantos dias de venda cada compra é feita. */
export const DIAS_DE_COBERTURA = 30

/**
 * A folga sobre o prazo de entrega.
 *
 * Existe para duas coisas que acontecem juntas com frequência: o fornecedor
 * atrasar e a venda vir acima da média. Uma semana é o que separa "acabou o
 * estoque" de "quase acabou" — e o custo dela é uma semana de mercadoria parada,
 * que numa distribuidora de embalagem é barato perto de perder a venda.
 */
export const DIAS_DE_SEGURANCA = 7

export type Consumo = {
  /** Total vendido no período, já sem transferências entre lojas. */
  vendido: number
  /** Dias corridos do período analisado. */
  dias: number
  /** Em quantos dias distintos houve venda — mede a regularidade. */
  diasComVenda: number
}

export type Politica = {
  consumoMedioDiario: number
  estoqueMinimo: number
  pontoDePedido: number
  loteDeCompra: number
}

/** Arredonda para cima em unidades inteiras: não se compra meio saco. */
function unidades(valor: number) {
  return Math.ceil(Math.max(0, valor))
}

/**
 * Os quatro números, a partir do consumo medido.
 *
 *     consumo diário = vendido ÷ dias do período
 *     estoque mínimo = consumo × dias de segurança
 *     ponto de pedido = consumo × (entrega + segurança)
 *     lote de compra  = consumo × (cobertura + entrega + segurança)
 *
 * O ponto de pedido é o número que decide: quando o saldo cai abaixo dele, o que
 * resta cobre exatamente o tempo até a mercadoria nova chegar, mais a folga. O
 * lote é maior porque precisa cobrir também o período seguinte inteiro.
 */
export function calcularPolitica(consumo: Consumo): Politica {
  const consumoMedioDiario = consumo.dias > 0 ? consumo.vendido / consumo.dias : 0

  return {
    consumoMedioDiario,
    estoqueMinimo: unidades(consumoMedioDiario * DIAS_DE_SEGURANCA),
    pontoDePedido: unidades(consumoMedioDiario * (DIAS_DE_ENTREGA + DIAS_DE_SEGURANCA)),
    loteDeCompra: unidades(
      consumoMedioDiario * (DIAS_DE_COBERTURA + DIAS_DE_ENTREGA + DIAS_DE_SEGURANCA)
    ),
  }
}

/**
 * Quanto comprar agora, descontando o que já existe e o que está a caminho.
 *
 * Mercadoria em trânsito conta como estoque: ela já foi paga e vai chegar. Sem
 * descontá-la, uma transferência em andamento viraria uma compra em duplicidade.
 */
export function quantoComprar(
  politica: Pick<Politica, "loteDeCompra">,
  estoqueAtual: number,
  emTransito = 0
) {
  return unidades(politica.loteDeCompra - estoqueAtual - emTransito)
}

/**
 * Em quantos dias o estoque atual acaba, no ritmo medido.
 *
 * Saldo negativo devolve zero, e não um número negativo. Negativo é erro de
 * inventário, não uma medida de tempo: dividido por um consumo quase nulo ele
 * produz "−235 dias", e a lista ordenada por urgência põe no topo um produto
 * parado com saldo −1 na frente de um que sai nove por dia e está com −321.
 * Zerado é zerado — o desempate entre eles é o consumo, não o tamanho do furo.
 */
export function diasDeCobertura(consumoMedioDiario: number, estoque: number) {
  if (consumoMedioDiario <= 0) return null
  if (estoque <= 0) return 0
  return estoque / consumoMedioDiario
}

export type Urgencia = "sem_estoque" | "critico" | "comprar" | "ok"

/**
 * A situação de um produto, para a tela poder ordenar por quem precisa primeiro.
 *
 * Sem estoque é diferente de abaixo do mínimo, que é diferente de "chegou a
 * hora": quem compra precisa ver os três separados, senão a lista vira uma
 * massa de itens onde o que já falta se perde no meio do que ainda dá tempo.
 */
export function urgencia(
  politica: Pick<Politica, "estoqueMinimo" | "pontoDePedido">,
  estoque: number
): Urgencia {
  if (estoque <= 0) return "sem_estoque"
  if (estoque < politica.estoqueMinimo) return "critico"
  if (estoque < politica.pontoDePedido) return "comprar"
  return "ok"
}

export const ROTULOS_DE_URGENCIA: Record<Urgencia, string> = {
  sem_estoque: "Sem estoque",
  critico: "Abaixo do mínimo",
  comprar: "Hora de comprar",
  ok: "Suficiente",
}
