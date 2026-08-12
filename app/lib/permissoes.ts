/**
 * Papéis e o que cada um alcança.
 *
 * Uma fonte só, usada pelo menu, pelos atalhos de navegação e pelas guardas do
 * servidor. Se o menu tivesse a própria lista, as duas divergiriam — e o dia em
 * que divergissem ninguém notaria, porque a tela continuaria bonita enquanto a
 * rota respondia a quem não devia.
 *
 * Dois papéis de propósito. Uma matriz de permissões é um sistema para manter, e
 * aqui há três usuários: o custo apareceria antes do benefício.
 */
export const PAPEIS = [
  {
    id: "operador",
    rotulo: "Operador",
    descricao: "Vende, consulta e dá entrada no estoque",
  },
  {
    id: "gerente",
    rotulo: "Gerente",
    descricao: "Também cancela venda, faz inventário e gerencia usuários",
  },
] as const

export type Papel = (typeof PAPEIS)[number]["id"]

export const PAPEL_PADRAO: Papel = "operador"

export function papelValido(valor: unknown): valor is Papel {
  return PAPEIS.some((p) => p.id === valor)
}

export function ehGerente(papel: string) {
  return papel === "gerente"
}

export function rotuloDoPapel(papel: string) {
  return PAPEIS.find((p) => p.id === papel)?.rotulo ?? papel
}

/**
 * As seções da barra de navegação. `tecla` é a tecla de função usada com Ctrl
 * (ver ~/lib/navegacao); seção sem tecla só é alcançada pelo menu.
 */
export const SECOES = [
  { para: "/", rotulo: "Caixa", tecla: "F1", somenteGerente: false },
  { para: "/estoque", rotulo: "Estoque", tecla: "F2", somenteGerente: false },
  { para: "/vendas", rotulo: "Vendas", tecla: "F3", somenteGerente: false },
  { para: "/usuarios", rotulo: "Usuários", tecla: null, somenteGerente: true },
] as const

export function secoesDoPapel(papel: string) {
  return SECOES.filter((secao) => !secao.somenteGerente || ehGerente(papel))
}

/**
 * Ações que exigem gerente, com a mensagem que o operador vê.
 *
 * Ficam nomeadas para a tela poder explicar por que o botão está indisponível em
 * vez de só escondê-lo: botão que desaparece parece defeito, botão que diz o
 * motivo ensina quem usa.
 */
export const ACOES_DE_GERENTE = {
  cancelarVenda: "Só gerente cancela venda — o cancelamento estorna o estoque",
  inventario: "Só gerente faz inventário — o ajuste reescreve o saldo contado",
  gerenciarUsuarios: "Só gerente gerencia usuários",
} as const

export type AcaoDeGerente = keyof typeof ACOES_DE_GERENTE
