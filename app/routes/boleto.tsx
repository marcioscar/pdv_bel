import type { Route } from "./+types/boleto"
import { db } from "~/lib/db.server"
import { pdfDaCobranca } from "~/lib/cobranca.server"
import { exigirUsuario } from "~/lib/sessao.server"

/**
 * Serve o PDF do boleto da venda. Rota de recurso: sem componente, só o loader.
 * O PDF é buscado no Inter na hora — assim nada de binário grande fica no Mongo.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  // ?parcela=2 serve a segunda parcela do parcelamento; sem isso, a primeira.
  const pedida = Number(new URL(request.url).searchParams.get("parcela"))
  const parcela = Number.isInteger(pedida) && pedida > 0 ? pedida : null

  const cobranca = await db.cobranca.findFirst({
    where: { vendaId: params.vendaId, ...(parcela ? { parcela } : {}) },
    orderBy: { parcela: "asc" },
  })
  if (!cobranca) throw new Response("Cobrança não encontrada", { status: 404 })
  if (cobranca.loja !== eu.loja) {
    throw new Response(`Boleto da loja ${cobranca.loja}`, { status: 403 })
  }

  let pdf: Buffer
  try {
    pdf = await pdfDaCobranca(cobranca.codigoSolicitacao, cobranca.conta)
  } catch (erro) {
    // A mensagem precisa chegar à tela: `InterNaoConfigurado` explica exatamente o
    // que está errado (certificado do ambiente errado, conta sem credencial), e o
    // ErrorBoundary só mostra `message` em desenvolvimento. Como Response, aparece
    // em produção também — e é orientação de configuração, não dado sensível.
    throw new Response(
      erro instanceof Error ? erro.message : "Falha ao buscar o boleto no Inter",
      { status: 503 }
    )
  }

  const sufixo = cobranca.parcelas > 1 ? `-parcela-${cobranca.parcela}` : ""

  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="boleto-venda-${cobranca.vendaNumero}${sufixo}.pdf"`,
      "cache-control": "private, max-age=300",
    },
  })
}
