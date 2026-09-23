import { db } from "~/lib/db.server"
import { arredondar, QUANTIDADE_INTEIRA } from "~/lib/moeda"
import type { TipoMovimento } from "~/lib/estoque.server"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * A devolução: mercadoria que voltou depois que a venda virou fato.
 *
 * O que separa isto do cancelamento é o prazo. Cancelar diz "a venda não
 * aconteceu", e a SEFAZ só aceita isso por minutos na NFC-e e 24 horas na
 * NF-e — passado o prazo, a nota é fato consumado e desfazê-la deixaria um
 * documento fiscal sem venda. Aqui a venda continua de pé e o que se registra é
 * o retorno: estoque de volta, dinheiro de volta e uma nota de ENTRADA
 * referenciando a original.
 */

/**
 * Quanto de cada produto já voltou desta venda.
 *
 * Derivado das devoluções, e não guardado na venda: dois números para a mesma
 * verdade acabam discordando, e o que este guardaria é permissão para devolver
 * duas vezes o mesmo item.
 */
export async function devolvidoPorProduto(vendaId: string): Promise<Map<string, number>> {
  if (!OBJECT_ID.test(vendaId)) return new Map()

  const devolucoes = await db.devolucao.findMany({
    where: { vendaId },
    select: { itens: true },
  })

  const mapa = new Map<string, number>()
  for (const devolucao of devolucoes) {
    for (const item of devolucao.itens) {
      mapa.set(item.produtoId, arredondar((mapa.get(item.produtoId) ?? 0) + item.quantidade))
    }
  }
  return mapa
}

export type ItemDevolvido = { produtoId: string; quantidade: number }

/** Uma linha gravada na devolução — o retrato do que voltou, como na venda. */
type ItemGravado = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  preco: number
  quantidade: number
  subtotal: number
}

export type LinhaDevolvivel = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  /** O preço praticado NAQUELA venda, que é o que volta. */
  preco: number
  vendida: number
  jaDevolvida: number
  /** O teto desta devolução: o que saiu menos o que já voltou. */
  devolvivel: number
}

/** A venda vista do ponto de vista de quem vai devolver: o que ainda cabe. */
export async function itensDevolviveis(vendaId: string): Promise<LinhaDevolvivel[]> {
  if (!OBJECT_ID.test(vendaId)) return []

  const venda = await db.venda.findUnique({ where: { id: vendaId } })
  if (!venda) return []

  const jaVoltou = await devolvidoPorProduto(vendaId)

  return venda.itens.map((item) => {
    const jaDevolvida = jaVoltou.get(item.produtoId) ?? 0
    return {
      produtoId: item.produtoId,
      codigo: item.codigo,
      descricao: item.descricao,
      unidade: item.unidade,
      preco: item.preco,
      vendida: item.quantidade,
      jaDevolvida,
      devolvivel: arredondar(Math.max(0, item.quantidade - jaDevolvida)),
    }
  })
}

/**
 * Para onde vai o valor do que voltou.
 *
 * Três destinos porque são três acertos diferentes no balcão, e misturá-los
 * faria o fechamento mentir: "especie" tira da gaveta, "credito" vira saldo a
 * favor do cliente, "fora" é combinado por outro caminho (transferência,
 * abatimento em boleto) e o sistema só registra a mercadoria.
 */
export type DestinoDaDevolucao = "especie" | "credito" | "fora"

export type ResultadoDevolucao =
  | { ok: true; numero: number; id: string; total: number }
  | { ok: false; erro: string }

/**
 * Registra a devolução: documento, volta ao estoque e — quando o dinheiro sai
 * da gaveta — a saída de caixa, tudo na mesma transação.
 *
 * Os três juntos ou nenhum, pelo mesmo motivo da venda: um documento sem os
 * movimentos deixa o saldo derivado errado para sempre, e uma saída de caixa
 * sem documento é dinheiro que sumiu da gaveta sem explicação.
 *
 * O preço NÃO vem de quem chama: é lido do item da venda. Devolver pelo preço
 * de hoje, ou por um número que o navegador mandou, devolveria dinheiro que o
 * cliente não pagou.
 */
