import type { Route } from "./+types/webhook.pix"
import { conferirPendentes } from "~/lib/pix-pendente.server"

/**
 * Aviso do Inter de que um Pix entrou na chave do PDV.
 *
 * Mesma regra do webhook de cobrança: ESTA URL É PÚBLICA E NÃO TEM COMO SER
 * AUTENTICADA, então a mensagem é um AVISO, nunca uma fonte de verdade. Dela
 * só se aproveita o txid; o que decide se pagou é `conferirPendentes`, que
 * pergunta ao Inter com o certificado e grava a venda a partir do pedido
 * guardado. Uma mensagem forjada, no máximo, adianta uma consulta.
 *
 * A vigia do servidor confere os mesmos pendentes a cada poucos segundos: o
 * webhook só encurta a espera. Se ele se perder, a vigia pega na volta seguinte.
 *
 * Responde 200 rápido e é idempotente — o Inter reenvia o mesmo evento.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rotulo = params.conta ?? "(sem conta)"
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  let corpo: unknown
  try {
    corpo = await request.json()
  } catch {
    console.warn(`[webhook pix ${rotulo}] corpo não-JSON`)
    return Response.json({ recebido: true })
  }

  // O formato do Bacen: { pix: [{ txid, endToEndId, valor, horario, ... }] }.
  const eventos = (corpo as { pix?: { txid?: unknown }[] })?.pix
  const txids = Array.isArray(eventos)
    ? eventos
        .map((e) => e?.txid)
        .filter((t): t is string => typeof t === "string" && /^[a-zA-Z0-9]{26,35}$/.test(t))
    : []

  // Pix sem txid do PDV (transferência avulsa para a chave) não é da fila.
  for (const txid of new Set(txids)) {
    const conferidos = await conferirPendentes({ txid })
    console.info(
      `[webhook pix ${rotulo}] ${txid}: ${conferidos ? "conferido" : "não está na fila"}`
    )
  }

  return Response.json({ recebido: true })
}

/** GET serve para o Inter (e para você) verificarem que a URL responde. */
export function loader({ params }: Route.LoaderArgs) {
  return Response.json({ ok: true, webhook: "pix", conta: params.conta ?? null })
}
