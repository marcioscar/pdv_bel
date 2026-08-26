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
 * para dar entrada — é o que decide se o "Receber" simples (quantidade
 * esperada) deve ficar desabilitado a favor da entrada pela nota (quantidade e
 * custo reais). Duas entradas para o mesmo pedido duplicariam o estoque.
 *
 * Devolve o CNPJ junto, e não só o id: é com ele que a tela monta o link para
 * a nota do fornecedor, já filtrada.
 */
export async function pedidosComNotaDisponivel(
  pedidos: { id: string; fornecedorId: string }[]
): Promise<Map<string, string>> {
  if (pedidos.length === 0) return new Map()

  const [cnpjs, fornecedores] = await Promise.all([
    cnpjsComNotaCompleta(),
    db.fornecedor.findMany({
      where: { id: { in: [...new Set(pedidos.map((p) => p.fornecedorId))] } },
      select: { id: true, documento: true },
    }),
  ])
  const documentoPorFornecedor = new Map(fornecedores.map((f) => [f.id, f.documento]))

  const resultado = new Map<string, string>()
  for (const pedido of pedidos) {
    const documento = documentoPorFornecedor.get(pedido.fornecedorId)
    if (documento && cnpjs.has(documento)) resultado.set(pedido.id, documento)
  }
  return resultado
}

/**
 * Os pedidos em aberto do fornecedor que emitiu esta nota — o caminho inverso
 * de `notasCandidatasDoPedido`, e o que a tela da nota usa para responder
 * "esta nota é de qual pedido?".
 *
 * Só "enviado" e "parcial": rascunho ainda não foi pedido a ninguém, e
 * recebido já fechou.
 *
 * Olha TODOS os cadastros com aquele CNPJ, e não o primeiro: o documento não
 * tem índice único, e já houve caso de duas empresas diferentes cadastradas
 * com o mesmo (erro de digitação). Pegar um só faria o pedido sumir da tela
 * conforme qual dos dois o banco devolvesse primeiro — falha silenciosa e
 * intermitente, a pior de diagnosticar.
 */
export async function pedidosAbertosDoFornecedor(emitenteCnpj: string) {
  const fornecedores = await db.fornecedor.findMany({
    where: { documento: emitenteCnpj },
    select: { id: true },
  })
  if (fornecedores.length === 0) return []

  return db.pedidoDeCompra.findMany({
    where: {
      fornecedorId: { in: fornecedores.map((f) => f.id) },
      situacao: { in: ["enviado", "parcial"] },
    },
    orderBy: { numero: "desc" },
  })
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
  | { ok: true; situacao: "recebido" | "parcial" | "sem-pedido" }
  | { ok: false; erro: string }

/**
 * Dá entrada no estoque com a quantidade e o custo REAIS da nota, em vez do
 * esperado — a versão de `marcarRecebido` (`pedidos-compra.server.ts`) para
 * quando existe a NF-e de verdade para comparar.
 *
 * Quase toda nota nasce de um pedido de compra, e é esse o caminho normal: com
 * pedido dá para comparar o que veio com o que foi combinado. Mas nem toda —
 * de vez em quando chega mercadoria sem pedido formal, e recusar a entrada por
 * isso obrigaria a lançar por fora, sem o custo real da nota. Por isso o pedido
 * é opcional aqui: o que se perde sem ele é só a comparação.
 *
 * Com pedido, aceita entrega parcial de propósito: o fornecedor manda o que tem
 * pronto, não o pedido inteiro de uma vez. O que falta continua "parcial",
 * esperando a próxima nota — o quanto já chegou é sempre derivado do
 * `MovimentoEstoque` deste pedido, nunca um contador à parte que pudesse ficar
 * defasado.
 *
 * Recusa lançar de novo os produtos que ESTA MESMA nota já lançou — protege
 * contra reprocessar a nota por engano, sem impedir que uma segunda nota
 * complete o que falta.
 */
export async function receberComNota(
  pedidoId: string | null,
  notaId: string,
  loja: string,
  operador: string,
  itens: ItemReconciliado[]
): Promise<ResultadoReceberComNota> {
  const pedido = pedidoId ? await db.pedidoDeCompra.findUnique({ where: { id: pedidoId } }) : null
  if (pedidoId && !pedido) return { ok: false, erro: "Pedido não encontrado" }
  if (pedido && pedido.situacao !== "enviado" && pedido.situacao !== "parcial") {
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
    where: { notaFiscalRecebidaId: notaId, ...(pedidoId ? { pedidoDeCompraId: pedidoId } : {}) },
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

  // Sem pedido não existe "esperado" contra o que fechar — a nota entra e pronto.
  let completo = false
  if (pedido) {
    const recebidoAntes = await db.movimentoEstoque.findMany({
      where: { pedidoDeCompraId: pedido.id, tipo: "entrada" },
      select: { produtoId: true, quantidade: true },
    })
    const totalAntesPorProduto = new Map<string, number>()
    for (const m of recebidoAntes) {
      totalAntesPorProduto.set(m.produtoId, (totalAntesPorProduto.get(m.produtoId) ?? 0) + m.quantidade)
    }

    completo = pedido.itens.every((item) => {
      const desteEnvio = itensParaGravar.find((i) => i.produtoId === item.produtoId)?.quantidade ?? 0
      const total = (totalAntesPorProduto.get(item.produtoId) ?? 0) + desteEnvio
      return total >= item.quantidade - 0.001
    })
  }

  await db.$transaction(async (tx) => {
    await tx.movimentoEstoque.createMany({
      data: itensParaGravar.map((item) => ({
        produtoId: item.produtoId,
        loja,
        tipo: "entrada",
        quantidade: item.quantidade,
        custoUnitario: item.custoUnitario,
        operador,
        pedidoDeCompraId: pedido?.id ?? null,
        pedidoDeCompraNumero: pedido?.numero ?? null,
        notaFiscalRecebidaId: nota.id,
        notaFiscalNumero: nota.numero,
        observacao: pedido
          ? `Pedido de compra #${pedido.numero} — NF nº ${nota.numero ?? "?"} — ${pedido.fornecedorNome}`
          : `NF nº ${nota.numero ?? "?"} — ${nota.emitenteNome}`,
      })),
    })

    if (pedido) {
      await tx.pedidoDeCompra.update({
        where: { id: pedido.id },
        data: completo
          ? { situacao: "recebido", recebidoEm: new Date(), recebidoPor: operador }
          : { situacao: "parcial" },
      })
    }

    await tx.notaFiscalRecebida.update({
      where: { id: notaId },
      data: { situacao: "recebida", recebidoEm: new Date(), recebidoPor: operador },
    })
  })

  return { ok: true, situacao: pedido ? (completo ? "recebido" : "parcial") : "sem-pedido" }
}
