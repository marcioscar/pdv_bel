import type { Prisma } from "@prisma/client"

import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"
import { saldosPorProdutoELoja } from "~/lib/estoque.server"
import { saldosEmTransito } from "~/lib/transferencias.server"
import { diasDeCobertura, quantoComprar, urgencia, type Urgencia } from "~/lib/compras"
import {
  PRIMEIRO_DIA,
  ULTIMO_DIA,
  depoisDoDia,
  inicioDoDia,
} from "~/lib/dia"
import { SITUACOES_PEDIDO, type FiltroPedidos, type SituacaoPedido } from "~/lib/pedidos-compra"

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

export const PEDIDOS_POR_PAGINA = 30

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * Lê o filtro da URL, no mesmo padrão de `lerFiltroRecebiveis`.
 *
 * O padrão é "tudo": ao contrário da carteira de boletos, que cresce todo dia
 * às centenas, pedido de compra nasce às dezenas por mês. Um período restrito
 * por padrão esconderia o pedido de duas semanas atrás sem necessidade — aqui
 * quem pagina é a lista, não o calendário.
 */
export function lerFiltroPedidos(url: URL): FiltroPedidos {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const temDe = DIA.test(texto("de"))
  const temAte = DIA.test(texto("ate"))
  const de = temDe ? texto("de") : temAte ? texto("ate") : PRIMEIRO_DIA
  const ateBruto = temAte ? texto("ate") : temDe ? texto("de") : ULTIMO_DIA
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const situacao = texto("situacao")

  return {
    de: inicio,
    ate: fim,
    numero: texto("numero").replace(/\D/g, "").slice(0, 9),
    fornecedor: texto("fornecedor").slice(0, 60),
    situacao: SITUACOES_PEDIDO.some((s) => s.id === situacao)
      ? (situacao as SituacaoPedido)
      : "todas",
    pagina: Math.max(1, Math.trunc(Number(params.get("pagina"))) || 1),
  }
}

/**
 * Os pedidos que casam com o filtro, uma página de cada vez.
 *
 * O resumo ignora de propósito o seletor de situação — como em contas a
 * receber, os três cartões SÃO a repartição por situação daquele período e
 * daquele fornecedor. Obedecer ao seletor faria dois dos três serem sempre
 * zero.
 */
export async function consultarPedidos(filtro: FiltroPedidos) {
  const periodo: Prisma.PedidoDeCompraWhereInput = {
    criadoEm: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) },
  }
  const conteudo: Prisma.PedidoDeCompraWhereInput[] = []
  if (filtro.numero) conteudo.push({ numero: Number(filtro.numero) })
  if (filtro.fornecedor) {
    conteudo.push({ fornecedorNome: { contains: filtro.fornecedor, mode: "insensitive" } })
  }

  const base: Prisma.PedidoDeCompraWhereInput = { AND: [periodo, ...conteudo] }
  const where: Prisma.PedidoDeCompraWhereInput =
    filtro.situacao === "todas" ? base : { AND: [periodo, ...conteudo, { situacao: filtro.situacao }] }

  const emAberto = { AND: [base, { situacao: { in: ["rascunho", "enviado", "parcial"] } }] }
  const recebidos = { AND: [base, { situacao: "recebido" }] }
  const cancelados = { AND: [base, { situacao: "cancelado" }] }

  const [pagina, total, abertoAg, recebidoAg, canceladoAg] = await Promise.all([
    db.pedidoDeCompra.findMany({
      where,
      orderBy: { criadoEm: "desc" },
      skip: (filtro.pagina - 1) * PEDIDOS_POR_PAGINA,
      take: PEDIDOS_POR_PAGINA,
    }),
    db.pedidoDeCompra.count({ where }),
    db.pedidoDeCompra.aggregate({ where: emAberto, _sum: { total: true }, _count: { _all: true } }),
    db.pedidoDeCompra.aggregate({ where: recebidos, _sum: { total: true }, _count: { _all: true } }),
    db.pedidoDeCompra.aggregate({ where: cancelados, _sum: { total: true }, _count: { _all: true } }),
  ])

  // Quando a busca por número ou fornecedor não acha nada no período, dizer
  // isso é melhor que uma tela vazia que parece defeito — a mesma escolha já
  // feita em contas a receber e em vendas.
  const foraDoPeriodo =
    total === 0 && (filtro.numero || filtro.fornecedor)
      ? await db.pedidoDeCompra.count({
          where: filtro.situacao === "todas" ? { AND: conteudo } : { AND: [...conteudo, { situacao: filtro.situacao }] },
        })
      : 0

  return {
    pedidos: pagina,
    total,
    foraDoPeriodo,
    paginas: Math.max(1, Math.ceil(total / PEDIDOS_POR_PAGINA)),
    resumo: {
      aberto: abertoAg._sum.total ?? 0,
      abertoQuantidade: abertoAg._count._all,
      recebido: recebidoAg._sum.total ?? 0,
      recebidoQuantidade: recebidoAg._count._all,
      cancelado: canceladoAg._sum.total ?? 0,
      canceladoQuantidade: canceladoAg._count._all,
    },
  }
}

