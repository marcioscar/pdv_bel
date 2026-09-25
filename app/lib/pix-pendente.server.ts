import type { PixPendente } from "@prisma/client"

import { db } from "~/lib/db.server"
import { emitirDaVenda } from "~/lib/nota-fiscal.server"
import {
  confirmarPagamento,
  consultarPixImediato,
  removerPixImediato,
  type PixImediato,
} from "~/lib/pix.server"
import { conferirVenda, registrarVenda, type PedidoRecebido } from "~/lib/vendas.server"

/**
 * A fila dos Pix do balcão que esperam pagamento.
 *
 * Quem decide que um Pix pagou e grava a venda é SEMPRE o servidor, a partir do
 * pedido guardado quando a cobrança nasceu — nunca o carrinho da tela, que a
 * essa altura pode ser o do próximo cliente. A tela, a vigia e o webhook só
 * pedem para conferir; os três caem em `resolverPixPendente`, que é idempotente
 * e trava a gravação pela troca de `situacao`.
 */

export type PedidoDoPix = PedidoRecebido & { emitirNota: boolean }

/** O que a tela recebe: nada do pedido, só o necessário para o aviso. */
export type PixPendenteResumo = {
  id: string
  txid: string
  total: number
  situacao: string
  operador: string
  criadoEm: string
  expiraEm: string
  pagoEm: string | null
  vendaId: string | null
  vendaNumero: number | null
  erro: string | null
}

/** Situações em que não há mais nada a perguntar ao Inter. */
const RESOLVIDAS = ["paga", "cancelada", "expirada", "falhou"]

/**
 * Quanto uma gravação pode ficar travada antes de outro poder assumir. Se o
 * processo cai no meio, a trava some sozinha; `registrarVenda` recusa txid já
 * usado, então retomar nunca grava duas vezes.
 */
const TRAVA_MS = 2 * 60_000

/**
 * Folga depois do prazo antes de dar a cobrança por expirada: o relógio do
 * Inter e o nosso não são o mesmo, e um Pix pago no último segundo ainda
 * aparece na consulta seguinte.
 */
const FOLGA_EXPIRACAO_MS = 60_000

export function resumir(p: PixPendente): PixPendenteResumo {
  return {
    id: p.id,
    txid: p.txid,
    total: p.total,
    situacao: p.situacao,
    operador: p.operador,
    criadoEm: p.criadoEm.toISOString(),
    expiraEm: p.expiraEm.toISOString(),
    pagoEm: p.pagoEm?.toISOString() ?? null,
    vendaId: p.vendaId,
    vendaNumero: p.vendaNumero,
    erro: p.erro,
  }
}

export async function criarPixPendente(entrada: {
  txid: string
  loja: string
  caixa: string
  conta: string
  operador: string
  total: number
  pedido: PedidoDoPix
  expiracaoSegundos: number
}) {
  return db.pixPendente.create({
    data: {
      txid: entrada.txid,
      loja: entrada.loja,
      caixa: entrada.caixa,
      conta: entrada.conta,
      operador: entrada.operador,
      total: entrada.total,
      pedido: entrada.pedido,
      expiraEm: new Date(Date.now() + entrada.expiracaoSegundos * 1000),
    },
  })
}

export async function pixPendenteDaLoja(txid: string, loja: string) {
  return db.pixPendente.findFirst({ where: { txid, loja } })
}

/** Encerra sem venda, só a partir de "aguardando": nunca desfaz uma gravação. */
async function encerrar(p: PixPendente, situacao: "cancelada" | "expirada") {
  await db.pixPendente.updateMany({
    where: { id: p.id, situacao: "aguardando" },
    data: { situacao, resolvidoEm: new Date() },
  })
  return db.pixPendente.findUniqueOrThrow({ where: { id: p.id } })
}

/**
 * Pergunta ao Inter e age: grava a venda, encerra ou deixa esperando.
 *
 * Lança quando o Inter não responde — quem chama decide se isso é erro para a
 * tela (conferir agora) ou só uma volta perdida (vigia, webhook).
 */
