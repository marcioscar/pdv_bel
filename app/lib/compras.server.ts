import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"
import { saldosPorProdutoELoja } from "~/lib/estoque.server"
import { saldosEmTransito } from "~/lib/transferencias.server"
import { saldosPedidos } from "~/lib/pedidos-compra.server"
import {
  calcularPolitica,
  diasDeCobertura,
  quantoComprar,
  urgencia,
  type Consumo,
  type Urgencia,
} from "~/lib/compras"

export type FornecedorAlternativo = {
  fornecedorId: string
  nome: string
  custo: number
  ultimaCompra: Date
}

export type LinhaDeCompra = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  preco: number
  /** Saldo somado das quatro lojas — a compra é da rede. */
  estoque: number
  /** O que já saiu de uma loja e ainda não foi conferido na outra. */
  emTransito: number
  /** O que já foi pedido a um fornecedor e ainda não chegou. */
  emPedido: number
  /** Por loja, para quem compra ver se falta em todas ou só numa. */
  porLoja: Record<string, number>
  consumoMedioDiario: number
  estoqueMinimo: number
  pontoDePedido: number
  comprar: number
  /** Em quantos dias o saldo acaba no ritmo medido. null se o produto não gira. */
  diasRestantes: number | null
  /**
   * Custo unitário para dimensionar a compra: o da última compra registrada
   * quando existe, senão o preço de venda como aproximação — melhor que nada,
   * mas superestima, então `temCusto` diz qual dos dois é este número.
   */
  custoUnitario: number
  temCusto: boolean
  valorEstimado: number
  /** Quem forneceu por último. null quando o histórico não traz ninguém. */
  fornecedorId: string | null
  fornecedorNome: string | null
  /** Os demais, para comparar preço na hora de decidir. Sem o principal. */
  outrosFornecedores: FornecedorAlternativo[]
  urgencia: Urgencia
  diasComVenda: number
  diasAnalisados: number
}

const ORDEM_DE_URGENCIA: Record<Urgencia, number> = {
  sem_estoque: 0,
  critico: 1,
  comprar: 2,
  ok: 3,
}

/**
 * A lista de compra da rede.
 *
 * Só entra produto com política calculada: sem histórico de venda não há consumo
 * médio, e um ponto de pedido inventado é pior que nenhum — alguém compraria em
 * cima dele. Produto novo aparece na lista depois do primeiro recálculo.
 */