export type PedidoDaConsulta = Awaited<ReturnType<typeof consultarPedidos>>["pedidos"][number]

export function pedidoPorId(id: string) {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return null
  return db.pedidoDeCompra.findUnique({ where: { id } })
}

/**
 * Quanto já entrou no estoque por conta de um pedido, por produto — direto do
 * livro de movimentos, não de um contador à parte. Um pedido "parcial" tem
 * parte disto maior que zero e parte menor que o pedido; é essa diferença que
 * diz o que ainda falta chegar.
 */
export async function recebidoPorProduto(pedidoId: string): Promise<Map<string, number>> {
  const movimentos = await db.movimentoEstoque.findMany({
    where: { pedidoDeCompraId: pedidoId, tipo: "entrada" },
    select: { produtoId: true, quantidade: true },
  })
  const mapa = new Map<string, number>()
  for (const m of movimentos) {
    mapa.set(m.produtoId, arredondar((mapa.get(m.produtoId) ?? 0) + m.quantidade))
  }
  return mapa
}

/**
 * Soma, por produto, o que falta chegar em pedidos ainda em aberto — pedido
 * "parcial" conta só o restante, não o total original: a parte que já chegou
 * já virou saldo de verdade (`MovimentoEstoque`), contar de novo aqui seria
 * contar a mesma mercadoria duas vezes.
 */
export async function saldosPedidos(): Promise<Map<string, number>> {
  const abertos = await db.pedidoDeCompra.findMany({
    where: { situacao: { in: ["rascunho", "enviado", "parcial"] } },
    select: { id: true, itens: true },
  })
  if (abertos.length === 0) return new Map()

  const movimentos = await db.movimentoEstoque.findMany({
    where: { pedidoDeCompraId: { in: abertos.map((p) => p.id) }, tipo: "entrada" },
    select: { pedidoDeCompraId: true, produtoId: true, quantidade: true },
  })
  const recebidoPorPedidoEProduto = new Map<string, number>()
  for (const m of movimentos) {
    const chave = `${m.pedidoDeCompraId}:${m.produtoId}`
    recebidoPorPedidoEProduto.set(chave, (recebidoPorPedidoEProduto.get(chave) ?? 0) + m.quantidade)
  }

  const mapa = new Map<string, number>()
  for (const pedido of abertos) {
    for (const item of pedido.itens) {
      const jaRecebido = recebidoPorPedidoEProduto.get(`${pedido.id}:${item.produtoId}`) ?? 0
      const faltando = Math.max(0, item.quantidade - jaRecebido)
      if (faltando > 0) {
        mapa.set(item.produtoId, arredondar((mapa.get(item.produtoId) ?? 0) + faltando))
      }
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

/**
 * Lê `passo`/`id`/`loja` de um FormData e despacha para a transição certa.
 *
 * Duas telas mudam a situação de um pedido — Compras e a consulta — e as duas
 * fazem exatamente o mesmo POST. Uma dispatcher só aqui é o que impede as duas
 * actions de divergirem no formato do formulário com o tempo.
 */
export async function aplicarSituacao(
  form: FormData,
  operador: string
): Promise<ResultadoSituacao> {
  const id = String(form.get("id") ?? "")
  const passo = String(form.get("passo") ?? "")

  switch (passo) {
    case "enviar":
      return marcarEnviado(id, operador)
    case "receber":
      return marcarRecebido(id, String(form.get("loja") ?? ""), operador)
    case "cancelar":
      return cancelarPedido(id, operador)
    default:
      return { ok: false, erro: "Ação inválida" }
  }
}