export async function registrarDevolucao(entrada: {
  vendaId: string
  itens: ItemDevolvido[]
  motivo: string
  operador: string
  operadorId: string
  /** O dia do caixa, quando o dinheiro volta em espécie. */
  dia: string
  destino: DestinoDaDevolucao
}): Promise<ResultadoDevolucao> {
  const motivo = entrada.motivo.trim()
  if (!motivo) return { ok: false, erro: "Diga por que a mercadoria voltou" }

  const venda = await db.venda.findUnique({ where: { id: entrada.vendaId } })
  if (!venda) return { ok: false, erro: "Venda não encontrada" }
  /*
   * Crédito precisa de alguém a quem creditar. Numa venda de balcão sem
   * cadastro não há conta onde pôr o saldo, e inventar uma na hora criaria um
   * cliente que ninguém vai reconhecer depois — o caminho é vincular o cadastro
   * na venda, ou devolver em espécie.
   */
  if (entrada.destino === "credito" && !venda.clienteId) {
    return {
      ok: false,
      erro: "Crédito exige cliente cadastrado na venda — sem ele não há a quem creditar",
    }
  }
  if (venda.canceladaEm) {
    return {
      ok: false,
      erro: "Esta venda foi cancelada — o estoque já voltou pelo cancelamento",
    }
  }

  const jaVoltou = await devolvidoPorProduto(entrada.vendaId)
  const porProduto = new Map(venda.itens.map((i) => [i.produtoId, i]))

  const itens: ItemGravado[] = []
  for (const pedido of entrada.itens) {
    if (!(pedido.quantidade > 0)) continue
    if (!Number.isInteger(pedido.quantidade)) return { ok: false, erro: QUANTIDADE_INTEIRA }

    const daVenda = porProduto.get(pedido.produtoId)
    if (!daVenda) {
      return { ok: false, erro: "Item que não estava nesta venda" }
    }

    const teto = arredondar(daVenda.quantidade - (jaVoltou.get(pedido.produtoId) ?? 0))
    if (pedido.quantidade > teto) {
      return {
        ok: false,
        erro:
          teto <= 0
            ? `${daVenda.descricao} já voltou por inteiro`
            : `${daVenda.descricao}: cabe devolver no máximo ${teto} ${daVenda.unidade}`,
      }
    }

    const quantidade = arredondar(pedido.quantidade)
    itens.push({
      produtoId: daVenda.produtoId,
      codigo: daVenda.codigo,
      descricao: daVenda.descricao,
      unidade: daVenda.unidade,
      // O preço praticado NAQUELA venda, lido aqui e não recebido de fora.
      preco: daVenda.preco,
      quantidade,
      subtotal: arredondar(daVenda.preco * quantidade),
    })
  }

  if (itens.length === 0) return { ok: false, erro: "Escolha o que está voltando" }

  const total = arredondar(itens.reduce((soma, i) => soma + i.subtotal, 0))

  // Mesmo padrão de numeração da venda: `$inc` atômico fora da transação, para
  // o rollback de uma gravação que falhar não devolver o número e repeti-lo.
  const contador = await db.contador.upsert({
    where: { nome: `devolucao:${venda.loja}` },
    update: { valor: { increment: 1 } },
    create: { nome: `devolucao:${venda.loja}`, valor: 1 },
  })

  const id = await db.$transaction(async (tx) => {
    const devolucao = await tx.devolucao.create({
      data: {
        numero: contador.valor,
        loja: venda.loja,
        vendaId: venda.id,
        vendaNumero: venda.numero,
        clienteId: venda.clienteId,
        clienteNome: venda.clienteNome,
        clienteCpfCnpj: venda.clienteCpfCnpj,
        itens,
        total,
        motivo,
        operador: entrada.operador,
      },
    })

    await tx.movimentoEstoque.createMany({
      data: itens.map((item) => ({
        produtoId: item.produtoId,
        loja: venda.loja,
        tipo: "devolucao" satisfies TipoMovimento,
        // Positivo: a mercadoria está voltando para a prateleira.
        quantidade: item.quantidade,
        operador: entrada.operador,
        vendaId: venda.id,
        vendaNumero: venda.numero,
        devolucaoId: devolucao.id,
        devolucaoNumero: devolucao.numero,
        observacao: `Devolução #${devolucao.numero} da venda #${venda.numero}: ${motivo}`,
      })),
    })

    if (entrada.destino === "especie") {
      const movimento = await tx.movimentoCaixa.create({
        data: {
          loja: venda.loja,
          dia: entrada.dia,
          tipo: "devolucao",
          // Positivo, como todo movimento de caixa: o tipo é que diz a direção.
          valor: total,
          operador: entrada.operador,
          operadorId: entrada.operadorId,
          observacao: `Devolução #${devolucao.numero} da venda #${venda.numero}`,
        },
      })
      await tx.devolucao.update({
        where: { id: devolucao.id },
        data: { movimentoCaixaId: movimento.id },
      })
    }

    if (entrada.destino === "credito") {
      const credito = await tx.movimentoCredito.create({
        data: {
          clienteId: venda.clienteId!,
          loja: venda.loja,
          tipo: "devolucao",
          valor: total,
          devolucaoId: devolucao.id,
          devolucaoNumero: devolucao.numero,
          vendaId: venda.id,
          vendaNumero: venda.numero,
          operador: entrada.operador,
          observacao: `Devolução #${devolucao.numero} da venda #${venda.numero}: ${motivo}`,
        },
      })
      await tx.devolucao.update({
        where: { id: devolucao.id },
        data: { movimentoCreditoId: credito.id },
      })
    }

    return devolucao.id
  })

  return { ok: true, numero: contador.valor, id, total }
}

export function devolucaoPorId(id: string) {
  if (!OBJECT_ID.test(id)) return null
  return db.devolucao.findUnique({ where: { id } })
}

/** As devoluções de uma loja, da mais recente para a mais antiga. */
export function listarDevolucoes(lojas: string[], limite = 60) {
  return db.devolucao.findMany({
    where: { loja: { in: lojas } },
    orderBy: { criadaEm: "desc" },
    take: limite,
  })
}
