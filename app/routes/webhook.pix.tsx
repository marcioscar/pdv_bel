import type { Route } from "./+types/webhook.pix"
import { db } from "~/lib/db.server"

/**
 * Retorno do Inter para Pix recebidos.
 *
 * O padrão Pix do Banco Central manda `{ pix: [{ txid, endToEndId, valor,
 * horario }] }`. Aqui isso serve de rede de segurança do balcão: se o navegador
 * fechar entre o QR e a confirmação, a baixa não se perde.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  let corpo: unknown
  try {
    corpo = await request.json()
  } catch {
    console.warn("[webhook pix] corpo não-JSON")
    return Response.json({ recebido: true })
  }

  const dados = corpo as { pix?: { txid?: string; endToEndId?: string; horario?: string }[] }
  const recebidos = Array.isArray(dados.pix) ? dados.pix : []

  for (const pix of recebidos) {
    if (!pix.txid) continue

    // Idempotente: só marca o que ainda não estava pago.
    // `pixPagoEm: null` sozinho não casa — numa venda nunca baixada o campo está
    // AUSENTE do documento, e ausente não é null para o Mongo.
    const { count } = await db.venda.updateMany({
      where: {
        pixTxid: pix.txid,
        OR: [{ pixPagoEm: null }, { pixPagoEm: { isSet: false } }],
      },
      data: { pixPagoEm: pix.horario ? new Date(pix.horario) : new Date() },
    })
    console.info(`[webhook pix] ${pix.txid} pago (${count} venda atualizada)`)
  }

  return Response.json({ recebido: true })
}

export function loader() {
  return Response.json({ ok: true, webhook: "pix" })
}
