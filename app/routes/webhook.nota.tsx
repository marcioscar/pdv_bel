import type { Route } from "./+types/webhook.nota"
import { db } from "~/lib/db.server"
import { atualizarStatusDaNota } from "~/lib/nota-fiscal.server"

/**
 * Aviso da Focus NFe de que uma nota mudou de situação.
 *
 * A SEFAZ responde em segundos, mas responde quando quer: sem este aviso, a
 * nota autorizada só aparece como autorizada quando alguém abre a tela de
 * Vendas e a consulta é disparada. Com ele, o desfecho chega sozinho.
 *
 * **O corpo que chega aqui é um aviso, nunca a fonte da verdade** — mesma regra
 * do webhook do Inter. Esta URL é pública, e um POST forjado poderia marcar como
 * autorizada uma nota que a SEFAZ recusou, ou o contrário. Por isso daqui se
 * aproveita só o identificador: o que vale é o que a Focus responde quando
 * perguntamos, autenticados pelo token.
 *
 * A Focus não documenta o formato desta notificação, o que é mais um motivo para
 * não depender dele: mude o corpo lá, e aqui continua funcionando enquanto o
 * `ref` estiver em algum lugar reconhecível.
 *
 * Duas regras de qualquer webhook, e valem aqui:
 * responder 200 rápido, senão ele reenfileira e reenvia; e ser idempotente,
 * porque o mesmo evento chega mais de uma vez.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  /*
   * Segredo compartilhado, quando configurado: a Focus manda no cabeçalho que a
   * gente escolher ao cadastrar o gatilho. Não é o que garante a correção — a
   * consulta autenticada é —, mas evita que qualquer um faça o PDV consultar a
   * Focus à vontade.
   */
  const esperado = process.env.FOCUS_NFE_WEBHOOK_SEGREDO?.trim()
  if (esperado) {
    const recebido = request.headers.get("x-focus-segredo")?.trim()
    if (recebido !== esperado) {
      console.warn("[webhook nota] segredo não confere")
      return new Response("Unauthorized", { status: 401 })
    }
  }

  let corpo: unknown
  try {
    corpo = await request.json()
  } catch {
    // Corpo ilegível não tem conserto na próxima tentativa: 200 encerra o
    // assunto em vez de convidar a Focus a reenviar para sempre.
    console.warn("[webhook nota] corpo não-JSON")
    return Response.json({ recebido: true })
  }

  const refs = referenciasDoAviso(corpo)
  if (refs.length === 0) {
    console.warn("[webhook nota] aviso sem ref", JSON.stringify(corpo).slice(0, 300))
    return Response.json({ recebido: true })
  }

  const notas = await db.notaFiscalEmitida.findMany({
    where: { ref: { in: refs } },
    select: { id: true, ref: true },
  })

  // Referência que não é nossa não é erro: a mesma conta na Focus pode ter outro
  // sistema emitindo. Ignorar em silêncio é o certo.
  let falhou = false
  for (const nota of notas) {
    try {
      await atualizarStatusDaNota(nota.id)
    } catch (erro) {
      falhou = true
      console.error("[webhook nota] falha ao consultar", nota.ref, erro)
    }
  }

  /*
   * Focus fora do ar vira 503 para ela reenviar. Responder 200 encerraria o
   * assunto do lado de lá, e a nota ficaria "na fila" até alguém abrir a tela.
   */
  if (falhou) return new Response("Tente de novo", { status: 503 })

  return Response.json({ recebido: true, atualizadas: notas.length })
}

/**
 * O `ref` do aviso, sem depender de um formato específico.
 *
 * Aceita o objeto solto, uma lista deles, e o aninhado em `nfe`/`nfce` — as três
 * formas que APIs desse tipo costumam usar. O que não for string é descartado.
 */
function referenciasDoAviso(corpo: unknown): string[] {
  const eventos = Array.isArray(corpo) ? corpo : [corpo]
  const refs = new Set<string>()

  for (const evento of eventos) {
    if (!evento || typeof evento !== "object") continue
    const dados = evento as Record<string, unknown>

    for (const candidato of [
      dados.ref,
      (dados.nfe as Record<string, unknown> | undefined)?.ref,
      (dados.nfce as Record<string, unknown> | undefined)?.ref,
      (dados.dados as Record<string, unknown> | undefined)?.ref,
    ]) {
      if (typeof candidato === "string" && candidato.trim()) refs.add(candidato.trim())
    }
  }

  return [...refs]
}

/** GET aqui não faz nada: é rota de máquina, não tem tela. */
export function loader() {
  return new Response("Method Not Allowed", { status: 405 })
}
