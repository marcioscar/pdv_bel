import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"

export type TipoMovimento =
  | "venda"
  | "entrada"
  | "ajuste"
  | "estorno"
  /** Saída da loja de origem, no momento em que a carga é despachada. */
  | "transferencia_saida"
  /**
   * Entrada no destino, do que foi CONFERIDO na chegada — não do que saiu.
   *
   * A diferença entre os dois não precisa de lançamento próprio: uma saída de 10
   * sem a entrada correspondente de 10 já É a perda, e o saldo da rede cai
   * sozinho. Quem assumiu o buraco fica registrado no documento da transferência.
   */
  | "transferencia_entrada"

/**
 * Saldo por produto, somado do livro de movimentos. Não existe estoque guardado
 * em lugar nenhum: esta soma é a única resposta, então não há drift possível.
 *
 * É uma agregação única sobre `movimentos_estoque` (indexado por produtoId), não
 * uma consulta por produto. Se o volume de movimentos crescer ao ponto de pesar,
 * o caminho é materializar o saldo num campo mantido junto do movimento — sem
 * mudar o livro, que continua sendo a verdade.
 */
export async function saldosPorProduto(loja: string): Promise<Map<string, number>> {
  const grupos = await db.movimentoEstoque.groupBy({
    by: ["produtoId"],
    where: { loja },
    _sum: { quantidade: true },
  })

  return new Map(
    grupos.map((grupo) => [grupo.produtoId, arredondar(grupo._sum.quantidade ?? 0)])
  )
}

/**
 * Saldo de cada produto em CADA loja, numa consulta só.
 *
 * É a base da consulta consolidada: `Map<produtoId, Map<loja, saldo>>`. Um banco
 * único é o que torna isto uma agregação em vez de quatro conexões e uma junção
 * na aplicação.
 */
export async function saldosPorProdutoELoja(): Promise<Map<string, Map<string, number>>> {
  const grupos = await db.movimentoEstoque.groupBy({
    by: ["produtoId", "loja"],
    _sum: { quantidade: true },
  })

  const mapa = new Map<string, Map<string, number>>()
  for (const grupo of grupos) {
    if (!mapa.has(grupo.produtoId)) mapa.set(grupo.produtoId, new Map())
    mapa.get(grupo.produtoId)!.set(grupo.loja, arredondar(grupo._sum.quantidade ?? 0))
  }
  return mapa
}

export async function saldoDoProduto(produtoId: string, loja: string): Promise<number> {
  const soma = await db.movimentoEstoque.aggregate({
    where: { produtoId, loja },
    _sum: { quantidade: true },
  })
  return arredondar(soma._sum.quantidade ?? 0)
}

export type MovimentoDeVenda = {
  produtoId: string
  quantidade: number
}

/**
 * Movimentos de uma venda: quantidade negativa, porque é saída. Recebe o client
 * da transação para que a venda e suas baixas caiam juntas ou não caiam.
 */
export function movimentosDeVenda(
  itens: MovimentoDeVenda[],
  venda: { id: string; numero: number; loja: string },
  operador: string
) {
  return itens.map((item) => ({
    produtoId: item.produtoId,
    loja: venda.loja,
    tipo: "venda" satisfies TipoMovimento,
    quantidade: -item.quantidade,
    operador,
    vendaId: venda.id,
    vendaNumero: venda.numero,
  }))
}

export type ResultadoCancelamento =
  | { ok: true; numero: number; estornados: number }
  | { ok: false; erro: string }

/**
 * Cancela uma venda: marca o documento e grava um movimento oposto para cada
 * baixa dela. Nada é apagado nem reescrito — o histórico continua contando o que
 * aconteceu, inclusive o cancelamento.
 *
 * A marca e os estornos caem na mesma transação; e a marca é gravada com a
 * condição de ainda estar nula, para dois cliques simultâneos não estornarem
 * duas vezes.
 */
