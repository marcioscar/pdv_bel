/**
 * O vocabulário do Contas a pagar que a tela também usa. Fora do `.server`
 * porque o seletor de situação roda no navegador, e importar um módulo
 * `.server` de dentro de um componente quebra o pacote do navegador.
 */
export const SITUACOES_A_PAGAR = [
  { id: "abertas", rotulo: "A pagar" },
  { id: "vencidas", rotulo: "Vencidas" },
  { id: "pagas", rotulo: "Pagas" },
  { id: "todas", rotulo: "Todas" },
] as const

export type SituacaoAPagar = (typeof SITUACOES_A_PAGAR)[number]["id"]

export type FiltroAPagar = {
  de: string
  ate: string
  loja: string
  fornecedor: string
  situacao: SituacaoAPagar
}