export async function resolverPixPendente(p: PixPendente): Promise<PixPendente> {
  if (RESOLVIDAS.includes(p.situacao)) return p
  if (
    p.situacao === "gravando" &&
    p.gravandoDesde &&
    Date.now() - p.gravandoDesde.getTime() < TRAVA_MS
  ) {
    return p
  }

  const pix = await consultarPixImediato(p.txid, p.conta)

  if (pix.status === "CONCLUIDA") return gravar(p, pix)
  if (pix.status.startsWith("REMOVIDA")) return encerrar(p, "cancelada")
  if (Date.now() > p.expiraEm.getTime() + FOLGA_EXPIRACAO_MS) return encerrar(p, "expirada")
  return p
}

async function gravar(p: PixPendente, pix: PixImediato): Promise<PixPendente> {
  const agora = new Date()
  const pagoEm = pix.pagoEm ? new Date(pix.pagoEm) : agora

  // A trava: só um — tela, vigia ou webhook — passa daqui por vez.
  const { count } = await db.pixPendente.updateMany({
    where: {
      id: p.id,
      OR: [
        { situacao: "aguardando" },
        { situacao: "gravando", gravandoDesde: { lt: new Date(agora.getTime() - TRAVA_MS) } },
      ],
    },
    data: { situacao: "gravando", gravandoDesde: agora },
  })
  if (count === 0) return db.pixPendente.findUniqueOrThrow({ where: { id: p.id } })

  const concluir = (dados: {
    situacao: "paga" | "falhou"
    erro?: string
    vendaId?: string
    vendaNumero?: number
  }) =>
    db.pixPendente.update({
      where: { id: p.id },
      data: { ...dados, pagoEm, resolvidoEm: new Date() },
    })

  try {
    /*
     * Pago é pago, mas pode não ser o combinado: valor diferente ou Pix
     * devolvido. Não vira venda, e fica como "falhou" porque o dinheiro pode
     * estar na conta — alguém precisa olhar o extrato.
     */
    const confirmacao = confirmarPagamento(pix, p.total)
    if (!confirmacao.pago) return concluir({ situacao: "falhou", erro: confirmacao.motivo })

    // Venda que já nasceu deste txid (resposta perdida, processo que caiu).
    const existente = await db.venda.findFirst({
      where: { pixTxid: p.txid },
      select: { id: true, numero: true },
    })
    if (existente) {
      return concluir({ situacao: "paga", vendaId: existente.id, vendaNumero: existente.numero })
    }

    const { emitirNota, ...pedido } = p.pedido as unknown as PedidoDoPix

    const pedidoDaVenda = {
      ...pedido,
      forma: "pix",
      recebido: p.total,
      pixTxid: p.txid,
      pixPagoEm: pagoEm,
      loja: p.loja,
      caixa: p.caixa,
      operador: p.operador,
    }

    /*
     * O preço (ou o crédito do cliente) pode ter mudado entre o QR e o
     * pagamento. `registrarVenda` recalcula pelo cadastro, e a venda diria um
     * "a pagar" diferente do que entrou na conta. Melhor parar e mostrar do que
     * gravar a conta errada.
     */
    const conferida = await conferirVenda(pedidoDaVenda)
    if (!conferida.ok) return concluir({ situacao: "falhou", erro: conferida.erro })
    if (Math.round(conferida.aPagar * 100) !== Math.round(p.total * 100)) {
      return concluir({
        situacao: "falhou",
        erro: `O valor mudou depois do QR: cobrado ${p.total.toFixed(2)}, hoje daria ${conferida.aPagar.toFixed(2)}`,
      })
    }

    const resultado = await registrarVenda(pedidoDaVenda)
    if (!resultado.ok) return concluir({ situacao: "falhou", erro: resultado.erro })

    const paga = await concluir({
      situacao: "paga",
      vendaId: resultado.vendaId,
      vendaNumero: resultado.numero,
    })

    // A nota não derruba a venda: falha vira nota pendente na tela de Vendas.
    if (emitirNota) {
      await emitirDaVenda(resultado.vendaId, { emitidaPor: p.operador }).catch((erro) =>
        console.error(`[pix ${p.txid}] nota não emitida:`, erro)
      )
    }
    return paga
  } catch (erro) {
    // Banco fora, por exemplo: solta a trava para a próxima volta tentar.
    await db.pixPendente.update({
      where: { id: p.id },
      data: { situacao: "aguardando", gravandoDesde: null },
    })
    throw erro
  }
}

