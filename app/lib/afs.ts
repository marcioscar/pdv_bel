import { PRIMEIRO_DIA, ULTIMO_DIA } from "~/lib/dia"

/**
 * O vocabulário da AF (autorização de faturamento), do lado que tela e consulta
 * usam os dois.
 *
 * Separado de `afs.server.ts` pela mesma razão do vocabulário de pedidos: a
 * tela precisa disto para montar o filtro, e importar um módulo `.server` de
 * dentro de um componente quebra o pacote do navegador.
 */

/**
 * O filtro do jeito que a tela o mostra — texto, não `Date`, porque é o mesmo
 * objeto que volta para preencher o formulário.
 */
export type FiltroAfs = {
  de: string
  ate: string
  numero: string
  fornecedor: string
  loja: string
  pagina: number
}

/** O "tudo" desta tela: passado inteiro e futuro inteiro. */
export const PERIODO_TODO = { de: PRIMEIRO_DIA, ate: ULTIMO_DIA }

export const AFS_POR_PAGINA = 30