export async function cancelarVenda(
  vendaId: string,
  loja: string,
  operador: string
): Promise<ResultadoCancelamento> {
  const venda = await db.venda.findUnique({ where: { id: vendaId } })
  if (!venda) return { ok: false, erro: "Venda não encontrada" }
  // Cancelar venda de outra loja mexeria em faturamento e estoque que não são
  // desta operação. O id da venda é único na rede, então a checagem é necessária.
  if (venda.loja !== loja) {
    return { ok: false, erro: `Venda #${venda.numero} é da loja ${venda.loja}` }
  }
  if (venda.canceladaEm) return { ok: false, erro: `Venda #${venda.numero} já cancelada` }

  const originais = await db.movimentoEstoque.findMany({
    where: { vendaId, tipo: "venda" },
  })

  try {
    return await db.$transaction(async (tx) => {
      const marcadas = await tx.venda.updateMany({
        // `canceladaEm: null` sozinho não casa: numa venda nunca cancelada o
        // campo está AUSENTE do documento, e ausente não é null para o Mongo.
        // O OR cobre os dois estados.
        where: {
          id: vendaId,
          OR: [{ canceladaEm: null }, { canceladaEm: { isSet: false } }],
        },
        data: { canceladaEm: new Date(), canceladaPor: operador },
      })
      // Outra requisição cancelou entre a leitura e a transação.
      if (marcadas.count === 0) {
        throw new Error(`Venda #${venda.numero} já cancelada`)
      }

      if (originais.length > 0) {
        await tx.movimentoEstoque.createMany({
          data: originais.map((movimento) => ({
            produtoId: movimento.produtoId,
            // A mesma loja do movimento original: estorno em loja diferente
            // criaria estoque numa e apagaria noutra.
            loja: movimento.loja,
            tipo: "estorno" satisfies TipoMovimento,
            quantidade: -movimento.quantidade,
            operador,
            vendaId: movimento.vendaId,
            vendaNumero: movimento.vendaNumero,
            observacao: `Cancelamento da venda #${movimento.vendaNumero}`,
          })),
        })
      }

      return { ok: true as const, numero: venda.numero, estornados: originais.length }
    })
  } catch (erro) {
    if (erro instanceof Error && erro.message.includes("já cancelada")) {
      return { ok: false, erro: erro.message }
    }
    throw erro
  }
}

/** Entrada de mercadoria: soma ao saldo. */
export async function registrarEntrada(
  produtoId: string,
  loja: string,
  quantidade: number,
  operador: string,
  observacao?: string
) {
  return db.movimentoEstoque.create({
    data: {
      produtoId,
      loja,
      tipo: "entrada" satisfies TipoMovimento,
      quantidade: arredondar(quantidade),
      operador,
      observacao,
    },
  })
}

/**
 * Inventário: o operador informa o saldo que existe de fato na prateleira, e o
 * movimento gravado é a diferença até ele. Assim o livro continua sendo só uma
 * soma, sem nenhum lançamento que "zere" o histórico.
 */
export async function registrarAjuste(
  produtoId: string,
  loja: string,
  saldoContado: number,
  operador: string,
  observacao?: string
) {
  const atual = await saldoDoProduto(produtoId, loja)
  const diferenca = arredondar(saldoContado - atual)

  if (diferenca === 0) return { movimento: null, diferenca: 0, saldo: atual }

  const movimento = await db.movimentoEstoque.create({
    data: {
      produtoId,
      loja,
      tipo: "ajuste" satisfies TipoMovimento,
      quantidade: diferenca,
      operador,
      observacao: observacao ?? `Inventário: contado ${saldoContado}, havia ${atual}`,
    },
  })

  return { movimento, diferenca, saldo: saldoContado }
}

/** Últimos lançamentos, para a tela de estoque mostrar o que acabou de entrar. */
export async function movimentosRecentes(loja: string, limite = 40) {
  const movimentos = await db.movimentoEstoque.findMany({
    where: { loja },
    orderBy: { criadoEm: "desc" },
    take: limite,
  })

  const produtos = await db.produto.findMany({
    where: { id: { in: [...new Set(movimentos.map((m) => m.produtoId))] } },
    select: { id: true, codigo: true, descricao: true, unidade: true },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  return movimentos.map((movimento) => ({
    id: movimento.id,
    criadoEm: movimento.criadoEm,
    tipo: movimento.tipo,
    quantidade: movimento.quantidade,
    operador: movimento.operador,
    vendaNumero: movimento.vendaNumero,
    observacao: movimento.observacao,
    codigo: porId.get(movimento.produtoId)?.codigo ?? "—",
    descricao: porId.get(movimento.produtoId)?.descricao ?? "(produto removido)",
    unidade: porId.get(movimento.produtoId)?.unidade ?? "",
  }))
}
