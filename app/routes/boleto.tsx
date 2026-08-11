import type { Route } from "./+types/boleto"
import { db } from "~/lib/db.server"
import { pdfDaCobranca } from "~/lib/cobranca.server"
import { exigirUsuario } from "~/lib/sessao.server"

/**
 * Serve o PDF do boleto da venda. Rota de recurso: sem componente, só o loader.
 * O PDF é buscado no Inter na hora — assim nada de binário grande fica no Mongo.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  await exigirUsuario(request)

  const cobranca = await db.cobranca.findUnique({
    where: { vendaId: params.vendaId },
  })
  if (!cobranca) throw new Response("Cobrança não encontrada", { status: 404 })

  const pdf = await pdfDaCobranca(cobranca.codigoSolicitacao)

  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="boleto-venda-${cobranca.vendaNumero}.pdf"`,
      "cache-control": "private, max-age=300",
    },
  })
}
