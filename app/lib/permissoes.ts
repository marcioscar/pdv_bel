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
  // Transferir mercadoria é trabalho de turno, não de escritório: quem carrega a
  // caixa no carro está de pé no estoque, e mandar essa pessoa procurar a tela
  // dentro da administração significa, na prática, esperar o gerente. Foi por
  // isso que a barra cresceu — o critério continua sendo quem faz, não o que é.
  { para: "/transferencias", rotulo: "Transf", tecla: "F4", somenteGerente: false },
  // Fechar o caixa é a última tarefa do turno, feita por quem contou a gaveta.
  // "Fechamento", e não "Caixa": este já é o nome do PDV em F1, e dois itens com
  // o mesmo rótulo na mesma barra é um convite a clicar no errado.
  { para: "/fechamento", rotulo: "Fechamento", tecla: "F5", somenteGerente: false },
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
export type SecaoAdmin = {
  para: string
  rotulo: string
  descricao: string
  somenteGerente: boolean
}

export type GrupoAdmin = {
  id: string
  rotulo: string
  secoes: SecaoAdmin[]
}

export const GRUPOS_ADMIN: GrupoAdmin[] = [
  {
    id: "produtos",
    rotulo: "Produtos",
    secoes: [
      {
        para: "/admin/produtos",
        rotulo: "Catálogo",
        descricao: "Preço, descrição e cadastro do catálogo",
        somenteGerente: true,
      },
      {
        para: "/admin/estoque",
        rotulo: "Entradas e inventário",
        descricao: "Entrada de mercadoria e saldo contado",
        somenteGerente: false,
      },
      {
        para: "/admin/ficha",
        rotulo: "Ficha de estoque",
        descricao: "Todo movimento de um produto, com o saldo depois de cada um",
        somenteGerente: false,
      },
      {
        para: "/admin/perdas",
        rotulo: "Perdas no transporte",
        descricao: "O que saiu de uma loja e não chegou na outra, por rota",
        somenteGerente: true,
      },
    ],
  },
  {
    // Separado de "Produtos" porque compra é conversa com fornecedor — mais
    // telas vêm por aqui (recebimento, cotação) sem inchar o grupo de catálogo
    // e estoque, que já é o mais cheio dos quatro.
    id: "compras",
    rotulo: "Compras",
    secoes: [
      {
        para: "/admin/compras",
        rotulo: "Compras",
        descricao: "O que repor: ponto de pedido e quanto comprar, da rede toda",
        somenteGerente: true,
      },
      {
        para: "/admin/pedidos-de-compra",
        rotulo: "Pedidos de compra",
        descricao: "Todo pedido gerado, por fornecedor, período e situação",
        somenteGerente: true,
      },
      {
        para: "/admin/notas-de-entrada",
        rotulo: "Notas de entrada",
        descricao: "Buscar o XML de uma nota do fornecedor na SEFAZ, pela chave de acesso",
        somenteGerente: true,
      },
    ],
  },
  {
    id: "vendas",
    rotulo: "Vendas",
    secoes: [
      {
        para: "/admin/vendas",
        rotulo: "Vendas da rede",
        descricao: "Toda venda de todas as lojas, com filtro e busca",
        somenteGerente: true,
      },
      {
        para: "/admin/autorizacoes",
        rotulo: "Autorizações",
        descricao: "Liberar venda a cliente devedor e desconto acima do teto",
        somenteGerente: true,
      },
      {
        para: "/admin/relatorios",
        rotulo: "Relatórios",
        descricao: "Faturamento, formas de pagamento e a receber",
        somenteGerente: true,
      },
    ],
  },
  {
    id: "financeiro",
    rotulo: "Financeiro",
    secoes: [
      {
        para: "/admin/caixas",
        rotulo: "Fechamentos de caixa",
        descricao: "Diferenças por loja e os dias que ninguém fechou",
        somenteGerente: true,
      },
      {
        para: "/admin/contas-a-receber",
        rotulo: "Contas a receber",
        descricao: "Boletos por vencimento: em aberto, vencidos e recebidos",
        somenteGerente: true,
      },
    ],
  },
  {
    id: "cadastros",
    rotulo: "Cadastros",
    secoes: [
      {
        para: "/admin/clientes",
        rotulo: "Clientes",
        descricao: "Cadastro e endereço usados no boleto",
        somenteGerente: false,
      },
      {
        para: "/admin/fornecedores",
        rotulo: "Fornecedores",
        descricao: "De quem se compra, e desde quando",
        somenteGerente: true,
      },
      {
        para: "/admin/usuarios",
        rotulo: "Usuários",
        descricao: "Quem entra no sistema e com que papel",
        somenteGerente: true,
      },
      {
        para: "/admin/certificados",
        rotulo: "Certificados",
        descricao: "Certificado do Inter e da SEFAZ, por loja — validade e renovação",
        somenteGerente: true,
      },
    ],
  },
]

/**
 * A lista plana continua sendo a fonte da guarda e do roteamento: o agrupamento
 * é apresentação, e nenhuma permissão pode depender de em qual gaveta a tela foi
 * guardada. Derivada, e não escrita à mão, para as duas não divergirem.
 */
export const SECOES_ADMIN = GRUPOS_ADMIN.flatMap((grupo) => grupo.secoes)

export function secoesAdminDoPapel(papel: string) {
  return SECOES_ADMIN.filter((secao) => !secao.somenteGerente || ehGerente(papel))
}

/**
 * Os grupos com as seções que o papel alcança. Grupo que ficaria vazio não é
 * mostrado — para o operador, "Vendas" seria uma gaveta que abre no nada.
 */
export function gruposAdminDoPapel(papel: string) {
  return GRUPOS_ADMIN.map((grupo) => ({
    ...grupo,
    secoes: grupo.secoes.filter((secao) => !secao.somenteGerente || ehGerente(papel)),
  })).filter((grupo) => grupo.secoes.length > 0)
}

/** O grupo em que uma seção mora — é o que a sidebar abre ao entrar na tela. */
export function grupoDaSecao(pathname: string) {
  const limpo = pathname.replace(/\/+$/, "")
  return (
    GRUPOS_ADMIN.find((grupo) => grupo.secoes.some((secao) => secao.para === limpo))
      ?.id ?? null
  )
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
  verContasAReceber: "Só gerente vê as contas a receber",
  decidirAutorizacoes: "Só gerente libera venda travada — é ele que responde pelo risco",
  trocarDeLoja:
    "Só gerente troca a loja do turno — para operar em outra, saia e entre de novo",
  reabrirCaixa: "Só gerente reabre um caixa já fechado — o papel assinado deixa de valer",
  resolverFaltaDeTransferencia:
    "Só gerente decide o que houve com a mercadoria que não chegou",
  buscarNotaFiscal: "Só gerente busca nota fiscal na SEFAZ — é dado fiscal da empresa",
  gerenciarCertificados: "Só gerente mexe em certificado — é credencial de acesso a banco e ao fisco",
} as const

export type AcaoDeGerente = keyof typeof ACOES_DE_GERENTE
