import { db } from "~/lib/db.server"
import { movimentosDeVenda } from "~/lib/estoque.server"
import { arredondar, moeda } from "~/lib/moeda"
import {
  condicaoCabeNoTotal,
  condicaoPorId,
  dividirParcelas,
  FORMAS_PAGAMENTO,
  parcelasDaCondicao,
  VALOR_MINIMO_BOLETO,
} from "~/lib/pdv"

export type ItemRecebido = { produtoId: string; quantidade: number }

/**
 * O que o navegador manda. Note que loja, caixa e operador NÃO estão aqui: eles
 * vêm da sessão, na rota. Se estivessem no payload, daria para escolher em que
 * loja gravar a venda — e a separação entre lojas viraria sugestão.
 */
export type PedidoRecebido = {
  itens: ItemRecebido[]
  desconto: number
  forma: string
  recebido: number | null
  clienteId: string | null
  /**
   * Id de uma condição de CONDICOES_PAGAMENTO; só usado na venda a prazo.
   *
   * A tela manda a condição escolhida, não as datas: os vencimentos são
   * calculados aqui. Aceitar datas do navegador deixaria o prazo combinado com o
   * cliente fora da política da empresa sem deixar rastro.
   */
  condicao: string | null
  /** Pix imediato: comprovante do pagamento já confirmado. */
  pixTxid?: string | null
  pixPagoEm?: Date | null
}

/** O pedido completo: o que veio da tela mais o que só o servidor sabe. */
export type PedidoVenda = PedidoRecebido & {
  loja: string
  caixa: string
  operador: string
}

/** Espelha `type VendaItem` do schema: o item como fica gravado na venda. */
type ItemGravado = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  preco: number
  quantidade: number
  subtotal: number
}

export type ResultadoVenda =
  | { ok: true; numero: number; vendaId: string; total: number; troco: number }
  | { ok: false; erro: string }

/** Um ObjectId malformado faria o Prisma lançar, virando 500 em vez de 400. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/** Só aceita o que o formato do payload garante; o resto é rejeitado. */
export function lerPedido(bruto: unknown): PedidoRecebido | null {
  if (typeof bruto !== "object" || bruto === null) return null
  const corpo = bruto as Record<string, unknown>

  if (!Array.isArray(corpo.itens)) return null

  const itens: ItemRecebido[] = []
  for (const item of corpo.itens) {
    if (typeof item !== "object" || item === null) return null
    const { produtoId, quantidade } = item as Record<string, unknown>
    if (typeof produtoId !== "string" || !OBJECT_ID.test(produtoId)) return null
    if (typeof quantidade !== "number" || !Number.isFinite(quantidade) || quantidade <= 0) {
      return null
    }
    itens.push({ produtoId, quantidade })
  }

  const desconto = typeof corpo.desconto === "number" ? corpo.desconto : 0
  if (!Number.isFinite(desconto) || desconto < 0) return null

  const recebido =
    corpo.recebido === null || corpo.recebido === undefined
      ? null
      : typeof corpo.recebido === "number" && Number.isFinite(corpo.recebido)
        ? corpo.recebido
        : NaN
  if (recebido !== null && Number.isNaN(recebido)) return null

  const clienteId =
    typeof corpo.clienteId === "string" && OBJECT_ID.test(corpo.clienteId)
      ? corpo.clienteId
      : null
  // Um clienteId presente mas malformado é recusado, não silenciosamente ignorado.
  if (corpo.clienteId != null && clienteId === null) return null

  return {
    itens,
    desconto,
    forma: typeof corpo.forma === "string" ? corpo.forma : "",
    recebido,
    clienteId,
    condicao: typeof corpo.condicao === "string" ? corpo.condicao : null,
  }
}

export type Precificacao =
  | { ok: true; itens: ItemGravado[]; subtotal: number; total: number }
  | { ok: false; erro: string }

/**
 * Monta os itens com os preços do BANCO e calcula o total.
 *
 * O cliente só informa o que e quanto; preço e total nunca vêm dele. Extraído
 * para o fluxo do Pix usar o mesmo cálculo na criação da cobrança e na
 * confirmação — se fossem cálculos diferentes, dava para pagar um valor e
 * registrar outro.
 */
