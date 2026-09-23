import { db } from "~/lib/db.server"
import {
  limparCep,
  limparDocumento,
  limparInscricaoEstadual,
  tipoPessoaDe,
  validarCep,
  validarCpfCnpj,
  validarInscricaoEstadual,
  validarUf,
} from "~/lib/documento"

export type ClienteEntrada = {
  nome: string
  nomeFantasia?: string
  cpfCnpj: string
  endereco: string
  bairro: string
  cidade: string
  uf: string
  cep: string
  numero?: string
  complemento?: string
  email?: string
  ddd?: string
  telefone?: string
  inscricaoEstadual?: string
  contatoNome?: string
  contatoTelefone?: string
  contatoEmail?: string
}

export type ResultadoCliente =
  | { ok: true; cliente: Awaited<ReturnType<typeof db.cliente.create>> }
  | { ok: false; erro: string; campo?: keyof ClienteEntrada }

function texto(valor: FormDataEntryValue | null) {
  return typeof valor === "string" ? valor.trim() : ""
}

export function lerCliente(form: FormData): ClienteEntrada {
  return {
    nome: texto(form.get("nome")),
    nomeFantasia: texto(form.get("nomeFantasia")) || undefined,
    cpfCnpj: texto(form.get("cpfCnpj")),
    endereco: texto(form.get("endereco")),
    bairro: texto(form.get("bairro")),
    cidade: texto(form.get("cidade")),
    uf: texto(form.get("uf")),
    cep: texto(form.get("cep")),
    numero: texto(form.get("numero")) || undefined,
    complemento: texto(form.get("complemento")) || undefined,
    email: texto(form.get("email")) || undefined,
    ddd: texto(form.get("ddd")) || undefined,
    telefone: texto(form.get("telefone")) || undefined,
    inscricaoEstadual: texto(form.get("inscricaoEstadual")) || undefined,
    contatoNome: texto(form.get("contatoNome")) || undefined,
    contatoTelefone: texto(form.get("contatoTelefone")) || undefined,
    contatoEmail: texto(form.get("contatoEmail")) || undefined,
  }
}

/**
 * Valida o que o boleto vai exigir. É melhor recusar aqui, no cadastro, do que
 * descobrir na emissão que o endereço está incompleto e a cobrança foi rejeitada.
 *
 * Compartilhada entre criar e atualizar: se fossem duas listas, editar um cliente
 * poderia deixá-lo com menos dados do que o cadastro aceita.
 */
function validarEntrada(entrada: ClienteEntrada): { ok: false; erro: string; campo?: keyof ClienteEntrada } | null {
  if (entrada.nome.length < 3) {
    return { ok: false, erro: "Informe o nome completo", campo: "nome" }
  }
  if (!validarCpfCnpj(entrada.cpfCnpj)) {
    return { ok: false, erro: "CPF/CNPJ inválido", campo: "cpfCnpj" }
  }
  if (entrada.endereco.length < 3) {
    return { ok: false, erro: "Informe o endereço", campo: "endereco" }
  }
  if (!entrada.bairro) return { ok: false, erro: "Informe o bairro", campo: "bairro" }
  if (!entrada.cidade) return { ok: false, erro: "Informe a cidade", campo: "cidade" }
  if (!validarUf(entrada.uf)) return { ok: false, erro: "UF inválida", campo: "uf" }
  if (!validarCep(entrada.cep)) {
    return { ok: false, erro: "CEP deve ter 8 dígitos", campo: "cep" }
  }
  // Vazia é o caso comum — só o que foi preenchido precisa fazer sentido.
  if (entrada.inscricaoEstadual && !validarInscricaoEstadual(entrada.inscricaoEstadual)) {
    return {
      ok: false,
      erro: "Inscrição estadual: 8 a 14 dígitos, ou ISENTO",
      campo: "inscricaoEstadual",
    }
  }
  return null
}

/** Fantasia igual à razão social é texto repetido na lista — não se guarda. */
function fantasiaPropria(entrada: ClienteEntrada) {
  const fantasia = entrada.nomeFantasia?.trim()
  if (!fantasia || fantasia.toUpperCase() === entrada.nome.trim().toUpperCase()) return undefined
  return fantasia
}

/**
 * A loja vem à parte da entrada de propósito: ela sai da sessão, não do
 * formulário. Se viesse junto no `FormData`, um campo escondido bastaria para
 * gravar um cadastro em nome de outra loja.
 */
