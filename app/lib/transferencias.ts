/**
 * O vocabulário das transferências, do lado que as duas pontas usam.
 */

export const SITUACOES_DE_TRANSFERENCIA = {
  em_transito: "Em trânsito",
  recebida: "Recebida",
  recebida_com_falta: "Recebida com falta",
  cancelada: "Cancelada",
} as const

export type SituacaoTransferencia = keyof typeof SITUACOES_DE_TRANSFERENCIA

export function rotuloDaSituacao(situacao: string) {
  return (
    SITUACOES_DE_TRANSFERENCIA[situacao as SituacaoTransferencia] ?? situacao
  )
}

/** Está no caminho: saiu da origem e ainda não foi conferida no destino. */
export function emTransito(situacao: string) {
  return situacao === "em_transito"
}

/**
 * Tem diferença esperando decisão de gerente.
 *
 * Só `recebida_com_falta` e ainda sem resolução: depois de resolvida, a
 * transferência continua marcada (o histórico não mente sobre o que aconteceu),
 * mas sai da lista do que precisa de alguém.
 */
export function faltaEmAberto(t: {
  situacao: string
  faltaResolvidaEm: Date | string | null
}) {
  return t.situacao === "recebida_com_falta" && !t.faltaResolvidaEm
}

export type ItemConferido = { produtoId: string; recebida: number }

/** A diferença de um item, positiva quando faltou. */
export function faltaDoItem(item: { enviada: number; recebida: number | null }) {
  if (item.recebida === null) return 0
  return Math.max(0, item.enviada - item.recebida)
}