/**
 * Tira a cobrança do ar no Inter e encerra o pendente.
 *
 * O Inter só remove cobrança ATIVA. Se a remoção falha, o motivo mais comum é o
 * cliente ter pago no mesmo instante — aí vale o que `resolverPixPendente`
 * decidir, e a venda é gravada como seria se ninguém tivesse cancelado.
 * Devolve `aindaAtiva` quando nem remover nem resolver deu: o QR segue valendo.
 */
export async function cancelarPixPendente(
  p: PixPendente
): Promise<{ pendente: PixPendente; aindaAtiva: false } | { aindaAtiva: true; erro: string }> {
  if (RESOLVIDAS.includes(p.situacao)) return { pendente: p, aindaAtiva: false }

  try {
    await removerPixImediato(p.txid, p.conta)
    return { pendente: await encerrar(p, "cancelada"), aindaAtiva: false }
  } catch (erro) {
    const depois = await resolverPixPendente(p)
    if (RESOLVIDAS.includes(depois.situacao) || depois.situacao === "gravando") {
      return { pendente: depois, aindaAtiva: false }
    }
    const agora = await consultarPixImediato(p.txid, p.conta)
    if (agora.status !== "ATIVA") return { pendente: await encerrar(p, "cancelada"), aindaAtiva: false }
    return {
      aindaAtiva: true,
      erro: `Não foi possível cancelar no Inter — o QR continua valendo. ${
        erro instanceof Error ? erro.message : ""
      }`.trim(),
    }
  }
}

/** O que o caixa precisa ver: o que espera e o desfecho que ninguém viu ainda. */
export async function pixDoCaixa(loja: string) {
  const lista = await db.pixPendente.findMany({
    where: {
      loja,
      OR: [{ situacao: { in: ["aguardando", "gravando"] } }, { vistoEm: null }],
      // Um aviso esquecido não fica na tela para sempre.
      criadoEm: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
    },
    orderBy: { criadoEm: "asc" },
  })
  return lista.map(resumir)
}

export async function marcarVisto(id: string, loja: string) {
  await db.pixPendente.updateMany({
    where: { id, loja, situacao: { in: RESOLVIDAS } },
    data: { vistoEm: new Date() },
  })
}

// ---------------------------------------------------------------------------
// A vigia: confere sozinha, com ou sem tela aberta
// ---------------------------------------------------------------------------

const INTERVALO_VIGIA_MS = 5_000

/**
 * Uma volta: pergunta ao Inter por todos os pendentes, de todas as lojas.
 * Exportada para o webhook forçar uma volta sem esperar o intervalo.
 */
export async function conferirPendentes(filtro: { txid?: string } = {}) {
  const pendentes = await db.pixPendente.findMany({
    where: { situacao: { in: ["aguardando", "gravando"] }, ...filtro },
  })
  for (const p of pendentes) {
    try {
      const depois = await resolverPixPendente(p)
      if (depois.situacao !== p.situacao) {
        console.info(`[pix ${p.txid}] ${p.loja}: ${p.situacao} -> ${depois.situacao}`)
      }
    } catch (erro) {
      console.error(
        `[pix ${p.txid}] falha ao conferir:`,
        erro instanceof Error ? erro.message : erro
      )
    }
  }
  return pendentes.length
}

/**
 * Liga a vigia uma vez por processo.
 *
 * Só em produção: o `.env` local aponta para o banco real, e um `npm run dev`
 * esquecido aberto gravaria vendas de produção com o código da máquina de
 * alguém. Em desenvolvimento a tela aberta confere pelo "Conferir agora" e pela
 * consulta de 5 s, e a vigia de produção cobre o resto.
 */
export function ligarVigiaDoPix() {
  if (process.env.NODE_ENV !== "production") return
  const global = globalThis as { __vigiaDoPix?: boolean }
  if (global.__vigiaDoPix) return
  global.__vigiaDoPix = true

  let rodando = false
  setInterval(async () => {
    if (rodando) return
    rodando = true
    try {
      await conferirPendentes()
    } catch (erro) {
      console.error("[pix vigia]", erro instanceof Error ? erro.message : erro)
    } finally {
      rodando = false
    }
  }, INTERVALO_VIGIA_MS).unref()
}