export async function criarCliente(
  entrada: ClienteEntrada,
  { loja }: { loja: string }
): Promise<ResultadoCliente> {
  const problema = validarEntrada(entrada)
  if (problema) return problema

  const cpfCnpj = limparDocumento(entrada.cpfCnpj)
  const tipoPessoa = tipoPessoaDe(cpfCnpj)
  if (!tipoPessoa) return { ok: false, erro: "CPF/CNPJ inválido", campo: "cpfCnpj" }

  const jaExiste = await db.cliente.findUnique({ where: { cpfCnpj } })
  if (jaExiste) {
    return { ok: false, erro: `${jaExiste.nome} já está cadastrado`, campo: "cpfCnpj" }
  }

  const cliente = await db.cliente.create({
    data: {
      nome: entrada.nome,
      nomeFantasia: fantasiaPropria(entrada),
      cpfCnpj,
      tipoPessoa,
      endereco: entrada.endereco,
      bairro: entrada.bairro,
      cidade: entrada.cidade,
      uf: entrada.uf.toUpperCase(),
      cep: limparCep(entrada.cep),
      numero: entrada.numero,
      complemento: entrada.complemento,
      email: entrada.email,
      ddd: entrada.ddd,
      telefone: entrada.telefone,
      inscricaoEstadual: entrada.inscricaoEstadual
        ? limparInscricaoEstadual(entrada.inscricaoEstadual)
        : undefined,
      contatoNome: entrada.contatoNome,
      contatoTelefone: entrada.contatoTelefone,
      contatoEmail: entrada.contatoEmail,
      lojaCadastro: loja,
    },
  })

  return { ok: true, cliente }
}

/**
 * Clientes ativos — é o que o caixa oferece no F6.
 *
 * `emitirParaVenda` busca o pagador por id sem este filtro, de propósito: uma
 * venda a prazo antiga precisa continuar podendo emitir o boleto mesmo que o
 * cadastro tenha sido desativado depois.
 */
export function listarClientes({ incluirInativos = false } = {}) {
  return db.cliente.findMany({
    where: incluirInativos ? {} : { ativo: true },
    orderBy: { nome: "asc" },
  })
}

const CLIENTES_POR_PAGINA = 50

/**
 * A lista da tela de Clientes, uma página por vez e filtrada no banco.
 *
 * Com o cadastro do sistema antigo são mais de seis mil clientes: mandar todos
 * para o navegador e filtrar lá fazia a tela desenhar seis mil linhas para quem
 * procurava uma. O F6 do caixa continua com `listarClientes`, porque mostra no
 * máximo oito e precisa responder sem esperar a rede.
 *
 * A busca ignora maiúsculas mas não acentos — o Mongo não compara sem acento
 * sem uma collation que o Prisma não expõe. O cadastro importado é todo sem
 * acento, então "joao" acha "JOAO"; o que se cadastrou à mão como "João" pede
 * o til.
 */
export async function buscarClientes({
  busca = "",
  pagina = 1,
  incluirInativos = false,
}: {
  busca?: string
  pagina?: number
  incluirInativos?: boolean
}) {
  // O Prisma entrega o `contains` ao Mongo como regex sem escapar nada: sem
  // isto, buscar "(teste" ou "S/A." derruba a consulta ou acha o que não devia.
  const termo = busca.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const digitos = busca.replace(/\D/g, "")

  const filtroBusca = termo
    ? {
        OR: [
          { nome: { contains: termo, mode: "insensitive" as const } },
          { nomeFantasia: { contains: termo, mode: "insensitive" as const } },
          { cidade: { contains: termo, mode: "insensitive" as const } },
          ...(digitos.length >= 3 ? [{ cpfCnpj: { contains: digitos } }] : []),
        ],
      }
    : {}
  const where = incluirInativos ? filtroBusca : { ...filtroBusca, ativo: true }

  const [total, inativos] = await Promise.all([
    db.cliente.count({ where }),
    db.cliente.count({ where: { ativo: false } }),
  ])
  const paginas = Math.max(1, Math.ceil(total / CLIENTES_POR_PAGINA))
  const atual = Math.min(Math.max(1, Math.floor(pagina) || 1), paginas)

  const clientes = await db.cliente.findMany({
    where,
    orderBy: { nome: "asc" },
    skip: (atual - 1) * CLIENTES_POR_PAGINA,
    take: CLIENTES_POR_PAGINA,
  })

  return { clientes, total, inativos, pagina: atual, paginas, porPagina: CLIENTES_POR_PAGINA }
}

