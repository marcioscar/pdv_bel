import { db } from "~/lib/db.server"
import { calcularCustoReal, type ItemComCustoReal } from "~/lib/custo-nfe"
import { resumoDoProcNFe } from "~/lib/sefaz.server"

/**
 * Conciliar um pedido de compra com a NF-e que o fornecedor realmente emitiu —
 * o que foi pedido pode não ser exatamente o que veio (preço, quantidade,
 * itens a mais ou a menos), e é a nota que manda no que se paga.
 */

/** Os CNPJs de emitente que já têm pelo menos uma nota completa sincronizada. */
export async function cnpjsComNotaCompleta(): Promise<Set<string>> {
  const linhas = await db.notaFiscalRecebida.findMany({
    where: { situacaoXml: "completa" },
    select: { emitenteCnpj: true },
    distinct: ["emitenteCnpj"],
  })
  return new Set(linhas.map((l) => l.emitenteCnpj))
}

/**
 * Quais destes pedidos já têm nota completa do próprio fornecedor disponível
 * para conciliar — é o que decide se o "Receber" simples (quantidade
 * esperada) deve ficar desabilitado a favor da conciliação (quantidade e
 * custo reais). Duas entradas para o mesmo pedido duplicariam o estoque.
 */
export async function pedidosComNotaDisponivel(
  pedidos: { id: string; fornecedorId: string }[]
): Promise<Set<string>> {
  if (pedidos.length === 0) return new Set()

  const [cnpjs, fornecedores] = await Promise.all([
    cnpjsComNotaCompleta(),
    db.fornecedor.findMany({
      where: { id: { in: [...new Set(pedidos.map((p) => p.fornecedorId))] } },
      select: { id: true, documento: true },
    }),
  ])
  const documentoPorFornecedor = new Map(fornecedores.map((f) => [f.id, f.documento]))

  const resultado = new Set<string>()
  for (const pedido of pedidos) {
    const documento = documentoPorFornecedor.get(pedido.fornecedorId)
    if (documento && cnpjs.has(documento)) resultado.add(pedido.id)
  }
  return resultado
}

/** As notas completas (com itens) do mesmo fornecedor do pedido — candidatas a serem a nota dele. */
export async function notasCandidatasDoPedido(pedidoId: string) {
  const pedido = await db.pedidoDeCompra.findUnique({ where: { id: pedidoId } })
  if (!pedido) return { pedido: null, fornecedor: null, notas: [] }

  const fornecedor = await db.fornecedor.findUnique({ where: { id: pedido.fornecedorId } })
  // Sem documento cadastrado não tem contra o que comparar — onze fornecedores
  // estão nessa situação (ver comentário em `Fornecedor.documento`).
  if (!fornecedor?.documento) return { pedido, fornecedor, notas: [] }

  const notas = await db.notaFiscalRecebida.findMany({
    where: { emitenteCnpj: fornecedor.documento, situacaoXml: "completa" },
    orderBy: { dataEmissao: "desc" },
  })

  return { pedido, fornecedor, notas }
}

export type ItemDaNotaParaConciliar = ItemComCustoReal & { ean: string | null; ncm: string | null }

/** O custo real de cada item de uma nota já sincronizada, pronto para comparar com o pedido. */
export function itensComCustoDaNota(xml: string): ItemDaNotaParaConciliar[] {
  const resumo = resumoDoProcNFe(xml)
  if (!resumo) return []

  const comCusto = calcularCustoReal(resumo)
  return comCusto.map((item, i) => ({
    ...item,
    ean: resumo.itens[i]?.ean ?? null,
    ncm: resumo.itens[i]?.ncm ?? null,
  }))
}

export type ItemReconciliado = { produtoId: string; quantidade: number; custoUnitario: number }

export type ResultadoReceberComNota =
  | { ok: true; situacao: "recebido" | "parcial" }
  | { ok: false; erro: string }

/**
 * Recebe o pedido usando a quantidade e o custo REAIS da nota conciliada, em
 * vez do esperado — a versão de `marcarRecebido` (`pedidos-compra.server.ts`)
 * para quando existe a NF-e de verdade para comparar.
 *
 * Aceita entrega parcial de propósito: o fornecedor manda o que tem pronto,
 * não o pedido inteiro de uma vez. O que falta continua "parcial", esperando
 * a próxima nota — o quanto já chegou é sempre derivado do `MovimentoEstoque`
 * deste pedido, nunca um contador à parte que pudesse ficar defasado.
 *
 * Recusa lançar de novo os produtos que ESTA MESMA nota já lançou para este
 * pedido — protege contra reprocessar a nota por engano, sem impedir que uma
 * segunda nota complete o que falta.
 */
