import type { Prisma } from "@prisma/client"

import { AFS_POR_PAGINA, type FiltroAfs } from "~/lib/afs"
import { db } from "~/lib/db.server"
import { PRIMEIRO_DIA, ULTIMO_DIA, depoisDoDia, inicioDoDia, meioDiaDe } from "~/lib/dia"
import { arredondar } from "~/lib/moeda"
import { pedidoFechaCom } from "~/lib/pedidos-compra.server"

/**
 * A AF — autorização de faturamento — como rotina de entrada.
 *
 * Parte dos fornecedores entrega mercadoria sem emitir NF-e: o que chega junto
 * com a carga é uma AF. Nada disso passa pela SEFAZ, então a tela de notas de
 * entrada nunca vai ver essa compra — e sem uma rotina própria a mercadoria
 * entraria pela entrada avulsa do estoque, sem fornecedor, sem custo e sem
 * documento, que é exatamente o que faz o custo médio e o contas a pagar
 * pararem de fechar.
 *
 * O caminho é o mesmo da conciliação com nota, com uma diferença: aqui não há
 * XML de onde tirar os itens, então tudo é digitado. Quando existe pedido de
 * compra, ele preenche a digitação e a AF fecha o pedido como a nota fecharia.
 */

const DIA = /^\d{4}-\d{2}-\d{2}$/
const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export function lerFiltroAfs(url: URL): FiltroAfs {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const temDe = DIA.test(texto("de"))
  const temAte = DIA.test(texto("ate"))
  const de = temDe ? texto("de") : temAte ? texto("ate") : PRIMEIRO_DIA
  const ateBruto = temAte ? texto("ate") : temDe ? texto("de") : ULTIMO_DIA
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  return {
    de: inicio,
    ate: fim,
    // Sem tirar os não-dígitos, ao contrário do número de pedido: a AF é
    // numeração do fornecedor, e vem com letra e traço no papel.
    numero: texto("numero").slice(0, 20),
    fornecedor: texto("fornecedor").slice(0, 60),
    loja: texto("loja").slice(0, 10),
    pagina: Math.max(1, Math.trunc(Number(params.get("pagina"))) || 1),
  }
}

/**
 * As AFs que casam com o filtro, uma página de cada vez.
 *
 * O período pega a data do papel (`dataEmissao`), não a de digitação: AF
 * lançada com atraso é comum, e procurar "as de agosto" querendo dizer "as
 * digitadas em agosto" acharia coisa de julho e perderia coisa de agosto.
 */
export async function consultarAfs(filtro: FiltroAfs) {
  const periodo: Prisma.AutorizacaoDeFaturamentoWhereInput = {
    dataEmissao: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) },
  }

  const conteudo: Prisma.AutorizacaoDeFaturamentoWhereInput[] = []
  if (filtro.numero) conteudo.push({ numero: { contains: filtro.numero, mode: "insensitive" } })
  if (filtro.fornecedor) {
    conteudo.push({ fornecedorNome: { contains: filtro.fornecedor, mode: "insensitive" } })
  }
  if (filtro.loja) conteudo.push({ loja: filtro.loja })

  const where: Prisma.AutorizacaoDeFaturamentoWhereInput = { AND: [periodo, ...conteudo] }

  const [pagina, total, soma] = await Promise.all([
    db.autorizacaoDeFaturamento.findMany({
      where,
      orderBy: [{ dataEmissao: "desc" }, { criadoEm: "desc" }],
      skip: (filtro.pagina - 1) * AFS_POR_PAGINA,
      take: AFS_POR_PAGINA,
    }),
    db.autorizacaoDeFaturamento.count({ where }),
    db.autorizacaoDeFaturamento.aggregate({ where, _sum: { total: true } }),
  ])

  // Achar nada no período quando se procurou por número ou fornecedor costuma
  // ser filtro de data errado, não ausência — dizer isso é melhor que uma tela
  // vazia que parece defeito. Mesma escolha das outras consultas.
  const foraDoPeriodo =
    total === 0 && (filtro.numero || filtro.fornecedor)
      ? await db.autorizacaoDeFaturamento.count({ where: { AND: conteudo } })
      : 0

  return {
    afs: pagina,
    total,
    valor: soma._sum.total ?? 0,
    foraDoPeriodo,
    paginas: Math.max(1, Math.ceil(total / AFS_POR_PAGINA)),
  }
}

export function afPorId(id: string) {
  if (!OBJECT_ID.test(id)) return null
  return db.autorizacaoDeFaturamento.findUnique({ where: { id } })
}

/**
 * O último custo pago a este fornecedor, por produto — o palpite que preenche a
 * coluna de custo na digitação da AF.
 *
 * Vem de `Fornecimento`, o histórico de compra, e não do preço de venda: é o
 * número que o gerente vai comparar com o do papel, e um palpite errado por
 * ordem de grandeza é pior que campo vazio.
 */
export async function ultimoCustoDoFornecedor(fornecedorId: string): Promise<Map<string, number>> {
  if (!OBJECT_ID.test(fornecedorId)) return new Map()
  const fornecimentos = await db.fornecimento.findMany({
    where: { fornecedorId },
    select: { produtoId: true, ultimoCusto: true },
  })
  return new Map(fornecimentos.map((f) => [f.produtoId, f.ultimoCusto]))
}

export type ItemDaAf = {
  produtoId: string
  quantidade: number
  custoUnitario: number
}

export type EntradaDaAf = {
  numero: string
  loja: string
  fornecedorId: string
  pedidoDeCompraId: string | null
  dataEmissao: string
  observacao: string
  itens: ItemDaAf[]
}

export type ResultadoLancarAf =
  | { ok: true; id: string; numero: string; pedidoFechado: boolean }
  | { ok: false; erro: string }

