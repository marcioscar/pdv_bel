import type { Route } from "./+types/cliente.historico"
import { historicoDoCliente } from "~/lib/clientes.server"
import { extratoDeCredito, saldoDeCredito } from "~/lib/creditos.server"
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

  const clienteId = params.clienteId ?? ""
  // O crédito vem junto: é a outra pergunta do telefone — "eu não tinha um
  // crédito aí?" —, e a resposta precisa do extrato, não só do número.
  const [compras, saldo, extrato] = await Promise.all([
    historicoDoCliente(clienteId),
    saldoDeCredito(clienteId),
    extratoDeCredito(clienteId),
  ])

  return {
    credito: {
      saldo,
      extrato: extrato.map((m) => ({
        id: m.id,
        criadoEm: m.criadoEm.toISOString(),
        loja: m.loja,
        tipo: m.tipo,
        valor: m.valor,
        devolucaoNumero: m.devolucaoNumero,
        vendaNumero: m.vendaNumero,
        operador: m.operador,
        observacao: m.observacao,
      })),
    },
    compras: compras.map((compra) => ({
      ...compra,
      criadaEm: compra.criadaEm.toISOString(),
      canceladaEm: compra.canceladaEm?.toISOString() ?? null,
    })),
  }
}

export type HistoricoDoCliente = Awaited<ReturnType<typeof loader>>