export async function receberComNota(
  pedidoId: string,
  notaId: string,
  loja: string,
  operador: string,
  itens: ItemReconciliado[]
): Promise<ResultadoReceberComNota> {
  const pedido = await db.pedidoDeCompra.findUnique({ where: { id: pedidoId } })
  if (!pedido) return { ok: false, erro: "Pedido não encontrado" }
  if (pedido.situacao !== "enviado" && pedido.situacao !== "parcial") {
    return { ok: false, erro: "Só um pedido enviado ou parcial pode receber mercadoria" }
  }
  if (!loja) return { ok: false, erro: "Escolha a loja que recebeu a mercadoria" }

  const nota = await db.notaFiscalRecebida.findUnique({ where: { id: notaId } })
  if (!nota) return { ok: false, erro: "Nota não encontrada" }

  // Item da nota pode ser produto que não estava no pedido — o fornecedor
  // mandou algo a mais, ou o produto acabou de ser cadastrado aqui na
  // conciliação. Entra no estoque igual; o que ele não faz é contar para
  // fechar o pedido (isso é `completo`, mais abaixo, que só olha o pedido).
  const produtosValidos = await db.produto.findMany({
    where: { id: { in: itens.map((i) => i.produtoId) } },
    select: { id: true },
  })
  const idsValidos = new Set(produtosValidos.map((p) => p.id))
  const invalido = itens.find((i) => i.quantidade > 0 && !idsValidos.has(i.produtoId))
  if (invalido) return { ok: false, erro: "Produto não encontrado no catálogo" }

  const lancadosPorEstaNota = await db.movimentoEstoque.findMany({
    where: { pedidoDeCompraId: pedidoId, notaFiscalRecebidaId: notaId },
    select: { produtoId: true },
  })
  const jaLancadosPorEstaNota = new Set(lancadosPorEstaNota.map((m) => m.produtoId))

  const itensParaGravar = itens.filter(
    (item) => item.quantidade > 0 && !jaLancadosPorEstaNota.has(item.produtoId)
  )
  if (itensParaGravar.length === 0) {
    return {
      ok: false,
      erro: "Nada para lançar — pareie ao menos um item que esta nota ainda não lançou",
    }
  }

  const recebidoAntes = await db.movimentoEstoque.findMany({
    where: { pedidoDeCompraId: pedidoId, tipo: "entrada" },
    select: { produtoId: true, quantidade: true },
  })
  const totalAntesPorProduto = new Map<string, number>()
  for (const m of recebidoAntes) {
    totalAntesPorProduto.set(m.produtoId, (totalAntesPorProduto.get(m.produtoId) ?? 0) + m.quantidade)
  }

  const completo = pedido.itens.every((item) => {
    const desteEnvio = itensParaGravar.find((i) => i.produtoId === item.produtoId)?.quantidade ?? 0
    const total = (totalAntesPorProduto.get(item.produtoId) ?? 0) + desteEnvio
    return total >= item.quantidade - 0.001
  })
  const situacaoFinal = completo ? "recebido" : "parcial"

  await db.$transaction(async (tx) => {
    await tx.movimentoEstoque.createMany({
      data: itensParaGravar.map((item) => ({
        produtoId: item.produtoId,
        loja,
        tipo: "entrada",
        quantidade: item.quantidade,
        custoUnitario: item.custoUnitario,
        operador,
        pedidoDeCompraId: pedido.id,
        pedidoDeCompraNumero: pedido.numero,
        notaFiscalRecebidaId: nota.id,
        notaFiscalNumero: nota.numero,
        observacao:
          `Pedido de compra #${pedido.numero} — NF nº ${nota.numero ?? "?"} — ${pedido.fornecedorNome}`,
      })),
    })

    await tx.pedidoDeCompra.update({
      where: { id: pedidoId },
      data: completo
        ? { situacao: "recebido", recebidoEm: new Date(), recebidoPor: operador }
        : { situacao: "parcial" },
    })

    await tx.notaFiscalRecebida.update({
      where: { id: notaId },
      data: { situacao: "recebida", recebidoEm: new Date(), recebidoPor: operador },
    })
  })

  return { ok: true, situacao: situacaoFinal }
}
