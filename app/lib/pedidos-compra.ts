import { PRIMEIRO_DIA, ULTIMO_DIA } from "~/lib/dia"

/**
 * O vocabulário do pedido de compra, do lado que tela e consulta usam os dois.
 *
 * Separado de `pedidos-compra.server.ts` pelo mesmo motivo do vocabulário de
 * recebíveis: a tela precisa disto para montar o seletor de situação e pintar o
 * badge, e importar um módulo `.server` de dentro de um componente quebra o
 * pacote do navegador.
 */

export type SituacaoPedido = "todas" | "rascunho" | "enviado" | "parcial" | "recebido" | "cancelado"

export const SITUACOES_PEDIDO = [
  { id: "todas", rotulo: "Todas" },
  { id: "rascunho", rotulo: "Rascunho" },
  { id: "enviado", rotulo: "Enviado" },
  // Chegou alguma coisa, mas não tudo — a mercadoria que falta continua sendo
  // esperada, e a conciliação fica aberta para o resto chegar.
  { id: "parcial", rotulo: "Parcial" },
  { id: "recebido", rotulo: "Recebido" },
  { id: "cancelado", rotulo: "Cancelado" },
] as const satisfies { id: SituacaoPedido; rotulo: string }[]

export function rotuloDaSituacaoPedido(situacao: string) {
  return SITUACOES_PEDIDO.find((s) => s.id === situacao)?.rotulo ?? situacao
}

/**
 * O filtro do jeito que a tela o mostra — texto, não `Date`: é o mesmo objeto
 * que volta para preencher o formulário, e converter duas vezes é onde nasce a
 * divergência entre o que a tela diz filtrar e o que filtrou de fato.
 */
export type FiltroPedidos = {
  de: string
  ate: string
  numero: string
  fornecedor: string
  situacao: SituacaoPedido
  pagina: number
}

/** O "tudo" desta tela: passado inteiro e futuro inteiro. */
export const PERIODO_TODO = { de: PRIMEIRO_DIA, ate: ULTIMO_DIA }
