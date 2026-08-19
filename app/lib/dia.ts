/**
 * Dias no formato do `<input type="date">` — "YYYY-MM-DD", sempre no fuso local.
 *
 * `toISOString().slice(0, 10)` daria o dia em UTC, e no Brasil isso empurra tudo
 * que foi vendido depois das 21h para o dia seguinte. Um filtro "hoje" que perde
 * a última hora de caixa é pior que nenhum filtro, porque parece certo.
 *
 * O fuso do servidor é fixado em America/Sao_Paulo no Dockerfile; em máquina de
 * desenvolvimento é o do sistema. Os dois lados usam estas mesmas funções para o
 * dia que a tela mostra e o dia que a consulta usa serem o mesmo dia.
 */

/**
 * O começo de tudo, para o atalho "todo o histórico". Uma data fixa e anterior a
 * qualquer venda deste sistema evita uma consulta só para descobrir a primeira.
 */
export const PRIMEIRO_DIA = "2000-01-01"

export function emDia(data: Date) {
  const mes = String(data.getMonth() + 1).padStart(2, "0")
  const dia = String(data.getDate()).padStart(2, "0")
  return `${data.getFullYear()}-${mes}-${dia}`
}

export function diaDeHoje() {
  return emDia(new Date())
}

/** O dia N dias atrás. `diaAtras(0)` é hoje, `diaAtras(1)` é ontem. */
export function diaAtras(dias: number) {
  const data = new Date()
  data.setDate(data.getDate() - dias)
  return emDia(data)
}

export function inicioDoDia(dia: string) {
  const [ano, mes, data] = dia.split("-").map(Number)
  return new Date(ano, mes - 1, data, 0, 0, 0, 0)
}

/**
 * O instante em que o dia acaba, para usar com `lt`.
 *
 * Um período é fechado no fim do dia `ate`. Com `lte` no início desse dia, um
 * filtro de um dia só não pegaria nada depois da meia-noite — ou seja, o dia
 * inteiro.
 */
export function depoisDoDia(dia: string) {
  const data = inicioDoDia(dia)
  data.setDate(data.getDate() + 1)
  return data
}

/** "2026-08-19" → "19/08/2026", sem passar por `Date` e sem risco de fuso. */
export function diaEmTexto(dia: string) {
  const [ano, mes, data] = dia.split("-")
  return `${data}/${mes}/${ano}`
}
