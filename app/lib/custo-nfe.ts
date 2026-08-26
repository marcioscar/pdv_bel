/**
 * O custo real de compra, a partir do que a NF-e do fornecedor cobra — pensado
 * para quem é optante do Simples Nacional: não existe crédito de ICMS, IPI,
 * PIS ou COFINS a abater depois, então tudo que a nota lança vira custo de
 * aquisição, direto.
 *
 * O ICMS "normal" NÃO entra na soma: ele já vem embutido no preço negociado
 * (`vUnCom`/`vProd`) — somar de novo contaria o mesmo imposto duas vezes. O
 * que soma por fora é só o que a nota destaca como adicional: IPI e ICMS-ST
 * por item, e frete/seguro/outras despesas que ela lança apenas no total (sem
 * abrir por item, porque a maioria dos fornecedores não abre).
 *
 * Sem abertura por item, a única forma honesta de dividir essas despesas é
 * proporcional ao peso de cada item no valor da nota — não tem informação
 * melhor que essa para ratear o que o fornecedor não detalhou.
 */

export type ItemDaNotaComImposto = {
  codigo: string | null
  descricao: string | null
  quantidade: number | null
  valorUnitario: number | null
  valorTotal: number | null
  /** Somam por fora do valor do produto. */
  vIPI: number
  vICMSST: number
}

export type NotaParaCusto = {
  vFrete: number
  vSeg: number
  vOutro: number
  vDesc: number
  itens: ItemDaNotaComImposto[]
}

export type ItemComCustoReal = {
  codigo: string | null
  descricao: string | null
  quantidade: number
  valorUnitario: number
  /** IPI + ICMS-ST deste item, por unidade. */
  impostoPorUnidade: number
  /** Frete/seguro/outras despesas da nota, rateados por este item, por unidade. */
  rateioPorUnidade: number
  custoUnitarioReal: number
  custoTotalReal: number
}

export function calcularCustoReal(nota: NotaParaCusto): ItemComCustoReal[] {
  const somaProdutos = nota.itens.reduce((soma, item) => soma + (item.valorTotal ?? 0), 0)
  // Desconto reduz o que se rateia; frete/seguro/outras despesas aumentam.
  const despesasARatear = nota.vFrete + nota.vSeg + nota.vOutro - nota.vDesc

  return nota.itens.map((item) => {
    const quantidade = item.quantidade ?? 0
    const valorTotalItem = item.valorTotal ?? 0
    const impostoItem = item.vIPI + item.vICMSST
    // Sem produtos na nota (não deveria acontecer) não há como ratear —
    // melhor zero do que dividir por zero.
    const participacao = somaProdutos > 0 ? valorTotalItem / somaProdutos : 0
    const rateioItem = despesasARatear * participacao

    const custoTotalReal = valorTotalItem + impostoItem + rateioItem
    const custoUnitarioReal = quantidade > 0 ? custoTotalReal / quantidade : custoTotalReal

    return {
      codigo: item.codigo,
      descricao: item.descricao,
      quantidade,
      valorUnitario: item.valorUnitario ?? 0,
      impostoPorUnidade: quantidade > 0 ? impostoItem / quantidade : 0,
      rateioPorUnidade: quantidade > 0 ? rateioItem / quantidade : 0,
      custoUnitarioReal,
      custoTotalReal,
    }
  })
}
