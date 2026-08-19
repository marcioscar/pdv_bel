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
 * A barra de navegação é só o **turno**: o que se usa com cliente na frente,
 * cada um com tecla de função. Ela não cresce — tela nova vai para a sidebar da
 * administração, senão o balcão vira menu.
 *
 * `tecla` é usada com Ctrl (ver ~/lib/navegacao); seção sem tecla só pelo menu.
 */
export const SECOES = [
  { para: "/", rotulo: "Caixa", tecla: "F1", somenteGerente: false },
  { para: "/estoque", rotulo: "Estoque", tecla: "F2", somenteGerente: false },
  { para: "/vendas", rotulo: "Vendas", tecla: "F3", somenteGerente: false },
  { para: "/admin", rotulo: "Adm", tecla: null, somenteGerente: false },
] as const

export function secoesDoPapel(papel: string) {
  return SECOES.filter((secao) => !secao.somenteGerente || ehGerente(papel))
}

/**
 * A administração é o **escritório**: o que se faz sentado, sem cliente esperando.
 *
 * Repare que ela não é "a área do gerente": é uma postura de trabalho, não um
 * nível de acesso. Cadastrar cliente e dar entrada em mercadoria são tarefas de
 * operador que não pertencem ao balcão; preço, relatório e usuários são do
 * gerente. Cada seção declara aqui o que exige, e o layout de /admin cobra —
 * então tela nova nasce protegida em vez de depender de alguém lembrar.
 */
export const SECOES_ADMIN = [
  {
    para: "/admin/produtos",
    rotulo: "Produtos",
    descricao: "Preço, descrição e cadastro do catálogo",
    somenteGerente: true,
  },
  {
    para: "/admin/clientes",
    rotulo: "Clientes",
    descricao: "Cadastro e endereço usados no boleto",
    somenteGerente: false,
  },
  {
    para: "/admin/estoque",
    rotulo: "Entradas e inventário",
    descricao: "Entrada de mercadoria e saldo contado",
    somenteGerente: false,
  },
  {
    para: "/admin/vendas",
    rotulo: "Vendas da rede",
    descricao: "Toda venda de todas as lojas, com filtro e busca",
    somenteGerente: true,
  },
  {
    para: "/admin/relatorios",
    rotulo: "Relatórios",
    descricao: "Faturamento, formas de pagamento e a receber",
    somenteGerente: true,
  },
  {
    para: "/admin/usuarios",
    rotulo: "Usuários",
    descricao: "Quem entra no sistema e com que papel",
    somenteGerente: true,
  },
] as const

export type SecaoAdmin = (typeof SECOES_ADMIN)[number]

export function secoesAdminDoPapel(papel: string) {
  return SECOES_ADMIN.filter((secao) => !secao.somenteGerente || ehGerente(papel))
}

/** A seção correspondente a um caminho. null na raiz de /admin e no desconhecido. */
export function secaoAdminDoCaminho(pathname: string): SecaoAdmin | null {
  const limpo = pathname.replace(/\/+$/, "")
  return SECOES_ADMIN.find((secao) => secao.para === limpo) ?? null
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
  editarProdutos: "Só gerente mexe no catálogo — preço é dinheiro",
  verRelatorios: "Só gerente vê os relatórios",
  verVendasDaRede: "Só gerente vê as vendas das outras lojas",
} as const

export type AcaoDeGerente = keyof typeof ACOES_DE_GERENTE
