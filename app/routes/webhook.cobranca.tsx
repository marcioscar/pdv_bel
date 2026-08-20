import type { Route } from "./+types/webhook.cobranca"
import { consultarCobranca } from "~/lib/cobranca.server"
import { db } from "~/lib/db.server"

/**
 * Retorno do Inter para cobranças (boleto com Pix).
 *
 * O Inter chama esta URL quando a situação de uma cobrança muda — inclusive no
 * pagamento. Sem isso, a situação só se atualiza se alguém consultar.
 *
 * ESTA URL É PÚBLICA E NÃO TEM COMO SER AUTENTICADA: quem chama é o banco, de
 * um endereço que não controlamos, sem segredo compartilhado. Portanto a
 * mensagem que chega aqui é um AVISO, nunca uma fonte de verdade — a situação
 * que ela afirma é ignorada de propósito.
 *
 * O que o webhook faz é: pegar o identificador, perguntar ao Inter (autenticado
 * por certificado) qual é a situação de fato, e gravar a resposta. Uma mensagem
 * forjada por qualquer um na internet não muda nada, porque o valor gravado não
 * vem dela.
 *
 * Antes, a situação do corpo era gravada direto. Bastava um POST sem
 * credencial nenhuma para marcar um boleto como pago — e com isso tirar um
 * cliente da lista de inadimplentes e sujar as contas a receber.
 *
 * Regras que valem para qualquer webhook do Inter:
 * - responder 200 rápido; se demorar ou falhar, ele reenfileira e reenvia;
 * - ser idempotente, porque o mesmo evento pode chegar mais de uma vez.
 */
export async function action({ request, params }: Route.ActionArgs) {
  // A conta no caminho (/webhooks/inter/cobranca/NRT) serve ao log. Para
  // consultar, o que vale é a conta GRAVADA na cobrança: é ela que emitiu, e
  // perguntar na conta errada devolve 404 sobre um boleto que existe.
  const rotulo = params.conta ?? "(sem conta no caminho)"

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  let corpo: unknown
  try {
    corpo = await request.json()
  } catch {
    // Corpo ilegível: responder 200 evita reenvio infinito de algo insalvável.
    console.warn(`[webhook cobranca ${rotulo}] corpo não-JSON`)
    return Response.json({ recebido: true })
  }

  // O Inter pode mandar um objeto ou uma lista de eventos.
  const eventos = Array.isArray(corpo) ? corpo : [corpo]

  /**
   * Falha ao falar com o Inter vira 503 para ele reenviar mais tarde.
   *
   * Responder 200 encerraria o assunto do lado dele, e um pagamento perdido
   * deixaria o cliente marcado como inadimplente sem dever nada — que é
   * exatamente o erro que mais custa caro no balcão.
   */
  let falhouConsulta = false

  for (const evento of eventos) {
    const dados = evento as {
      codigoSolicitacao?: string
      cobranca?: { codigoSolicitacao?: string }
    }
    const codigoSolicitacao = dados.codigoSolicitacao ?? dados.cobranca?.codigoSolicitacao

    if (!codigoSolicitacao) {
      console.warn(
        `[webhook cobranca ${rotulo}] evento sem codigoSolicitacao`,
        JSON.stringify(evento).slice(0, 300)
      )
      continue
    }

    // Cobrança que não é nossa (ex.: emitida no app do banco) simplesmente não
    // interessa — e nem daria para consultar, porque não sabemos a conta.
    const nossa = await db.cobranca.findUnique({
      where: { codigoSolicitacao },
      select: { conta: true, situacao: true },
    })
    if (!nossa) {
      console.info(`[webhook cobranca ${rotulo}] ${codigoSolicitacao} não é nossa`)
      continue
    }

    let situacaoReal: string | undefined
    try {
      const detalhe = await consultarCobranca(codigoSolicitacao, nossa.conta)
      situacaoReal = detalhe.cobranca?.situacao
    } catch (erro) {
      falhouConsulta = true
      console.error(
        `[webhook cobranca ${rotulo}] falha ao confirmar ${codigoSolicitacao}:`,
        erro instanceof Error ? erro.message : erro
      )
      continue
    }

    if (!situacaoReal) {
      console.warn(`[webhook cobranca ${rotulo}] ${codigoSolicitacao} sem situação no Inter`)
      continue
    }

    if (situacaoReal === nossa.situacao) {
      // Evento repetido, que o Inter reenvia por desenho. Nada a fazer.
      console.info(`[webhook cobranca ${rotulo}] ${codigoSolicitacao} já estava ${situacaoReal}`)
      continue
    }

    await db.cobranca.updateMany({
      where: { codigoSolicitacao },
      data: { situacao: situacaoReal },
    })
    console.info(
      `[webhook cobranca ${rotulo}] ${codigoSolicitacao}: ${nossa.situacao} -> ${situacaoReal} (confirmado no Inter)`
    )
  }

  if (falhouConsulta) {
    return new Response("Falha ao confirmar no Inter; reenvie", { status: 503 })
  }
  return Response.json({ recebido: true })
}

/** GET serve para o Inter (e para você) verificarem que a URL responde. */
export function loader({ params }: Route.LoaderArgs) {
  return Response.json({ ok: true, webhook: "cobranca", conta: params.conta ?? null })
}
