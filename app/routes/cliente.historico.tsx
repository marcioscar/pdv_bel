import type { Route } from "./+types/cliente.historico"
import { historicoDoCliente } from "~/lib/clientes.server"
import { exigirUsuario } from "~/lib/sessao.server"

/**
 * O histórico de compras de um cliente, sob demanda.
 *
 * Rota de dados, sem tela própria: é o diálogo do cadastro de clientes que a
 * consulta quando alguém abre o histórico. Carregar junto com a lista traria as
 * compras de todos os clientes a cada abertura da tela — e são as de UM que
 * interessam, quando a pergunta é feita.
 *
 * Aberta a operador, como o cadastro: quem atende o telefone é quem precisa
 * responder "o que o senhor levou da última vez".
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  await exigirUsuario(request)

  const compras = await historicoDoCliente(params.clienteId ?? "")

  return {
    compras: compras.map((compra) => ({
      ...compra,
      criadaEm: compra.criadaEm.toISOString(),
      canceladaEm: compra.canceladaEm?.toISOString() ?? null,
    })),
  }
}

export type HistoricoDoCliente = Awaited<ReturnType<typeof loader>>