export async function precificar(
  itensRecebidos: ItemRecebido[],
  desconto: number
): Promise<Precificacao> {
  if (itensRecebidos.length === 0) return { ok: false, erro: "Venda sem itens" }

  const produtos = await db.produto.findMany({
    where: { id: { in: itensRecebidos.map((i) => i.produtoId) } },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const itens: ItemGravado[] = []
  for (const recebido of itensRecebidos) {
    const produto = porId.get(recebido.produtoId)
    if (!produto) return { ok: false, erro: "Produto não encontrado no catálogo" }

    itens.push({
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      preco: produto.preco,
      quantidade: recebido.quantidade,
      subtotal: arredondar(produto.preco * recebido.quantidade),
    })
  }

  const subtotal = arredondar(itens.reduce((acc, item) => acc + item.subtotal, 0))
  if (desconto > subtotal) return { ok: false, erro: "Desconto maior que o subtotal" }

  return { ok: true, itens, subtotal, total: arredondar(subtotal - desconto) }
}

/**
 * Os preços vêm do banco, nunca do cliente: o payload só diz *o que* e *quanto*.
 * Assim um total adulterado no navegador não chega a ser gravado.
 */
export async function registrarVenda(pedido: PedidoVenda): Promise<ResultadoVenda> {
  if (!FORMAS_PAGAMENTO.some((f) => f.id === pedido.forma)) {
    return { ok: false, erro: "Forma de pagamento inválida" }
  }
  if (!pedido.loja) return { ok: false, erro: "Venda sem loja" }

  const preco = await precificar(pedido.itens, pedido.desconto)
  if (!preco.ok) return { ok: false, erro: preco.erro }
  const { itens, subtotal, total } = preco

  if (pedido.forma === "dinheiro") {
    if (pedido.recebido === null) return { ok: false, erro: "Informe o valor recebido" }
    if (pedido.recebido < total) return { ok: false, erro: "Valor recebido menor que o total" }
  }

  // A prazo vira boleto, e o boleto do Inter exige pagador com endereço e um
  // valor nominal mínimo. Recusar aqui evita gravar venda que não pode ser cobrada.
  let cliente = null
  let vencimento: Date | null = null
  let condicaoId: string | null = null

  if (pedido.forma === "prazo") {
    if (!pedido.clienteId) {
      return { ok: false, erro: "Venda a prazo exige cliente (F6 para vincular)" }
    }

    const condicao = condicaoPorId(pedido.condicao ?? "")
    if (!condicao) return { ok: false, erro: "Escolha a condição de pagamento" }

    // O mínimo do Inter vale por boleto, então o que decide é a menor parcela,
    // não o total: R$ 6,00 em 3× daria três boletos de R$ 2,00, todos recusados.
    if (!condicaoCabeNoTotal(condicao, total)) {
      const menor = Math.min(...dividirParcelas(total, condicao.dias.length))
      return {
        ok: false,
        erro: `${condicao.rotulo} daria parcela de ${moeda(menor)} — o boleto exige no mínimo ${moeda(VALOR_MINIMO_BOLETO)}`,
      }
    }

    cliente = await db.cliente.findUnique({ where: { id: pedido.clienteId } })
    if (!cliente) return { ok: false, erro: "Cliente não encontrado" }

    condicaoId = condicao.id
    vencimento = parcelasDaCondicao(condicao, total)[0].vencimento
  } else if (pedido.clienteId) {
    // Cliente também pode ser vinculado numa venda à vista, só não é obrigatório.
    cliente = await db.cliente.findUnique({ where: { id: pedido.clienteId } })
    if (!cliente) return { ok: false, erro: "Cliente não encontrado" }
  }

  const troco =
    pedido.recebido === null ? 0 : arredondar(Math.max(0, pedido.recebido - total))

  try {
    return {
      ok: true,
      ...(await gravar(pedido, itens, subtotal, total, troco, cliente, vencimento, condicaoId)),
      total,
      troco,
    }
  } catch (erro) {
    if (erro instanceof Error && erro.message.includes(SEQUENCIA_ESGOTADA)) {
      return { ok: false, erro: "Sequência de numeração fora de sincronia" }
    }
    throw erro
  }
}

const SEQUENCIA_ESGOTADA = "sequencia-de-venda-esgotada"

/**
 * Só a colisão do `numero` justifica tentar de novo. Antes isto aceitava qualquer
 * P2002, então uma violação em outro índice único era reprocessada 25 vezes —
 * queimando 25 números de venda e mascarando a causa real com uma mensagem de
 * "sequência fora de sincronia".
 */
function ehColisaoDeNumero(erro: unknown) {
  if (typeof erro !== "object" || erro === null) return false
  const falha = erro as { code?: string; meta?: { target?: unknown } }
  if (falha.code !== "P2002") return false

  const alvo = falha.meta?.target
  const texto = Array.isArray(alvo) ? alvo.join(",") : String(alvo ?? "")
  return texto.includes("numero")
}

/**
 * Se o contador ficar atrás das vendas existentes (restore de backup, ajuste
 * manual), o `numero` colide no índice único. Em vez de derrubar o caixa com um
 * 500 a cada venda, tentamos de novo até a sequência passar das vendas gravadas.
 */
async function gravar(
  pedido: PedidoVenda,
  itens: ItemGravado[],
  subtotal: number,
  total: number,
  troco: number,
  cliente: { id: string; nome: string; cpfCnpj: string } | null,
  vencimento: Date | null,
  condicao: string | null
): Promise<{ numero: number; vendaId: string }> {
  for (let tentativa = 0; tentativa < 25; tentativa++) {
    // O $inc fica FORA da transação de propósito: dentro dela, o rollback de uma
    // colisão devolveria o contador e a tentativa seguinte repetiria o mesmo
    // número para sempre. O custo é um número queimado quando a gravação falha.
    // Um contador por loja: "venda:QI". Com um contador global, as quatro lojas
    // disputariam a mesma sequência e o número deixaria de significar algo para
    // quem confere o caixa de uma loja.
    const contador = await db.contador.upsert({
      where: { nome: `venda:${pedido.loja}` },
      update: { valor: { increment: 1 } },
      create: { nome: `venda:${pedido.loja}`, valor: 1 },
    })

    try {
      return await gravarUmaVez(
        contador.valor, pedido, itens, subtotal, total, troco, cliente, vencimento, condicao
      )
    } catch (erro) {
      if (!ehColisaoDeNumero(erro)) throw erro
    }
  }
  throw new Error(SEQUENCIA_ESGOTADA)
}

async function gravarUmaVez(
  numero: number,
  pedido: PedidoVenda,
  itens: ItemGravado[],
  subtotal: number,
  total: number,
  troco: number,
  cliente: { id: string; nome: string; cpfCnpj: string } | null,
  vencimento: Date | null,
  condicao: string | null
): Promise<{ numero: number; vendaId: string }> {
  // A venda e as baixas de estoque caem juntas ou não caem: uma venda gravada
  // sem seus movimentos deixaria o saldo derivado errado para sempre.
  return db.$transaction(async (tx) => {
    const venda = await tx.venda.create({
      data: {
        numero,
        loja: pedido.loja,
        caixa: pedido.caixa,
        operador: pedido.operador,
        itens,
        subtotal,
        desconto: pedido.desconto,
        total,
        forma: pedido.forma,
        recebido: pedido.recebido,
        troco: pedido.recebido === null ? null : troco,
        clienteId: cliente?.id ?? null,
        clienteNome: cliente?.nome ?? null,
        clienteCpfCnpj: cliente?.cpfCnpj ?? null,
        vencimento,
        condicao,
        pixTxid: pedido.pixTxid ?? null,
        pixPagoEm: pedido.pixPagoEm ?? null,
      },
    })

    await tx.movimentoEstoque.createMany({
      data: movimentosDeVenda(
        itens.map((item) => ({ produtoId: item.produtoId, quantidade: item.quantidade })),
        venda,
        pedido.operador
      ),
    })

    return { numero: venda.numero, vendaId: venda.id }
  })
}
