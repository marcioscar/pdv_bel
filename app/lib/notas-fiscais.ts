import { PRIMEIRO_DIA, ULTIMO_DIA } from "~/lib/dia"

/**
 * O vocabulário da nota fiscal recebida, do lado que tela e consulta usam os
 * dois — mesma separação de `pedidos-compra.ts`: a tela precisa disto para
 * montar o seletor e pintar o badge, e importar um módulo `.server` de dentro
 * de um componente quebra o pacote do navegador.
 */

export type SituacaoNota = "todas" | "disponivel" | "recebida" | "ignorada"

export const SITUACOES_NOTA = [
  { id: "todas", rotulo: "Todas" },
  { id: "disponivel", rotulo: "Disponível" },
  { id: "recebida", rotulo: "Recebida" },
  { id: "ignorada", rotulo: "Ignorada" },
] as const satisfies { id: SituacaoNota; rotulo: string }[]

export function rotuloDaSituacaoNota(situacao: string) {
  return SITUACOES_NOTA.find((s) => s.id === situacao)?.rotulo ?? situacao
}

export type FiltroNotas = {
  loja: string
  de: string
  ate: string
  /** Nome ou CNPJ do emitente — um campo só, porque quem procura tem um ou outro. */
  fornecedor: string
  numero: string
  situacao: SituacaoNota
  pagina: number
}

/** O "tudo" desta tela: passado inteiro e futuro inteiro. */
export const PERIODO_TODO = { de: PRIMEIRO_DIA, ate: ULTIMO_DIA }
