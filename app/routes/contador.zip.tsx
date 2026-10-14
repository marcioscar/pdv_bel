import type { Route } from "./+types/contador.zip"
import { mesValido, montarZip } from "~/lib/contador.server"
import { exigirGerente } from "~/lib/sessao.server"

/**
 * O ZIP dos XMLs do mês de uma loja, para baixar e conferir (ou mandar por
 * fora). O mesmo arquivo que vai no e-mail à contadora.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "enviarAoContador")
  const url = new URL(request.url)
  const loja = url.searchParams.get("loja") ?? ""
  const mes = url.searchParams.get("mes") ?? ""
  const comCanceladas = url.searchParams.get("canceladas") !== "0"

  if (!eu.lojasPermitidas.includes(loja)) throw new Response("Loja não permitida", { status: 403 })
  if (!mesValido(mes)) throw new Response("Mês inválido", { status: 400 })

  const { zip, nome, faltando } = await montarZip(loja, mes, comCanceladas)
  if (faltando.length > 0) {
    throw new Response(
      `Não deu para baixar o XML de ${faltando.length} nota(s) na Focus: ${faltando.join(", ")}. Tente de novo.`,
      { status: 502 }
    )
  }
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${nome}"`,
      "cache-control": "no-store",
    },
  })
}
