import type { Route } from "./+types/admin.ncm"
import { buscarNcm, importarTabelaNcm, situacaoDaTabelaNcm } from "~/lib/ncm.server"
import { exigirGerente } from "~/lib/sessao.server"

/**
 * A consulta à tabela NCM, para quem estiver cadastrando produto.
 *
 * Rota própria, sem tela: são dez mil códigos, e mandá-los ao navegador junto
 * com a página seria dois megabytes por carregamento para uma busca que quase
 * ninguém faz. Fica separada do cadastro de produtos porque a conciliação de
 * nota também cadastra produto, e as duas telas perguntam o mesmo.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "editarProdutos")

  const url = new URL(request.url)
  const termo = url.searchParams.get("q") ?? ""

  const [achados, situacao] = await Promise.all([buscarNcm(termo), situacaoDaTabelaNcm()])
  return { achados, tabelaVazia: situacao.quantos === 0, situacao: situacao.ultima }
}

export type RespostaNcm =
  | { ok: true; quantidade: number; ato: string; vigencia: string }
  | { ok: false; erro: string }

/** Traz a tabela da fonte federal. Demora ~20s: são 3 MB e dez mil linhas. */
export async function action({ request }: Route.ActionArgs): Promise<RespostaNcm> {
  const eu = await exigirGerente(request, "editarProdutos")
  return importarTabelaNcm(eu.nome)
}
