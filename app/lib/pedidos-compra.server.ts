import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"
import { saldosPorProdutoELoja } from "~/lib/estoque.server"
import { saldosEmTransito } from "~/lib/transferencias.server"
import { diasDeCobertura, quantoComprar, urgencia, type Urgencia } from "~/lib/compras"

/**
 * O pedido de compra: o que se pediu, a quem, por quanto.
 *
 * Nasce como rascunho na tela de Compras e vira papel quando enviado. Enquanto
 * não chega, a quantidade pedida conta como estoque a caminho — a mesma decisão
 * já tomada para a transferência entre lojas, e pelo mesmo motivo: mercadoria
 * comprometida não deve gerar uma segunda compra em cima da primeira.
 */

export type ItemParaPedir = { produtoId: string; quantidade: number }

export type ResultadoPedido =
  | { ok: true; numero: number; id: string }
  | { ok: false; erro: string }

export async function criarPedido(entrada: {
  fornecedorId: string
  itens: ItemParaPedir[]
  operador: string
  observacao?: string | null
}): Promise<ResultadoPedido> {
  if (entrada.itens.length === 0) {
    return { ok: false, erro: "Pedido sem itens" }
  }

  const fornecedor = await db.fornecedor.findUnique({ where: { id: entrada.fornecedorId } })
  if (!fornecedor) return { ok: false, erro: "Fornecedor não encontrado" }

  const produtos = await db.produto.findMany({
    where: { id: { in: entrada.itens.map((i) => i.produtoId) } },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const fornecimentos = await db.fornecimento.findMany({
    where: {
      fornecedorId: entrada.fornecedorId,
      produtoId: { in: entrada.itens.map((i) => i.produtoId) },
    },
  })
  const custoPorProduto = new Map(fornecimentos.map((f) => [f.produtoId, f.ultimoCusto]))

  const itens: {
    produtoId: string
    codigo: string
    descricao: string
    unidade: string
    quantidade: number
    custoUnitario: number
    total: number
  }[] = []

  for (const pedido of entrada.itens) {
    const produto = porId.get(pedido.produtoId)
    if (!produto) return { ok: false, erro: "Produto não encontrado no catálogo" }
    if (!(pedido.quantidade > 0)) {
      return { ok: false, erro: `Quantidade inválida em ${produto.descricao}` }
    }

    // Sem fornecimento registrado deste fornecedor para este produto, o preço de
    // venda é a única referência disponível — melhor um número aproximado no
    // papel do que um campo em branco que trava a gravação.
    const custoUnitario = custoPorProduto.get(pedido.produtoId) ?? produto.preco
    const quantidade = arredondar(pedido.quantidade)

    itens.push({
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      quantidade,
      custoUnitario,
      total: arredondar(quantidade * custoUnitario),
    })
  }

  const total = arredondar(itens.reduce((soma, i) => soma + i.total, 0))
  const numero = await proximoNumero()
  const nome = fornecedor.nomeFantasia || fornecedor.razaoSocial

  const pedidoDeCompra = await db.pedidoDeCompra.create({
    data: {
      numero,
      fornecedorId: fornecedor.id,
      fornecedorNome: nome,
      itens,
      total,
      criadoPor: entrada.operador,
      observacao: entrada.observacao?.trim() || null,
    },
  })

  return { ok: true, numero: pedidoDeCompra.numero, id: pedidoDeCompra.id }
}

export type ItemDoFornecedor = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  custoUnitario: number
  ultimaCompra: Date
  /** O que já foi comprado deste fornecedor — mede relevância, não urgência. */
  quantidadeTotal: number
  /** Se este é o fornecedor principal do produto, ou uma alternativa. */
  principal: boolean
  estoque: number
  porLoja: Record<string, number>
  emTransito: number
  emPedido: number
  /** null quando o produto não tem política — sem histórico de venda para medir. */
  urgencia: Urgencia | null
  diasRestantes: number | null
  /** Sugestão de quanto pedir. 0 quando não há política: nada para sugerir. */
  sugestao: number
}

/**
 * O que este fornecedor vende, com a mesma régua de urgência da tela de
 * Compras — só que virada: em vez de "o que falta, de quem", "de quem, o que
 * falta". É o catálogo que a tela de novo pedido oferece depois de escolhido
 * o fornecedor.
 *
 * Produto que ele já forneceu mas nunca teve venda registrada entra do mesmo
 * jeito, só sem sugestão — o gerente pode pedir por conhecimento do negócio
 * mesmo sem o sistema ter medido consumo ainda.
 */
export async function catalogoDoFornecedor(fornecedorId: string): Promise<ItemDoFornecedor[]> {
  const fornecimentos = await db.fornecimento.findMany({ where: { fornecedorId } })
  if (fornecimentos.length === 0) return []

  const produtoIds = fornecimentos.map((f) => f.produtoId)

  const [produtos, politicas, saldos, transito, pedidos] = await Promise.all([
    db.produto.findMany({ where: { id: { in: produtoIds }, ativo: true } }),
    db.politicaDeCompra.findMany({ where: { produtoId: { in: produtoIds } } }),
    saldosPorProdutoELoja(),
    saldosEmTransito(),
    saldosPedidos(),
  ])
  const porId = new Map(produtos.map((p) => [p.id, p]))
  const politicaPorProduto = new Map(politicas.map((p) => [p.produtoId, p]))

  const itens: ItemDoFornecedor[] = []

  for (const f of fornecimentos) {
    const produto = porId.get(f.produtoId)
    // Desativado depois do vínculo ser gravado: não faz sentido oferecer para
    // pedir de novo o que saiu do catálogo.
    if (!produto) continue

    const porLojaMapa = saldos.get(f.produtoId) ?? new Map<string, number>()
    const porLoja = Object.fromEntries(porLojaMapa)
    const estoque = [...porLojaMapa.values()].reduce((soma, v) => soma + v, 0)
    const emTransito = transito.get(f.produtoId) ?? 0
    const emPedido = pedidos.get(f.produtoId) ?? 0

    const politica = politicaPorProduto.get(f.produtoId)
    const situacao = politica ? urgencia(politica, estoque) : null
    const sugestao = politica ? quantoComprar(politica, estoque, emTransito + emPedido) : 0
    const diasRestantes = politica ? diasDeCobertura(politica.consumoMedioDiario, estoque) : null

    itens.push({
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      custoUnitario: f.ultimoCusto,
      ultimaCompra: f.ultimaCompra,
      quantidadeTotal: f.quantidadeTotal,
      principal: f.principal,
      estoque,
      porLoja,
      emTransito,
      emPedido,
      urgencia: situacao,
      diasRestantes,
      sugestao,
    })
  }

  const ORDEM: Record<Urgencia, number> = { sem_estoque: 0, critico: 1, comprar: 2, ok: 3 }

  // Quem precisa primeiro; produto sem necessidade (ou sem política, que é a
  // mesma coisa vista de outro ângulo) vai depois, por quanto já se comprou dele
  // — é a ordem que reflete o catálogo de sempre desse fornecedor.
  itens.sort((a, b) => {
    const pa = a.urgencia && a.urgencia !== "ok" ? ORDEM[a.urgencia] : 9
    const pb = b.urgencia && b.urgencia !== "ok" ? ORDEM[b.urgencia] : 9
    if (pa !== pb) return pa - pb
    if (pa < 9) {
      const porDias = (a.diasRestantes ?? Infinity) - (b.diasRestantes ?? Infinity)
      if (porDias !== 0) return porDias
    }
    return b.quantidadeTotal - a.quantidadeTotal
  })

  return itens
}

/**
 * O mesmo padrão de numeração da venda e da transferência: `$inc` atômico num
 * documento só, fora de qualquer transação — para o rollback de uma gravação
 * que falhar não devolver o contador e repetir o número.
 */
async function proximoNumero() {
  const contador = await db.contador.upsert({
    where: { nome: "pedido_de_compra" },
    update: { valor: { increment: 1 } },
    create: { nome: "pedido_de_compra", valor: 1 },
  })
  return contador.valor
}

export function listarPedidos(limite = 60) {
  return db.pedidoDeCompra.findMany({
    orderBy: { criadoEm: "desc" },
    take: limite,
  })
}

export function pedidoPorId(id: string) {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return null
  return db.pedidoDeCompra.findUnique({ where: { id } })
}

/** Soma, por produto, a quantidade pedida em pedidos ainda não recebidos. */
export async function saldosPedidos(): Promise<Map<string, number>> {
  const abertos = await db.pedidoDeCompra.findMany({
    where: { situacao: { in: ["rascunho", "enviado"] } },
    select: { itens: true },
  })

  const mapa = new Map<string, number>()
  for (const doc of abertos) {
    for (const item of doc.itens) {
      mapa.set(item.produtoId, arredondar((mapa.get(item.produtoId) ?? 0) + item.quantidade))
    }
  }
  return mapa
}

export type ResultadoSituacao = { ok: true } | { ok: false; erro: string }

export async function marcarEnviado(id: string, operador: string): Promise<ResultadoSituacao> {
  const pedido = await pedidoPorId(id)
  if (!pedido) return { ok: false, erro: "Pedido não encontrado" }
  if (pedido.situacao !== "rascunho") {
    return { ok: false, erro: "Só um pedido em rascunho pode ser enviado" }
  }

  await db.pedidoDeCompra.update({
    where: { id },
    data: { situacao: "enviado", enviadoEm: new Date(), enviadoPor: operador },
  })
  return { ok: true }
}

/**
 * Recebe o pedido: muda a situação e dá entrada no estoque, na mesma transação.
 *
 * A compra é da rede, mas a mercadoria chega fisicamente numa loja — é lá que o
 * caminhão do fornecedor para. Sem uma loja, o pedido recebido mudaria de
 * situação sem o saldo em lugar nenhum mudar junto, e a mercadoria que acabou de
 * chegar continuaria não existindo para o sistema. Depois de receber, quem
 * quiser levar para as outras lojas usa a transferência, como sempre.
 *
 * O tipo do movimento é "entrada", o mesmo de uma entrada manual — só que este
 * carrega o `pedidoDeCompraId`, e é isso que a ficha do produto usa para
 * navegar até o pedido em vez de mostrar um número solto.
 */
export async function marcarRecebido(
  id: string,
  loja: string,
  operador: string
): Promise<ResultadoSituacao> {
  const pedido = await pedidoPorId(id)
  if (!pedido) return { ok: false, erro: "Pedido não encontrado" }
  if (pedido.situacao !== "enviado") {
    return { ok: false, erro: "Só um pedido enviado pode ser marcado como recebido" }
  }
  if (!loja) return { ok: false, erro: "Escolha a loja que recebeu a mercadoria" }

  await db.$transaction(async (tx) => {
    await tx.pedidoDeCompra.update({
      where: { id },
      data: { situacao: "recebido", recebidoEm: new Date(), recebidoPor: operador },
    })

    await tx.movimentoEstoque.createMany({
      data: pedido.itens.map((item) => ({
        produtoId: item.produtoId,
        loja,
        tipo: "entrada",
        quantidade: item.quantidade,
        operador,
        pedidoDeCompraId: pedido.id,
        pedidoDeCompraNumero: pedido.numero,
        observacao: `Pedido de compra #${pedido.numero} — ${pedido.fornecedorNome}`,
      })),
    })
  })

  return { ok: true }
}

export async function cancelarPedido(id: string, operador: string): Promise<ResultadoSituacao> {
  const pedido = await pedidoPorId(id)
  if (!pedido) return { ok: false, erro: "Pedido não encontrado" }
  if (pedido.situacao === "recebido" || pedido.situacao === "cancelado") {
    return { ok: false, erro: `Pedido já está ${pedido.situacao}` }
  }

  await db.pedidoDeCompra.update({
    where: { id },
    data: { situacao: "cancelado", canceladoEm: new Date(), canceladoPor: operador },
  })
  return { ok: true }
}
