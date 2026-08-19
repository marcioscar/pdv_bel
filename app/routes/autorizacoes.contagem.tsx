import type { Route } from "./+types/autorizacoes.contagem"
import { contagemDeAutorizacoes } from "~/lib/autorizacao.server"
import { ehGerente } from "~/lib/permissoes"
import { exigirUsuario } from "~/lib/sessao.server"

/**
 * Os dois números do indicador no topo, consultados de tempos em tempos por
 * todas as telas.
 *
 * Rota separada e minúscula de propósito: fazer o topo revalidar a página
 * inteira a cada meio minuto recarregaria o catálogo do caixa e a lista de
 * vendas junto — e o caixa é justamente a tela que não pode piscar com cliente
 * na frente.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)
  const contagem = await contagemDeAutorizacoes(eu)

  return {
    // O operador não decide nada: mandar o número da fila para ele seria
    // mostrar um alerta sobre o qual não pode agir.
    aDecidir: ehGerente(eu.papel) ? contagem.aDecidir : 0,
    respondidas: contagem.respondidas,
  }
}