/**
 * Grava a AF e dá entrada no estoque na mesma transação.
 *
 * As duas metades andam juntas de propósito: uma AF sem movimento é um papel
 * sem mercadoria, e um movimento sem AF é mercadoria sem origem — e quem for
 * conferir depois não teria como saber qual das duas faltou.
 *
 * Recusa a mesma AF do mesmo fornecedor duas vezes. É a proteção que a nota
 * ganha de graça pela chave de acesso única, e que aqui precisa ser explícita:
 * digitar de novo o que já foi digitado é o erro natural de quem lança papel, e
 * o estoque dobrado só aparece semanas depois, no inventário.
 */
export async function lancarAf(
  entrada: EntradaDaAf,
  operador: string
): Promise<ResultadoLancarAf> {
  const numero = entrada.numero.trim()
  if (!numero) return { ok: false, erro: "Informe o número da AF" }
  if (!entrada.loja) return { ok: false, erro: "Escolha a loja que recebeu a mercadoria" }

  const dataEmissao = meioDiaDe(entrada.dataEmissao)
  if (!dataEmissao) return { ok: false, erro: "Data da AF inválida" }

  const [loja, fornecedor] = await Promise.all([
    db.loja.findUnique({ where: { codigo: entrada.loja } }),
    OBJECT_ID.test(entrada.fornecedorId)
      ? db.fornecedor.findUnique({ where: { id: entrada.fornecedorId } })
      : null,
  ])
  if (!loja) return { ok: false, erro: "Loja não encontrada" }
  if (!fornecedor) return { ok: false, erro: "Escolha o fornecedor da AF" }

  const repetida = await db.autorizacaoDeFaturamento.findFirst({
    where: { fornecedorId: fornecedor.id, numero },
  })
  if (repetida) {
    return {
      ok: false,
      erro: `A AF nº ${numero} deste fornecedor já foi lançada em ${repetida.criadoEm.toLocaleDateString("pt-BR")} por ${repetida.criadoPor}.`,
    }
  }

  const itens = entrada.itens.filter((item) => item.quantidade > 0)
  if (itens.length === 0) return { ok: false, erro: "Nenhum item com quantidade para lançar" }
  if (itens.some((item) => !(item.custoUnitario > 0))) {
    return { ok: false, erro: "Todo item precisa do custo unitário que a AF cobrou" }
  }

  const produtos = await db.produto.findMany({
    where: { id: { in: itens.map((i) => i.produtoId) } },
    select: { id: true, codigo: true, descricao: true, unidade: true },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))
  if (itens.some((item) => !porId.has(item.produtoId))) {
    return { ok: false, erro: "Produto não encontrado no catálogo" }
  }

  const pedido = entrada.pedidoDeCompraId
    ? await db.pedidoDeCompra.findUnique({ where: { id: entrada.pedidoDeCompraId } })
    : null
  if (entrada.pedidoDeCompraId && !pedido) return { ok: false, erro: "Pedido não encontrado" }
  if (pedido && pedido.fornecedorId !== fornecedor.id) {
    return { ok: false, erro: "O pedido escolhido é de outro fornecedor" }
  }
  if (pedido && pedido.situacao !== "enviado" && pedido.situacao !== "parcial") {
    return { ok: false, erro: "Só um pedido enviado ou parcial pode receber mercadoria" }
  }

  // Um item por linha digitada, e não somado por produto: o papel pode listar o
  // mesmo produto duas vezes, com preços diferentes, e achatar isso perderia a
  // conferência linha a linha contra a AF na mão.
  const itensGravados = itens.map((item) => {
    const produto = porId.get(item.produtoId)!
    return {
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      quantidade: item.quantidade,
      custoUnitario: item.custoUnitario,
      total: arredondar(item.quantidade * item.custoUnitario),
    }
  })
  const total = arredondar(itensGravados.reduce((soma, item) => soma + item.total, 0))

  const pedidoFechado = pedido ? await pedidoFechaCom(pedido, itensGravados) : false

  const af = await db.$transaction(async (tx) => {
    const criada = await tx.autorizacaoDeFaturamento.create({
      data: {
        numero,
        loja: loja.codigo,
        fornecedorId: fornecedor.id,
        fornecedorNome: fornecedor.nomeFantasia || fornecedor.razaoSocial,
        fornecedorDocumento: fornecedor.documento,
        pedidoDeCompraId: pedido?.id ?? null,
        pedidoDeCompraNumero: pedido?.numero ?? null,
        dataEmissao,
        itens: itensGravados,
        total,
        observacao: entrada.observacao.trim() || null,
        criadoPor: operador,
      },
    })

    await tx.movimentoEstoque.createMany({
      data: itensGravados.map((item) => ({
        produtoId: item.produtoId,
        loja: loja.codigo,
        tipo: "entrada",
        quantidade: item.quantidade,
        custoUnitario: item.custoUnitario,
        operador,
        pedidoDeCompraId: pedido?.id ?? null,
        pedidoDeCompraNumero: pedido?.numero ?? null,
        autorizacaoFaturamentoId: criada.id,
        autorizacaoFaturamentoNumero: criada.numero,
        observacao: pedido
          ? `AF nº ${criada.numero} — pedido de compra #${pedido.numero} — ${criada.fornecedorNome}`
          : `AF nº ${criada.numero} — ${criada.fornecedorNome}`,
      })),
    })

    if (pedido) {
      await tx.pedidoDeCompra.update({
        where: { id: pedido.id },
        data: pedidoFechado
          ? { situacao: "recebido", recebidoEm: new Date(), recebidoPor: operador }
          : { situacao: "parcial" },
      })
    }

    return criada
  })

  return { ok: true, id: af.id, numero: af.numero, pedidoFechado }
}
