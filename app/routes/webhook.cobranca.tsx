import type { Route } from "./+types/webhook.cobranca"
import { db } from "~/lib/db.server"

/**
 * Retorno do Inter para cobranças (boleto com Pix).
 *
 * O Inter chama esta URL quando a situação de uma cobrança muda — inclusive no
 * pagamento. Sem isso, a situação só se atualiza se alguém consultar.
 *
 * Regras que valem para qualquer webhook do Inter:
 * - responder 200 rápido; se demorar ou falhar, ele reenfileira e reenvia;
 * - ser idempotente, porque o mesmo evento pode chegar mais de uma vez;
 * - não confiar no corpo para nada além de identificar a cobrança.
 */
export async function action({ request, params }: Route.ActionArgs) {
  // A conta vem no caminho (/webhooks/inter/cobranca/NRT) e serve para o log dizer
  // de onde veio. A atualização continua sendo por `codigoSolicitacao`, que é UUID
  // gerado pelo Inter e único entre contas — então a conta é rastro, não chave.
  const conta = params.conta ?? "(sem conta no caminho)"

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  let corpo: unknown
  try {
    corpo = await request.json()
  } catch {
    // Corpo ilegível: responder 200 evita reenvio infinito de algo insalvável.
    console.warn(`[webhook cobranca ${conta}] corpo não-JSON`)
    return Response.json({ recebido: true })
  }

  // O Inter pode mandar um objeto ou uma lista de eventos.
  const eventos = Array.isArray(corpo) ? corpo : [corpo]

  for (const evento of eventos) {
    const dados = evento as {
      codigoSolicitacao?: string
      situacao?: string
      cobranca?: { codigoSolicitacao?: string; situacao?: string }
    }
    const codigoSolicitacao = dados.codigoSolicitacao ?? dados.cobranca?.codigoSolicitacao
    const situacao = dados.situacao ?? dados.cobranca?.situacao

    if (!codigoSolicitacao || !situacao) {
      console.warn(
        `[webhook cobranca ${conta}] evento sem codigoSolicitacao/situacao`,
        JSON.stringify(evento).slice(0, 300)
      )
      continue
    }

    // updateMany não falha quando a cobrança não é nossa (ex.: emitida no app do banco).
    const { count } = await db.cobranca.updateMany({
      where: { codigoSolicitacao },
      data: { situacao },
    })
    console.info(
      `[webhook cobranca ${conta}] ${codigoSolicitacao} -> ${situacao} (${count} atualizada)`
    )
  }

  return Response.json({ recebido: true })
}

/** GET serve para o Inter (e para você) verificarem que a URL responde. */
export function loader({ params }: Route.LoaderArgs) {
  return Response.json({ ok: true, webhook: "cobranca", conta: params.conta ?? null })
}
