import type { Route } from "./+types/nota.danfe"
import { db } from "~/lib/db.server"
import { urlDoArquivo } from "~/lib/focus.server"
import { exigirUsuario, podeVerDaLoja } from "~/lib/sessao.server"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * O DANFE da nota, servido pelo próprio sistema.
 *
 * O documento mora na Focus, e bastaria abrir o endereço de lá — mas a
 * impressão do caixa baixa o documento e o põe num iframe, e esse `fetch` é do
 * NAVEGADOR: cross-origin, sem CORS na resposta da Focus, ele falha e o cliente
 * fica sem papel. Buscar aqui, de servidor para servidor, não tem esse limite.
 *
 * A `<base>` injetada resolve o resto: o HTML da Focus referencia imagem e
 * estilo por caminho relativo, que sob o nosso domínio apontariam para o nada —
 * o DANFE sairia sem o logo da loja.
 *
 * NFC-e vem em HTML no tamanho da bobina; NF-e vem em PDF A4. O tipo que chega é
 * o tipo que sai.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  if (!OBJECT_ID.test(params.notaId ?? "")) {
    throw new Response("Nota inválida", { status: 400 })
  }

  const nota = await db.notaFiscalEmitida.findUnique({ where: { id: params.notaId } })
  if (!nota) throw new Response("Nota não encontrada", { status: 404 })
  if (!podeVerDaLoja(eu, nota.loja)) {
    throw new Response(`Nota da loja ${nota.loja}`, { status: 403 })
  }
  if (!nota.caminhoDanfe) {
    throw new Response(
      nota.status === "autorizado"
        ? "A nota está autorizada, mas a Focus ainda não devolveu o documento"
        : `Nota ${nota.status.replace(/_/g, " ")} — ainda não há documento para imprimir`,
      { status: 409 }
    )
  }

  const endereco = urlDoArquivo(nota.caminhoDanfe)!
  const resposta = await fetch(endereco, { signal: AbortSignal.timeout(15000) })
  if (!resposta.ok) {
    throw new Response("A Focus não devolveu o documento agora", { status: 502 })
  }

  /*
   * Os dois modelos vêm em formatos diferentes: a NFC-e é HTML no tamanho da
   * bobina, a NF-e é PDF em A4. Repassar o tipo que veio é o que faz o navegador
   * abrir cada um do jeito certo — servir PDF como HTML mostra lixo binário.
   */
  const tipo = resposta.headers.get("content-type") ?? "application/octet-stream"
  const cabecalhos = {
    "content-type": tipo,
    // O DANFE não muda depois de autorizado, mas é documento fiscal de uma
    // venda: fica no navegador de quem imprimiu, e em nenhum cache no meio.
    "cache-control": "private, max-age=3600",
  }

  if (!tipo.includes("html")) {
    return new Response(await resposta.arrayBuffer(), { headers: cabecalhos })
  }

  // Só o HTML precisa da <base>: é ele que referencia o logo por caminho
  // relativo, que sob o nosso domínio apontaria para o nada.
  return new Response(comBase(await resposta.text(), new URL(endereco).origin), {
    headers: cabecalhos,
  })
}

function comBase(html: string, origem: string) {
  const base = `<base href="${origem}/">`
  return html.includes("<head")
    ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`)
    : `${base}${html}`
}
