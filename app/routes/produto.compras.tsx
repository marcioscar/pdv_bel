import type { Route } from "./+types/produto.compras"
import { historicoDeCompras } from "~/lib/compras.server"
import { exigirGerente } from "~/lib/sessao.server"

/**
 * O histórico de compra de um produto, sob demanda.
 *
 * Mesmo desenho do histórico do cliente: rota de dados, sem tela própria, porque
 * quem pergunta é um diálogo que abre sobre a tela em que a pessoa já está — o
 * catálogo e a montagem do pedido. Carregar junto com a lista traria o histórico
 * de mil produtos para mostrar o de um.
 *
 * Gerente, e não operador: custo de compra é o que a rede paga, não o que ela
 * cobra — o mesmo critério que fecha as telas de Compras.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const historico = await historicoDeCompras(params.produtoId ?? "")

  return {
    produto: historico.produto,
    fornecedores: historico.fornecedores.map((f) => ({
      ...f,
      ultimaCompra: f.ultimaCompra?.toISOString() ?? null,
    })),
    compras: historico.compras.map((c) => ({ ...c, em: c.em.toISOString() })),
    pedidosAbertos: historico.pedidosAbertos.map((p) => ({
      ...p,
      em: p.em.toISOString(),
      entregaPrometida: p.entregaPrometida?.toISOString() ?? null,
    })),
  }
}

export type HistoricoDeCompras = Awaited<ReturnType<typeof loader>>
