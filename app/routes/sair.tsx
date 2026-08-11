import type { Route } from "./+types/sair"
import { encerrarSessao } from "~/lib/sessao.server"

/** Só POST: um GET permitiria deslogar o operador com um link ou uma imagem. */
export async function action({ request }: Route.ActionArgs) {
  return encerrarSessao(request)
}

export function loader() {
  return new Response(null, { status: 302, headers: { location: "/" } })
}
