import { ultimoCustoPorProduto } from "~/lib/compras.server"
import { db } from "~/lib/db.server"
import { saldosPorProdutoELoja } from "~/lib/estoque.server"
import { arredondar } from "~/lib/moeda"

export type LinhaInventario = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  grupoNome: string | null
  ativo: boolean
  /** Saldo em cada loja pedida — a consolidação não pode esconder onde está. */
  porLoja: Record<string, number>
  quantidade: number
  /** Último custo de compra. Nulo quando nunca se comprou o produto por aqui. */
  custo: number | null
  preco: number
  /** Quantidade × custo. Nulo quando não há custo — não vale zero. */
  valorCusto: number | null
  valorVenda: number
}

export type Inventario = {
  linhas: LinhaInventario[]
  lojas: string[]
  totais: {
    itens: number
    unidades: number
    valorCusto: number
    valorVenda: number
    /** Quantos produtos com saldo não têm custo conhecido, e quanto valem a preço de venda. */
    semCusto: number
    semCustoValorVenda: number
    negativos: number
    zerados: number
  }
}

/**
 * O que existe na prateleira, e quanto vale.
 *
 * O saldo é somado do livro de movimentos, como em todo o resto do sistema: não
 * há estoque guardado em campo nenhum, então não há como o relatório divergir
 * do que a ficha do produto mostra.
 *
 * **O valor de custo é o ÚLTIMO custo de compra, não o custo médio.** A rede
 * nunca guardou custo médio — o que existe é o preço da última nota, por
 * produto e por fornecedor. Num período de reajuste isso avalia o estoque velho
 * pelo preço novo, e o relatório precisa dizer isso em voz alta em vez de
 * apresentar um número que parece contábil.
 *
 * **Produto sem custo conhecido não vira custo zero.** Zero somaria ao total
 * como se a mercadoria fosse de graça e ninguém veria a lacuna. Ele fica com
 * `valorCusto: null`, e a contagem do que ficou de fora vai no resumo.
 *
 * Saldo negativo entra, e é contado à parte. Negativo é sintoma — venda lançada
 * antes da entrada, transferência recebida que ninguém conferiu — e esconder a
 * linha esconderia justamente o que precisa de conserto.
 */
export async function inventarioValorizado(lojas: string[]): Promise<Inventario> {
  const [produtos, porProdutoELoja, grupos] = await Promise.all([
    db.produto.findMany({
      select: {
        id: true,
        codigo: true,
        descricao: true,
        unidade: true,
        preco: true,
        grupoId: true,
        ativo: true,
      },
    }),
    saldosPorProdutoELoja(),
    db.grupoDeProduto.findMany({ select: { id: true, nome: true } }),
  ])

  const nomeDoGrupo = new Map(grupos.map((g) => [g.id, g.nome]))
  const custos = await ultimoCustoPorProduto(produtos.map((p) => p.id))

  let zerados = 0
  const linhas: LinhaInventario[] = []

  for (const produto of produtos) {
    const daLoja = porProdutoELoja.get(produto.id) ?? new Map<string, number>()

    const porLoja: Record<string, number> = {}
    let quantidade = 0
    for (const loja of lojas) {
      const saldo = daLoja.get(loja) ?? 0
      porLoja[loja] = saldo
      quantidade += saldo
    }

    /*
     * Saldo zero fica de fora: o catálogo tem 1.132 produtos e a prateleira tem
     * algumas centenas. Listar o que não existe é encher o relatório de linhas
     * que valem zero e afogar o que vale dinheiro. A contagem vai no resumo,
     * para ninguém achar que o catálogo encolheu.
     */
    quantidade = arredondar(quantidade)
    if (quantidade === 0) {
      zerados++
      continue
    }

    const custo = custos.get(produto.id) ?? null

    linhas.push({
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      grupoNome: produto.grupoId ? (nomeDoGrupo.get(produto.grupoId) ?? null) : null,
      ativo: produto.ativo,
      porLoja,
      quantidade,
      custo,
      preco: produto.preco,
      valorCusto: custo === null ? null : arredondar(quantidade * custo),
      valorVenda: arredondar(quantidade * produto.preco),
    })
  }

  // O que vale mais dinheiro primeiro. Quem não tem custo é ordenado pelo valor
  // de venda, senão iria todo para o fim como se não valesse nada.
  linhas.sort((a, b) => (b.valorCusto ?? b.valorVenda) - (a.valorCusto ?? a.valorVenda))

  const comCusto = linhas.filter((l) => l.valorCusto !== null)
  const semCusto = linhas.filter((l) => l.valorCusto === null)

  return {
    linhas,
    lojas,
    totais: {
      itens: linhas.length,
      unidades: arredondar(linhas.reduce((s, l) => s + l.quantidade, 0)),
      valorCusto: arredondar(comCusto.reduce((s, l) => s + (l.valorCusto ?? 0), 0)),
      valorVenda: arredondar(linhas.reduce((s, l) => s + l.valorVenda, 0)),
      semCusto: semCusto.length,
      semCustoValorVenda: arredondar(semCusto.reduce((s, l) => s + l.valorVenda, 0)),
      negativos: linhas.filter((l) => l.quantidade < 0).length,
      zerados,
    },
  }
}
