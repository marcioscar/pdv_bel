import type { Route } from "./+types/pix.pendentes"
import { ligarVigiaDoPix, pixDoCaixa } from "~/lib/pix-pendente.server"
import { exigirUsuario } from "~/lib/sessao.server"

/**
 * Os Pix da loja que o caixa precisa ver: os que esperam pagamento e os
 * desfechos que ninguém confirmou ter visto.
 *
 * Só lê o banco — quem pergunta ao Inter é a vigia do servidor. Por isso a
 * tela pode consultar a cada poucos segundos sem pesar na cota do banco.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)
  // Depois de um deploy, a primeira tela que pergunta religa a vigia.
  ligarVigiaDoPix()
  return { pendentes: await pixDoCaixa(eu.loja) }
}