export async function listaDeCompra(opcoes: { incluirSuficientes?: boolean } = {}) {
  const [politicas, saldos, transito, pedidos] = await Promise.all([
    db.politicaDeCompra.findMany(),
    saldosPorProdutoELoja(),
    saldosEmTransito(),
    saldosPedidos(),
  ])

  if (politicas.length === 0) return []

  const produtos = await db.produto.findMany({
    where: { id: { in: politicas.map((p) => p.produtoId) }, ativo: true },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const fornecimentos = await db.fornecimento.findMany({
    where: { produtoId: { in: produtos.map((p) => p.id) } },
  })
  const fornecedores = await db.fornecedor.findMany({
    where: { id: { in: [...new Set(fornecimentos.map((f) => f.fornecedorId))] } },
  })
  const nomeDoFornecedor = new Map(
    fornecedores.map((f) => [f.id, f.nomeFantasia || f.razaoSocial])
  )
  const fornecimentosPorProduto = new Map<string, typeof fornecimentos>()
  for (const f of fornecimentos) {
    if (!fornecimentosPorProduto.has(f.produtoId)) fornecimentosPorProduto.set(f.produtoId, [])
    fornecimentosPorProduto.get(f.produtoId)!.push(f)
  }

  const linhas: LinhaDeCompra[] = []

  for (const politica of politicas) {
    const produto = porId.get(politica.produtoId)
    // Produto desativado depois do último cálculo: a política sobrevive ao
    // cadastro, mas não faz sentido sugerir compra do que saiu do catálogo.
    if (!produto) continue

    const porLojaMapa = saldos.get(politica.produtoId) ?? new Map<string, number>()
    const porLoja = Object.fromEntries(porLojaMapa)
    const estoque = [...porLojaMapa.values()].reduce((soma, v) => soma + v, 0)
    const emTransito = transito.get(politica.produtoId) ?? 0
    const emPedido = pedidos.get(politica.produtoId) ?? 0

    const situacao = urgencia(politica, estoque)
    if (situacao === "ok" && !opcoes.incluirSuficientes) continue

    // O pedido conta como estoque a caminho pela mesma razão que a transferência
    // conta: já foi comprometido, e sem descontar os dois a lista sugeriria
    // comprar de novo o que já está encomendado.
    const comprar = quantoComprar(politica, estoque, emTransito + emPedido)

    const doProduto = (fornecimentosPorProduto.get(produto.id) ?? [])
      .slice()
      .sort((a, b) => (a.principal ? -1 : b.principal ? 1 : 0))
    const principal = doProduto.find((f) => f.principal) ?? doProduto[0] ?? null
    const outros = doProduto
      .filter((f) => f !== principal)
      .map((f) => ({
        fornecedorId: f.fornecedorId,
        nome: nomeDoFornecedor.get(f.fornecedorId) ?? "—",
        custo: f.ultimoCusto,
        ultimaCompra: f.ultimaCompra,
      }))

    const temCusto = principal !== null
    const custoUnitario = principal?.ultimoCusto ?? produto.preco

    linhas.push({
      produtoId: politica.produtoId,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      preco: produto.preco,
      estoque,
      emTransito,
      emPedido,
      porLoja,
      consumoMedioDiario: politica.consumoMedioDiario,
      estoqueMinimo: politica.estoqueMinimo,
      pontoDePedido: politica.pontoDePedido,
      comprar,
      diasRestantes: diasDeCobertura(politica.consumoMedioDiario, estoque),
      custoUnitario,
      temCusto,
      valorEstimado: comprar * custoUnitario,
      fornecedorId: principal?.fornecedorId ?? null,
      fornecedorNome: principal ? (nomeDoFornecedor.get(principal.fornecedorId) ?? "—") : null,
      outrosFornecedores: outros,
      urgencia: situacao,
      diasComVenda: politica.diasComVenda,
      diasAnalisados: politica.diasAnalisados,
    })
  }

  // Quem precisa primeiro aparece primeiro; dentro da mesma urgência, o que
  // acaba antes. Ordenar por valor poria o item caro na frente do que falta.
  //
  // O terceiro critério existe por causa dos zerados: todos têm zero dias de
  // cobertura, então sem ele o item que sai uma vez por mês dividiria o topo da
  // lista com o que sai trinta por dia. Quem gira mais primeiro.
  linhas.sort((a, b) => {
    const porUrgencia = ORDEM_DE_URGENCIA[a.urgencia] - ORDEM_DE_URGENCIA[b.urgencia]
    if (porUrgencia !== 0) return porUrgencia
    const porDias = (a.diasRestantes ?? Infinity) - (b.diasRestantes ?? Infinity)
    if (porDias !== 0) return porDias
    return b.consumoMedioDiario - a.consumoMedioDiario
  })

  return linhas
}

/** Quando a política foi calculada e sobre quantos dias — o rodapé da tela. */
export async function origemDaPolitica() {
  const uma = await db.politicaDeCompra.findFirst({
    orderBy: { calculadoEm: "desc" },
    select: { calculadoEm: true, diasAnalisados: true },
  })
  const total = await db.politicaDeCompra.count()
  return uma ? { ...uma, produtos: total } : null
}

/**
 * Grava a política de um lote de produtos, substituindo a anterior.
 *
 * É um recálculo inteiro, não um acréscimo: quem sai do histórico precisa perder
 * a política junto, senão um produto que parou de vender guarda para sempre o
 * consumo do ano passado e continua sendo comprado.
 */
export async function gravarPoliticas(
  consumos: Map<string, Consumo>,
  { apagarAusentes = true } = {}
) {
  const calculadoEm = new Date()
  let gravadas = 0

  for (const [produtoId, consumo] of consumos) {
    const politica = calcularPolitica(consumo)
    const dados = {
      ...politica,
      calculadoEm,
      diasAnalisados: consumo.dias,
      diasComVenda: consumo.diasComVenda,
      vendidoNoPeriodo: consumo.vendido,
    }
    await db.politicaDeCompra.upsert({
      where: { produtoId },
      create: { produtoId, ...dados },
      update: dados,
    })
    gravadas++
  }

  let apagadas = 0
  if (apagarAusentes) {
    const fora = await db.politicaDeCompra.deleteMany({
      where: { produtoId: { notIn: [...consumos.keys()] } },
    })
    apagadas = fora.count
  }

  return { gravadas, apagadas }
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/** Uma linha do histórico: mercadoria que chegou, com o documento que a trouxe. */
export type CompraDoProduto = {
  id: string
  em: Date
  loja: string
  quantidade: number
  /** null na entrada avulsa, digitada no estoque sem documento de compra. */
  custoUnitario: number | null
  /**
   * De onde saiu o custo, porque nem todo custo é o mesmo tipo de número:
   * "nota" e "af" são o que o fornecedor cobrou; "pedido" é só o que se
   * esperava pagar — a entrada simples pelo pedido não passa por nota.
   */
  origemDoCusto: "nota" | "af" | "pedido" | null
  fornecedorId: string | null
  fornecedorNome: string | null
  documento: { tipo: "pedido" | "af" | "nfe"; numero: string; id: string } | null
}

/** O que ainda não chegou: pedido em aberto com este produto dentro. */
export type PedidoDoProduto = {
  id: string
  numero: number
  em: Date
  situacao: string
  fornecedorId: string
  fornecedorNome: string
  quantidade: number
  custoUnitario: number
  entregaPrometida: Date | null
}

/** Um fornecedor deste produto, com o acumulado das duas fontes. */
export type FornecedorDoProduto = {
  fornecedorId: string
  nome: string
  /** O de sempre deste produto — quem forneceu por último no histórico antigo. */
  principal: boolean
  ultimoCusto: number | null
  ultimaCompra: Date | null
  quantidadeTotal: number
  compras: number
}

/**
 * De quem já se comprou este produto, por quanto e quando.
 *
 * Duas fontes que não se sobrepõem, somadas de propósito:
 *
 * 1. `Fornecimento` — o histórico do sistema antigo, recalculado pelo
 *    importador a partir do CSV de compras. É o que responde "quem vende isto"
 *    para os anos anteriores a este sistema.
 * 2. Os documentos daqui — entrada por NF-e conciliada, AF e recebimento de
 *    pedido. É o que aconteceu desde que o sistema entrou no ar.
 *
 * Somar as duas não conta nada duas vezes porque o CSV do importador é do
 * sistema antigo: o que entrou por aqui nunca esteve lá. O que a soma dá é a
 * resposta da conversa com o vendedor — "comprei 40 vezes de você, a última a
 * R$ 12,50" — sem obrigar quem olha a juntar dois números de telas diferentes.
 *
 * Rota de dados, chamada quando alguém abre o produto: carregar isto junto com
 * o catálogo traria o histórico de mil produtos para mostrar o de um.
 */
export async function historicoDeCompras(produtoId: string, { limite = 40 } = {}) {
  const vazio = {
    produto: null,
    fornecedores: [] as FornecedorDoProduto[],
    compras: [] as CompraDoProduto[],
    pedidosAbertos: [] as PedidoDoProduto[],
  }
  if (!OBJECT_ID.test(produtoId)) return vazio

  const [produto, fornecimentos, movimentos, pedidos] = await Promise.all([
    db.produto.findUnique({
      where: { id: produtoId },
      select: { id: true, codigo: true, descricao: true, unidade: true, preco: true },
    }),
    db.fornecimento.findMany({ where: { produtoId } }),
    db.movimentoEstoque.findMany({
      where: { produtoId, tipo: "entrada" },
      orderBy: { criadoEm: "desc" },
      take: limite,
    }),
    db.pedidoDeCompra.findMany({
      where: {
        itens: { some: { produtoId } },
        situacao: { in: ["rascunho", "enviado", "parcial"] },
      },
      orderBy: { criadoEm: "desc" },
    }),
  ])

  if (!produto) return vazio

  // Os documentos que as entradas citam, buscados de uma vez: são três tipos
  // possíveis por linha e uma consulta por linha faria dezenas de idas ao banco
  // para montar uma tabela de quarenta.
  const [pedidosCitados, afs, notas] = await Promise.all([
    buscarPorIds(movimentos.map((m) => m.pedidoDeCompraId), (ids) =>
      db.pedidoDeCompra.findMany({
        where: { id: { in: ids } },
        select: { id: true, numero: true, fornecedorId: true, fornecedorNome: true, itens: true },
      })
    ),
    buscarPorIds(movimentos.map((m) => m.autorizacaoFaturamentoId), (ids) =>
      db.autorizacaoDeFaturamento.findMany({
        where: { id: { in: ids } },
        select: { id: true, numero: true, fornecedorId: true, fornecedorNome: true },
      })
    ),
    buscarPorIds(movimentos.map((m) => m.notaFiscalRecebidaId), (ids) =>
      db.notaFiscalRecebida.findMany({
        where: { id: { in: ids } },
        select: { id: true, numero: true, emitenteCnpj: true, emitenteNome: true },
      })
    ),
  ])

  // A nota guarda o CNPJ do emitente, não o id do fornecedor — é a SEFAZ que a
  // trouxe, e lá o cadastro daqui não existe. O documento é o que liga os dois.
  const cnpjs = [...new Set(notas.map((n) => n.emitenteCnpj).filter(Boolean))]
  const porDocumento = new Map(
    cnpjs.length === 0
      ? []
      : (
          await db.fornecedor.findMany({
            where: { documento: { in: cnpjs } },
            select: { id: true, documento: true, razaoSocial: true, nomeFantasia: true },
          })
        ).map((f) => [f.documento!, f])
  )

  const pedidoPorId = new Map(pedidosCitados.map((p) => [p.id, p]))
  const afPorId = new Map(afs.map((a) => [a.id, a]))
  const notaPorId = new Map(notas.map((n) => [n.id, n]))

  const compras: CompraDoProduto[] = movimentos.map((m) => {
    const pedido = m.pedidoDeCompraId ? pedidoPorId.get(m.pedidoDeCompraId) : null
    const af = m.autorizacaoFaturamentoId ? afPorId.get(m.autorizacaoFaturamentoId) : null
    const nota = m.notaFiscalRecebidaId ? notaPorId.get(m.notaFiscalRecebidaId) : null
    const doCadastro = nota?.emitenteCnpj ? porDocumento.get(nota.emitenteCnpj) : null

    // O custo esperado do pedido entra como último recurso: o recebimento
    // simples não passa por nota nenhuma e não grava custo no movimento, e um
    // traço ali esconderia o único número que existe sobre aquela compra.
    const doPedido = pedido?.itens.find((i) => i.produtoId === produtoId)?.custoUnitario ?? null
    const custoUnitario = m.custoUnitario ?? doPedido
    const origemDoCusto =
      m.custoUnitario != null ? (af ? "af" : "nota") : doPedido != null ? "pedido" : null

    // A nota manda quando existe: é o documento fiscal da entrada. O pedido vem
    // depois porque a nota pode ter sido emitida por outra empresa do grupo do
    // fornecedor, e é a quem se pagou que interessa.
    const fornecedorNome =
      nota?.emitenteNome ?? af?.fornecedorNome ?? pedido?.fornecedorNome ?? null
    const fornecedorId =
      doCadastro?.id ?? af?.fornecedorId ?? pedido?.fornecedorId ?? null

    const documento: CompraDoProduto["documento"] = nota
      ? { tipo: "nfe", numero: String(nota.numero ?? "?"), id: nota.id }
      : af
        ? { tipo: "af", numero: af.numero, id: af.id }
        : pedido
          ? { tipo: "pedido", numero: String(pedido.numero), id: pedido.id }
          : null

    return {
      id: m.id,
      em: m.criadoEm,
      loja: m.loja,
      quantidade: m.quantidade,
      custoUnitario,
      origemDoCusto: custoUnitario == null ? null : origemDoCusto,
      fornecedorId,
      fornecedorNome,
      documento,
    }
  })

  const pedidosAbertos: PedidoDoProduto[] = pedidos.flatMap((pedido) => {
    const item = pedido.itens.find((i) => i.produtoId === produtoId)
    if (!item) return []
    return [
      {
        id: pedido.id,
        numero: pedido.numero,
        em: pedido.criadoEm,
        situacao: pedido.situacao,
        fornecedorId: pedido.fornecedorId,
        fornecedorNome: pedido.fornecedorNome,
        quantidade: item.quantidade,
        custoUnitario: item.custoUnitario,
        entregaPrometida: pedido.entregaPrometida,
      },
    ]
  })

  const nomes = await nomesDeFornecedores([
    ...fornecimentos.map((f) => f.fornecedorId),
    ...compras.map((c) => c.fornecedorId),
  ])

  const porFornecedor = new Map<string, FornecedorDoProduto>()

  for (const f of fornecimentos) {
    porFornecedor.set(f.fornecedorId, {
      fornecedorId: f.fornecedorId,
      nome: nomes.get(f.fornecedorId) ?? "—",
      principal: f.principal,
      ultimoCusto: f.ultimoCusto,
      ultimaCompra: f.ultimaCompra,
      quantidadeTotal: f.quantidadeTotal,
      compras: f.compras,
    })
  }

  // As entradas daqui, da mais antiga para a mais recente: assim a última que o
  // laço vê é a última compra de verdade, e é o custo dela que fica.
  for (const compra of [...compras].reverse()) {
    if (!compra.fornecedorId) continue
    const atual = porFornecedor.get(compra.fornecedorId) ?? {
      fornecedorId: compra.fornecedorId,
      nome: compra.fornecedorNome ?? nomes.get(compra.fornecedorId) ?? "—",
      principal: false,
      ultimoCusto: null,
      ultimaCompra: null,
      quantidadeTotal: 0,
      compras: 0,
    }
    atual.quantidadeTotal = arredondar(atual.quantidadeTotal + compra.quantidade)
    atual.compras += 1
    if (!atual.ultimaCompra || compra.em > atual.ultimaCompra) {
      atual.ultimaCompra = compra.em
      // O custo só troca junto com a data: entrada sem custo não pode apagar o
      // último preço conhecido, que é justamente o que se leva para negociar.
      if (compra.custoUnitario != null) atual.ultimoCusto = compra.custoUnitario
    }
    porFornecedor.set(compra.fornecedorId, atual)
  }

  const fornecedores = [...porFornecedor.values()].sort((a, b) => {
    if (a.principal !== b.principal) return a.principal ? -1 : 1
    return (b.ultimaCompra?.getTime() ?? 0) - (a.ultimaCompra?.getTime() ?? 0)
  })

  return { produto, fornecedores, compras, pedidosAbertos }
}

/** Só consulta se houver id para consultar — `in: []` é uma ida ao banco à toa. */
async function buscarPorIds<T>(
  ids: (string | null)[],
  consulta: (ids: string[]) => Promise<T[]>
): Promise<T[]> {
  const limpos = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  return limpos.length === 0 ? [] : consulta(limpos)
}

async function nomesDeFornecedores(ids: (string | null)[]) {
  const fornecedores = await buscarPorIds(ids, (limpos) =>
    db.fornecedor.findMany({
      where: { id: { in: limpos } },
      select: { id: true, razaoSocial: true, nomeFantasia: true },
    })
  )
  return new Map(fornecedores.map((f) => [f.id, f.nomeFantasia || f.razaoSocial]))
}

/**
 * O último custo conhecido de cada produto, das duas fontes que o sistema tem.
 *
 * Mesma junção de `historicoDeCompras`, reduzida a um número por produto: o
 * histórico importado (`Fornecimento`) responde pelos anos anteriores, e as
 * entradas com custo daqui — NF-e conciliada e AF — pelo que veio depois. Vence
 * a mais recente das duas, porque custo velho não é custo.
 *
 * Produto sem nenhuma das duas fica FORA do mapa, e não com zero: zero é um
 * preço, e quem chama precisa poder distinguir "custa nada" de "não se sabe".
 */
export async function ultimoCustoPorProduto(
  produtoIds: string[],
  /**
   * Custo conhecido ATÉ esta data — para valorizar um inventário do passado
   * pelo que a mercadoria custava então, e não pela nota que chegou depois.
   */
  ate?: Date | null
): Promise<Map<string, number>> {
  const ids = [...new Set(produtoIds)]
  if (ids.length === 0) return new Map()

  const [fornecimentos, entradas] = await Promise.all([
    db.fornecimento.findMany({
      where: {
        produtoId: { in: ids },
        ...(ate ? { ultimaCompra: { lte: ate } } : {}),
      },
      select: { produtoId: true, ultimoCusto: true, ultimaCompra: true },
    }),
    db.movimentoEstoque.findMany({
      where: {
        produtoId: { in: ids },
        tipo: "entrada",
        custoUnitario: { not: null },
        ...(ate ? { criadoEm: { lte: ate } } : {}),
      },
      orderBy: { criadoEm: "asc" },
      select: { produtoId: true, custoUnitario: true, criadoEm: true },
    }),
  ])

  const mapa = new Map<string, { custo: number; em: Date }>()

  const considerar = (produtoId: string, custo: number | null, em: Date) => {
    if (custo == null || !(custo > 0)) return
    const atual = mapa.get(produtoId)
    if (!atual || em > atual.em) mapa.set(produtoId, { custo, em })
  }

  for (const f of fornecimentos) considerar(f.produtoId, f.ultimoCusto, f.ultimaCompra)
  for (const e of entradas) considerar(e.produtoId, e.custoUnitario, e.criadoEm)

  return new Map([...mapa].map(([id, { custo }]) => [id, custo]))
}
