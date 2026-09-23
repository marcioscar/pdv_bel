import { PRIMEIRO_DIA, ULTIMO_DIA } from "~/lib/dia"

/**
 * O vocabulário das contas a receber, do lado que as DUAS pontas usam.
 *
 * Mora fora de `recebiveis.server.ts` porque a tela precisa dele para pintar a
 * linha atrasada e montar o seletor de situação — e importar um módulo `.server`
 * de dentro de um componente quebra o pacote do navegador. A consulta importa
 * daqui; assim a régua do que é "em aberto" continua sendo uma só.
 */

/**
 * As situações que o Inter devolve, agrupadas pelo que interessa a quem cobra.
 *
 * A lista de strings não é nossa, é da API do banco. Agrupá-la aqui, uma vez,
 * evita que cada tela decida por conta própria se "EM_PROCESSAMENTO" já é
 * dinheiro em caixa — e é esse tipo de divergência que faz dois relatórios do
 * mesmo dia darem números diferentes.
 */
// PROTESTO continua sendo dívida; MARCADO_RECEBIDO é o "recebi por fora" dado
// no app do banco; FALHA_EMISSAO nunca virou boleto. As três só aparecem nos
// boletos emitidos fora daqui, mas a régua é uma só para os dois.
export const SITUACOES_EM_ABERTO = ["A_RECEBER", "EM_PROCESSAMENTO", "ATRASADO", "PROTESTO"]
// PAGO_NA_LOJA é nossa, não do Inter: a baixa manual de quem pagou no balcão.
export const PAGO_NA_LOJA = "PAGO_NA_LOJA"
export const SITUACOES_RECEBIDAS = ["RECEBIDO", "PAGO", "MARCADO_RECEBIDO", PAGO_NA_LOJA]
/** Como o cliente pagou o boleto no balcão — a tela oferece, a baixa confere. */
export const FORMAS_DA_BAIXA = [
  { id: "dinheiro", rotulo: "Dinheiro" },
  { id: "pix", rotulo: "Pix" },
  { id: "cartao", rotulo: "Cartão" },
] as const

export const SITUACOES_ENCERRADAS = ["CANCELADO", "EXPIRADO", "FALHA_EMISSAO"]

/**
 * A situação em português, para o papel que vai à gaveta.
 *
 * Na tela o código cru do Inter é o certo — é o que se procura no extrato do
 * banco e o que aparece em /admin/vendas. Na folha impressa não: quem confere a
 * gaveta não trabalha com a API, e "EM_PROCESSAMENTO" numa coluna estreita é
 * uma palavra que atrapalha em vez de informar. Situação nova do banco cai no
 * próprio código, que é melhor que cair num rótulo errado.
 */
const ROTULOS_DE_SITUACAO: Record<string, string> = {
  A_RECEBER: "A receber",
  EM_PROCESSAMENTO: "Emitindo",
  ATRASADO: "Atrasado",
  RECEBIDO: "Pago",
  PAGO: "Pago",
  CANCELADO: "Cancelado",
  EXPIRADO: "Expirado",
  PROTESTO: "Em protesto",
  MARCADO_RECEBIDO: "Baixado à mão",
  PAGO_NA_LOJA: "Pago na loja",
  FALHA_EMISSAO: "Falha na emissão",
}

export function rotuloDaSituacao(situacao: string) {
  return ROTULOS_DE_SITUACAO[situacao] ?? situacao
}

export type SituacaoRecebivel =
  | "abertas"
  | "vencidas"
  | "recebidas"
  | "canceladas"
  | "todas"

export const SITUACOES_RECEBIVEIS = [
  { id: "abertas", rotulo: "Em aberto" },
  { id: "vencidas", rotulo: "Só vencidas" },
  { id: "recebidas", rotulo: "Recebidas" },
  { id: "canceladas", rotulo: "Canceladas" },
  { id: "todas", rotulo: "Todas" },
] as const

/**
 * O filtro do jeito que a tela o mostra — texto, não `Date`, pelo mesmo motivo
 * do filtro de vendas: é o mesmo objeto que volta para preencher o formulário, e
 * converter duas vezes é onde nasce a divergência entre o que a tela diz filtrar
 * e o que filtrou de fato.
 */
export type FiltroRecebiveis = {
  /** Lojas efetivamente consultadas — sempre um subconjunto das permitidas. */
  lojas: string[]
  /** O que o seletor mostra: um código de loja ou "todas". */
  loja: string
  /** Vencimento, dias inclusivos, no formato do `<input type="date">`. */
  de: string
  ate: string
  numero: string
  cliente: string
  situacao: SituacaoRecebivel
  pagina: number
}

/** O "tudo" desta tela: passado inteiro e futuro inteiro. */
export const PERIODO_TODO = { de: PRIMEIRO_DIA, ate: ULTIMO_DIA }