/** Desativa ou reativa. Não existe apagar: vendas referenciam o clienteId. */
export async function alternarCliente(id: string) {
  if (!OBJECT_ID.test(id)) return { ok: false as const, erro: "Cliente inválido" }

  const cliente = await db.cliente.findUnique({ where: { id } })
  if (!cliente) return { ok: false as const, erro: "Cliente não encontrado" }

  const atualizado = await db.cliente.update({
    where: { id },
    data: { ativo: !cliente.ativo },
  })
  return {
    ok: true as const,
    mensagem: `${atualizado.nome} ${atualizado.ativo ? "reativado" : "desativado"}`,
  }
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * Atualiza o cadastro. Vale mais do que parece: endereço incompleto ou errado faz
 * o Inter recusar o boleto, e antes disto só havia como corrigir no banco à mão.
 *
 * As mesmas validações do cadastro, porque o boleto exige o mesmo dos dois.
 */
export async function atualizarCliente(
  id: string,
  entrada: ClienteEntrada
): Promise<ResultadoCliente> {
  if (!OBJECT_ID.test(id)) return { ok: false, erro: "Cliente inválido" }

  const existente = await db.cliente.findUnique({ where: { id } })
  if (!existente) return { ok: false, erro: "Cliente não encontrado" }

  const problema = validarEntrada(entrada)
  if (problema) return problema

  const cpfCnpj = limparDocumento(entrada.cpfCnpj)
  const tipoPessoa = tipoPessoaDe(cpfCnpj)
  if (!tipoPessoa) return { ok: false, erro: "CPF/CNPJ inválido", campo: "cpfCnpj" }

  // Trocar o documento para o de outro cadastro violaria o índice único.
  const outro = await db.cliente.findUnique({ where: { cpfCnpj } })
  if (outro && outro.id !== id) {
    return { ok: false, erro: `${outro.nome} já usa esse CPF/CNPJ`, campo: "cpfCnpj" }
  }

  const cliente = await db.cliente.update({
    where: { id },
    data: {
      nome: entrada.nome,
      nomeFantasia: fantasiaPropria(entrada) ?? null,
      cpfCnpj,
      tipoPessoa,
      endereco: entrada.endereco,
      bairro: entrada.bairro,
      cidade: entrada.cidade,
      uf: entrada.uf.toUpperCase(),
      cep: limparCep(entrada.cep),
      numero: entrada.numero ?? null,
      complemento: entrada.complemento ?? null,
      email: entrada.email ?? null,
      ddd: entrada.ddd ?? null,
      telefone: entrada.telefone ?? null,
      inscricaoEstadual: entrada.inscricaoEstadual
        ? limparInscricaoEstadual(entrada.inscricaoEstadual)
        : null,
      contatoNome: entrada.contatoNome ?? null,
      contatoTelefone: entrada.contatoTelefone ?? null,
      contatoEmail: entrada.contatoEmail ?? null,
      // `lojaCadastro` fica de fora: é o registro de onde o cadastro nasceu, e
      // editar em outra loja não muda esse fato.
    },
  })

  return { ok: true, cliente }
}

/**
 * O que este cliente comprou, da rede inteira e em ordem de recência.
 *
 * Existe para uma conversa concreta: o cliente liga e pede "repete o último
 * pedido". Sem isto, quem atende procurava na tela de Vendas por nome, uma loja
 * de cada vez, e a última compra podia ter sido feita na outra.
 *
 * A rede inteira de propósito: o cadastro é da rede, e quem comprou na QI e liga
 * para a SDS continua sendo o mesmo cliente com o mesmo pedido de sempre.
 *
 * Inclui as compras do sistema antigo (`vendas_antigas`): o "de sempre" de
 * quem é cliente há anos está lá, não aqui.
 *
 * Traz os itens junto — são eles a resposta da pergunta. Sem os itens, a lista
 * diria quanto ele gastou, que é o que ninguém perguntou.
 */
export async function historicoDoCliente(clienteId: string, { limite = 30 } = {}) {
  if (!OBJECT_ID.test(clienteId)) return []

  // As duas fontes pelo mesmo limite: juntas e cortadas depois, para as trinta
  // mais recentes serem as trinta mais recentes de verdade, de onde vierem.
  const [vendas, antigas] = await Promise.all([
    db.venda.findMany({
      where: { clienteId },
      orderBy: { criadaEm: "desc" },
      take: limite,
    }),
    db.vendaAntiga.findMany({
      where: { clienteId },
      orderBy: { data: "desc" },
      take: limite,
    }),
  ])

  const novas = vendas.map((venda) => ({
    id: venda.id,
    /** Null na compra do sistema antigo, que não tem número daqui. */
    numero: venda.numero as number | null,
    antiga: null as null | { documento: string },
    loja: venda.loja,
    criadaEm: venda.criadaEm,
    forma: venda.forma,
    total: venda.total,
    desconto: venda.desconto,
    canceladaEm: venda.canceladaEm,
    vendedorNome: venda.vendedorNome,
    itens: venda.itens.map((item) => ({
      codigo: item.codigo,
      descricao: item.descricao,
      unidade: item.unidade,
      quantidade: item.quantidade,
      preco: item.preco,
      subtotal: item.subtotal,
    })),
  }))

  // Vem com a mesma forma, para o diálogo não precisar de dois desenhos. A
  // cancelada não tem data de cancelamento no arquivo: a da compra serve, já
  // que o diálogo só pergunta SE foi cancelada.
  const doSistemaAntigo = antigas.map((venda) => ({
    id: venda.id,
    numero: null,
    antiga: { documento: venda.documento },
    loja: venda.loja,
    criadaEm: venda.data,
    forma: venda.forma,
    total: venda.total,
    desconto: venda.desconto,
    canceladaEm: venda.cancelada ? venda.data : null,
    vendedorNome: venda.vendedorNome,
    itens: venda.itens.map((item) => ({
      codigo: item.codigo,
      descricao: item.descricao,
      unidade: item.unidade,
      quantidade: item.quantidade,
      preco: item.preco,
      subtotal: item.subtotal,
    })),
  }))

  return [...novas, ...doSistemaAntigo]
    .sort((a, b) => b.criadaEm.getTime() - a.criadaEm.getTime())
    .slice(0, limite)
}
