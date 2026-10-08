import type { Cobranca } from "@prisma/client"
import QRCode from "qrcode"

import type { CobrancaDaVenda } from "~/lib/cobranca.server"
import { db } from "~/lib/db.server"
import { contaDaLoja } from "~/lib/lojas.server"
import { FORMA_PIX_ENTREGA, VALIDADE_PIX_ENTREGA_APOS_VENCIMENTO } from "~/lib/pdv"
import {
  consultarPixComVencimento,
  criarPixComVencimento,
  novoTxid,
  removerPixComVencimento,
  type PixComVencimento,
} from "~/lib/pix.server"
import { arredondar } from "~/lib/moeda"

/**
 * O Pix na entrega: a venda fecha no balcão e o dinheiro fica a receber numa
 * cobrança Pix com vencimento (cobv), cujo QR sai com o entregador.
 *
 * Mora em `cobrancas`, ao lado dos boletos, com `tipo: "pix"` e o txid em
 * `codigoSolicitacao`. É isso que a põe em Contas a receber, em Inadimplentes
 * e na trava do caixa sem nenhuma dessas telas precisar saber que não é boleto.
 * A situação usa o MESMO vocabulário do boleto (A_RECEBER, ATRASADO, RECEBIDO,
 * CANCELADO, EXPIRADO), traduzida aqui a partir do status do Pix.
 */

/** Ainda pode ser paga: é o que a vigia e o webhook conferem. */
const ABERTAS = ["A_RECEBER", "ATRASADO"]

function diaIso(data: Date) {
  // Pelo fuso de Brasília: o vencimento é gravado ao meio-dia, e o UTC dele
  // ainda é o mesmo dia.
  return data.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })
}

/** Status do Pix -> situação da cobrança, na régua do boleto. */
function situacaoDoPix(pix: PixComVencimento, vencimento: Date): string {
  if (pix.status === "CONCLUIDA") {
    // Devolvido é dinheiro que voltou: a dívida continua.
    if (pix.devolucoes === 0) return "RECEBIDO"
  }
  if (pix.status.startsWith("REMOVIDA")) return "CANCELADO"

  const fimDoVencimento = new Date(vencimento)
  fimDoVencimento.setHours(23, 59, 59, 999)
  const agora = Date.now()
  const fimDaValidade =
    fimDoVencimento.getTime() + VALIDADE_PIX_ENTREGA_APOS_VENCIMENTO * 86_400_000
  if (agora > fimDaValidade) return "EXPIRADO"
  if (agora > fimDoVencimento.getTime()) return "ATRASADO"
  return "A_RECEBER"
}

async function paraTela(c: Cobranca): Promise<CobrancaDaVenda> {
  return {
    codigoSolicitacao: c.codigoSolicitacao,
    situacao: c.situacao,
    parcela: c.parcela,
    parcelas: c.parcelas,
    valor: c.valor,
    vencimento: c.vencimento.toISOString(),
    linhaDigitavel: null,
    codigoBarras: null,
    nossoNumero: null,
    txid: c.txid,
    pixCopiaECola: c.pixCopiaECola,
    pixQrCode: c.pixCopiaECola
      ? await QRCode.toDataURL(c.pixCopiaECola, { errorCorrectionLevel: "M", margin: 1, width: 320 })
      : null,
    tipo: "pix",
  }
}

/**
 * Gera (ou devolve, se já existe) a cobrança da venda. Idempotente: a tela de
 * Vendas pode chamar de novo sem criar um segundo QR.
 */
