/**
 * Os meses fechados que se pode consultar, e o instante em que cada um termina.
 *
 * "Último dia do mês" é o último INSTANTE dele, no fuso local: 31/08 às
 * 23:59:59.999. Cortar em 31/08 00:00 jogaria fora o dia inteiro — e o dia
 * inteiro num estoque de balcão é justamente onde estão os movimentos.
 */

const NOMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
] as const

export type MesFechado = { valor: string; rotulo: string }

/** Fim do mês de "2026-08", no fuso local. Null quando o texto não é um mês. */
export function fimDoMes(valor: string): Date | null {
  const casa = /^(\d{4})-(\d{2})$/.exec(valor)
  if (!casa) return null

  const ano = Number(casa[1])
  const mes = Number(casa[2])
  if (mes < 1 || mes > 12) return null

  // Dia 0 do mês SEGUINTE é o último dia deste — e a conta acerta fevereiro,
  // ano bissexto e virada de ano sem nenhuma tabela.
  return new Date(ano, mes, 0, 23, 59, 59, 999)
}

export function rotuloDoMes(valor: string) {
  const casa = /^(\d{4})-(\d{2})$/.exec(valor)
  if (!casa) return valor
  const nome = NOMES[Number(casa[2]) - 1] ?? casa[2]
  return `${nome} de ${casa[1]}`
}

/**
 * Os meses JÁ FECHADOS entre o começo do livro e hoje, do mais recente para o
 * mais antigo.
 *
 * O mês corrente fica de fora: o último dia dele ainda não aconteceu, e o que
 * se quer dele é o saldo de agora — que é a opção "Hoje".
 */
export function mesesFechados(desde: Date | null, ate = new Date()): MesFechado[] {
  if (!desde) return []

  const meses: MesFechado[] = []
  const cursor = new Date(desde.getFullYear(), desde.getMonth(), 1)
  const limite = new Date(ate.getFullYear(), ate.getMonth(), 1)

  while (cursor < limite) {
    const valor = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`
    meses.push({ valor, rotulo: rotuloDoMes(valor) })
    cursor.setMonth(cursor.getMonth() + 1)
  }

  return meses.reverse()
}
