import { db } from "~/lib/db.server"
import { movimentosDeVenda } from "~/lib/estoque.server"
import { arredondar, moeda } from "~/lib/moeda"
import { FORMAS_PAGAMENTO, VALOR_MINIMO_BOLETO } from "~/lib/pdv"

export type ItemRecebido = { produtoId: string; quantidade: number }

export type PedidoVenda = {
  itens: ItemRecebido[]
  desconto: number
  forma: string
  recebido: number | null
  clienteId: string | null
  /** ISO date; só usado na venda a prazo. */
  vencimento: string | null
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
export function lerPedido(bruto: unknown): PedidoVenda | null {
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
    vencimento: typeof corpo.vencimento === "string" ? corpo.vencimento : null,
    caixa: typeof corpo.caixa === "string" ? corpo.caixa : "01",
    operador: typeof corpo.operador === "string" ? corpo.operador : "—",
  }
}

/**
 * Os preços vêm do banco, nunca do cliente: o payload só diz *o que* e *quanto*.
 * Assim um total adulterado no navegador não chega a ser gravado.
 */
export async function registrarVenda(pedido: PedidoVenda): Promise<ResultadoVenda> {
  if (pedido.itens.length === 0) return { ok: false, erro: "Venda sem itens" }

  if (!FORMAS_PAGAMENTO.some((f) => f.id === pedido.forma)) {
    return { ok: false, erro: "Forma de pagamento inválida" }
  }

  const produtos = await db.produto.findMany({
    where: { id: { in: pedido.itens.map((i) => i.produtoId) } },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const itens: ItemGravado[] = []
  for (const recebido of pedido.itens) {
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
  if (pedido.desconto > subtotal) {
    return { ok: false, erro: "Desconto maior que o subtotal" }
  }

  const total = arredondar(subtotal - pedido.desconto)

  if (pedido.forma === "dinheiro") {
    if (pedido.recebido === null) return { ok: false, erro: "Informe o valor recebido" }
    if (pedido.recebido < total) return { ok: false, erro: "Valor recebido menor que o total" }
  }

  // A prazo vira boleto, e o boleto do Inter exige pagador com endereço e um
  // valor nominal mínimo. Recusar aqui evita gravar venda que não pode ser cobrada.
  let cliente = null
  let vencimento: Date | null = null

  if (pedido.forma === "prazo") {
    if (!pedido.clienteId) {
      return { ok: false, erro: "Venda a prazo exige cliente (F6 para vincular)" }
    }
    if (total < VALOR_MINIMO_BOLETO) {
      return {
        ok: false,
        erro: `Boleto exige no mínimo ${moeda(VALOR_MINIMO_BOLETO)}`,
      }
    }

    cliente = await db.cliente.findUnique({ where: { id: pedido.clienteId } })
    if (!cliente) return { ok: false, erro: "Cliente não encontrado" }

    if (!pedido.vencimento) return { ok: false, erro: "Informe o vencimento" }
    const data = new Date(pedido.vencimento)
    if (Number.isNaN(data.getTime())) return { ok: false, erro: "Vencimento inválido" }

    const amanha = new Date()
    amanha.setHours(0, 0, 0, 0)
    if (data < amanha) return { ok: false, erro: "Vencimento não pode ser no passado" }

    vencimento = data
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
      ...(await gravar(pedido, itens, subtotal, total, troco, cliente, vencimento)),
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
  vencimento: Date | null
): Promise<{ numero: number; vendaId: string }> {
  for (let tentativa = 0; tentativa < 25; tentativa++) {
    // O $inc fica FORA da transação de propósito: dentro dela, o rollback de uma
    // colisão devolveria o contador e a tentativa seguinte repetiria o mesmo
    // número para sempre. O custo é um número queimado quando a gravação falha.
    const contador = await db.contador.update({
      where: { nome: "venda" },
      data: { valor: { increment: 1 } },
    })

    try {
      return await gravarUmaVez(
        contador.valor, pedido, itens, subtotal, total, troco, cliente, vencimento
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
  vencimento: Date | null
): Promise<{ numero: number; vendaId: string }> {
  // A venda e as baixas de estoque caem juntas ou não caem: uma venda gravada
  // sem seus movimentos deixaria o saldo derivado errado para sempre.
  return db.$transaction(async (tx) => {
    const venda = await tx.venda.create({
      data: {
        numero,
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