export async function emitirPixDaEntrega(vendaId: string): Promise<CobrancaDaVenda[]> {
  const venda = await db.venda.findUnique({ where: { id: vendaId } })
  if (!venda) throw new Error("Venda não encontrada")
  if (venda.forma !== FORMA_PIX_ENTREGA) throw new Error("Esta venda não é Pix na entrega")

  const existente = await db.cobranca.findFirst({ where: { vendaId } })
  if (existente) return [await paraTela(existente)]

  if (venda.canceladaEm) throw new Error("Venda cancelada não gera cobrança")
  if (!venda.vencimento) throw new Error("Venda sem vencimento")
  const documento = (venda.clienteCpfCnpj ?? "").replace(/\D/g, "")
  if (!venda.clienteNome || (documento.length !== 11 && documento.length !== 14)) {
    throw new Error("O Pix na entrega precisa do nome e do CPF/CNPJ do cliente")
  }

  const valor = arredondar(venda.total - (venda.creditoUsado ?? 0))
  const conta = await contaDaLoja(venda.loja)
  const txid = novoTxid()

  const pix = await criarPixComVencimento({
    conta,
    txid,
    valor,
    vencimento: diaIso(venda.vencimento),
    validadeAposVencimento: VALIDADE_PIX_ENTREGA_APOS_VENCIMENTO,
    devedor:
      documento.length === 11
        ? { nome: venda.clienteNome.slice(0, 200), cpf: documento }
        : { nome: venda.clienteNome.slice(0, 200), cnpj: documento },
    solicitacao: `Venda ${venda.numero} ${venda.loja} - BrasSaco Embalagens`,
  })

  const gravada = await db.cobranca.create({
    data: {
      tipo: "pix",
      vendaId,
      vendaNumero: venda.numero,
      loja: venda.loja,
      conta,
      parcela: 1,
      parcelas: 1,
      codigoSolicitacao: txid,
      txid,
      pixCopiaECola: pix.pixCopiaECola,
      situacao: "A_RECEBER",
      valor,
      vencimento: venda.vencimento,
    },
  })
  return [await paraTela(gravada)]
}

/**
 * Pergunta ao Inter e grava a situação. Devolve a situação de agora.
 *
 * Baixada na loja não se consulta: o Inter diria CANCELADO (a própria baixa
 * tirou o QR do ar) e é a baixa que vale.
 */
export async function atualizarPixDaEntrega(c: Cobranca): Promise<string> {
  if (c.baixadoEm) return c.situacao
  const pix = await consultarPixComVencimento(c.codigoSolicitacao, c.conta)
  const situacao = situacaoDoPix(pix, c.vencimento)
  if (situacao !== c.situacao) {
    await db.cobranca.update({ where: { id: c.id }, data: { situacao } })
    console.info(`[pix entrega ${c.codigoSolicitacao}] venda #${c.vendaNumero} ${c.loja}: ${c.situacao} -> ${situacao}`)
  }
  return situacao
}

/**
 * Tira o QR do ar — no cancelamento da venda e na baixa na loja.
 *
 * Confere antes e depois: o cliente pode ter pago no mesmo instante, e aí o
 * que vale é o pagamento (`pago: true`), nunca um cancelamento por cima dele.
 */
export async function tirarDoArPixDaEntrega(
  c: Cobranca
): Promise<{ ok: true; pago: boolean } | { ok: false; erro: string }> {
  const antes = await atualizarPixDaEntrega(c)
  if (antes === "RECEBIDO") return { ok: true, pago: true }
  if (!ABERTAS.includes(antes)) return { ok: true, pago: false }

  try {
    await removerPixComVencimento(c.codigoSolicitacao, c.conta)
  } catch (erro) {
    const depois = await atualizarPixDaEntrega(c)
    if (depois === "RECEBIDO") return { ok: true, pago: true }
    if (!ABERTAS.includes(depois)) return { ok: true, pago: false }
    return {
      ok: false,
      erro: `O Inter não tirou o Pix do ar: ${erro instanceof Error ? erro.message : "erro desconhecido"}`,
    }
  }
  await db.cobranca.update({ where: { id: c.id }, data: { situacao: "CANCELADO" } })
  return { ok: true, pago: false }
}

/** O webhook do Pix avisa pelo txid; se for de uma entrega, confere. */
export async function conferirPixDaEntregaPeloTxid(txid: string) {
  const c = await db.cobranca.findFirst({ where: { codigoSolicitacao: txid, tipo: "pix" } })
  if (!c) return null
  return atualizarPixDaEntrega(c)
}

/**
 * A volta da vigia: as entregas que ainda podem ser pagas. O webhook é o
 * caminho rápido; esta é a rede embaixo, para o aviso que se perdeu — e é ela
 * que move A_RECEBER para ATRASADO e EXPIRADO com o passar dos dias.
 */
export async function conferirPixDasEntregas() {
  const abertas = await db.cobranca.findMany({
    // Ausente não é null para o Mongo: os dois estados são "não baixada".
    where: {
      tipo: "pix",
      situacao: { in: ABERTAS },
      OR: [{ baixadoEm: null }, { baixadoEm: { isSet: false } }],
    },
  })
  for (const c of abertas) {
    try {
      await atualizarPixDaEntrega(c)
    } catch (erro) {
      console.error(
        `[pix entrega ${c.codigoSolicitacao}] falha ao conferir:`,
        erro instanceof Error ? erro.message : erro
      )
    }
  }
  return abertas.length
}
