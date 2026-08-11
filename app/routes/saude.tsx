import type { Route } from "./+types/saude"
import { db } from "~/lib/db.server"
import { interConfigurado } from "~/lib/inter.server"

/**
 * Diz o que está rodando. Serve para responder "o deploy entrou?" sem adivinhar
 * pelo comportamento da interface, e para conferir de fora se o banco e a
 * integração do Inter estão de pé.
 *
 * Não expõe segredo: só se a configuração existe e contra qual ambiente aponta.
 */
export async function loader(_: Route.LoaderArgs) {
  const inter = interConfigurado()

  let banco: string
  try {
    banco = `ok · ${await db.produto.count()} produtos`
  } catch (erro) {
    banco = `falhou: ${erro instanceof Error ? erro.message.split("\n")[0] : "erro"}`
  }

  return Response.json(
    {
      ok: true,
      build: __BUILD__,
      ambiente: process.env.NODE_ENV ?? "desconhecido",
      banco,
      inter: {
        configurado: inter,
        // sandbox ou produção — dá para ver de fora se alguém trocou sem avisar
        alvo: process.env.INTER_BASE_URL?.includes("sandbox")
          ? "sandbox"
          : inter
            ? "producao"
            : null,
        chavePix: Boolean(process.env.INTER_CHAVE_PIX),
      },
    },
    { headers: { "cache-control": "no-store" } }
  )
}
