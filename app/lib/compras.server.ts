import { db } from "~/lib/db.server"
import { saldosPorProdutoELoja } from "~/lib/estoque.server"
import { saldosEmTransito } from "~/lib/transferencias.server"
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
  const [politicas, saldos, transito] = await Promise.all([
    db.politicaDeCompra.findMany(),
    saldosPorProdutoELoja(),
    saldosEmTransito(),
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

    const situacao = urgencia(politica, estoque)
    if (situacao === "ok" && !opcoes.incluirSuficientes) continue

    const comprar = quantoComprar(politica, estoque, emTransito)

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
