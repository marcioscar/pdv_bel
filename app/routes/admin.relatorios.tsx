import { Link, useSearchParams } from "react-router"
import { BarChart3 } from "lucide-react"

import type { Route } from "./+types/admin.relatorios"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { db } from "~/lib/db.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { FORMAS_PAGAMENTO } from "~/lib/pdv"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Relatórios — BrasSaco" }]
}

const PERIODOS = [
  { dias: 1, rotulo: "Hoje" },
  { dias: 7, rotulo: "7 dias" },
  { dias: 30, rotulo: "30 dias" },
  { dias: 365, rotulo: "12 meses" },
] as const

/**
 * Venda cancelada não conta em faturamento nenhum.
 *
 * O OR existe porque no Mongo o campo de uma venda nunca cancelada está
 * AUSENTE do documento, e ausente não casa com `null` no Prisma. Sem isto o
 * filtro devolvia zero vendas.
 */
const NAO_CANCELADA = {
  OR: [{ canceladaEm: null }, { canceladaEm: { isSet: false } }],
}

type ItemVendido = { _id: string; quantidade: number; total: number }

export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const url = new URL(request.url)
  const pedido = Number(url.searchParams.get("dias"))
  const dias = PERIODOS.some((p) => p.dias === pedido) ? pedido : 7

  const inicio = new Date()
  inicio.setDate(inicio.getDate() - (dias - 1))
  inicio.setHours(0, 0, 0, 0)

  const noPeriodo = { criadaEm: { gte: inicio } }

  const [porForma, canceladas, porSituacao, maisVendidos] = await Promise.all([
    db.venda.groupBy({
      by: ["forma"],
      where: { ...noPeriodo, ...NAO_CANCELADA },
      _sum: { total: true },
      _count: { _all: true },
    }),
    db.venda.count({ where: { ...noPeriodo, NOT: NAO_CANCELADA } }),
    // Contas a receber não são do período: o que está em aberto está em aberto.
    db.cobranca.groupBy({
      by: ["situacao"],
      _sum: { valor: true },
      _count: { _all: true },
    }),
    // Itens ficam embutidos na venda, então o ranking precisa de $unwind — e aqui
    // `canceladaEm: null` casa com ausente, porque é consulta do Mongo, não do Prisma.
    db.venda.aggregateRaw({
      pipeline: [
        {
          $match: {
            criadaEm: { $gte: { $date: inicio.toISOString() } },
            canceladaEm: null,
          },
        },
        { $unwind: "$itens" },
        {
          $group: {
            _id: "$itens.descricao",
            quantidade: { $sum: "$itens.quantidade" },
            total: { $sum: "$itens.subtotal" },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ],
    }),
  ])

  const vendas = porForma.reduce((acc, f) => acc + f._count._all, 0)
  const faturamento = porForma.reduce((acc, f) => acc + (f._sum.total ?? 0), 0)

  return {
    dias,
    inicio: inicio.toISOString(),
    resumo: {
      vendas,
      faturamento,
      ticket: vendas > 0 ? faturamento / vendas : 0,
      canceladas,
    },
    porForma: porForma
      .map((f) => ({
        forma: f.forma,
        vendas: f._count._all,
        total: f._sum.total ?? 0,
      }))
      .sort((a, b) => b.total - a.total),
    cobrancas: porSituacao
      .map((s) => ({
        situacao: s.situacao,
        quantidade: s._count._all,
        total: s._sum.valor ?? 0,
      }))
      .sort((a, b) => b.total - a.total),
    maisVendidos: (maisVendidos as unknown as ItemVendido[]).map((i) => ({
      descricao: i._id,
      quantidade: i.quantidade,
      total: i.total,
    })),
  }
}

export default function AdminRelatorios({ loaderData }: Route.ComponentProps) {
  const { dias, inicio, resumo, porForma, cobrancas, maisVendidos } = loaderData
  const [, setParams] = useSearchParams()

  const aReceber = cobrancas.find((c) => c.situacao === "A_RECEBER")
  const recebido = cobrancas.find((c) => c.situacao === "RECEBIDO")
  const maiorForma = Math.max(1, ...porForma.map((f) => f.total))

  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Relatórios</h1>
        <div className="ml-auto flex gap-1">
          {PERIODOS.map((p) => (
            <Button
              key={p.dias}
              type="button"
              size="sm"
              variant={p.dias === dias ? "default" : "outline"}
              onClick={() => setParams({ dias: String(p.dias) })}
              className="rounded-lg"
            >
              {p.rotulo}
            </Button>
          ))}
        </div>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        A partir de {new Date(inicio).toLocaleDateString("pt-BR")} · venda cancelada
        não entra em nada aqui
      </p>

      <div className="mt-5 grid max-w-5xl gap-3 sm:grid-cols-4">
        <Numero rotulo="Faturamento" valor={moeda(resumo.faturamento)} destaque />
        <Numero rotulo="Vendas" valor={String(resumo.vendas)} />
        <Numero rotulo="Ticket médio" valor={moeda(resumo.ticket)} />
        <Numero
          rotulo="Canceladas"
          valor={String(resumo.canceladas)}
          alerta={resumo.canceladas > 0}
        />
      </div>

      <div className="mt-6 grid max-w-5xl gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Por forma de pagamento
          </h2>
          {porForma.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhuma venda no período.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {porForma.map((f) => (
                <li key={f.forma}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span>
                      {FORMAS_PAGAMENTO.find((x) => x.id === f.forma)?.rotulo ?? f.forma}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {f.vendas} {f.vendas === 1 ? "venda" : "vendas"}
                      </span>
                    </span>
                    <span className="font-mono font-medium tabular-nums">
                      {moeda(f.total)}
                    </span>
                  </div>
                  {/* Barra proporcional: comparar números longos de cabeça é lento. */}
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(2, (f.total / maiorForma) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-6 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Boletos (todo o período)
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Numero
              rotulo="A receber"
              valor={moeda(aReceber?.total ?? 0)}
              detalhe={`${aReceber?.quantidade ?? 0} em aberto`}
            />
            <Numero
              rotulo="Recebido"
              valor={moeda(recebido?.total ?? 0)}
              detalhe={`${recebido?.quantidade ?? 0} pagos`}
            />
          </div>
          {cobrancas.filter((c) => c.situacao !== "A_RECEBER" && c.situacao !== "RECEBIDO")
            .length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cobrancas
                .filter((c) => c.situacao !== "A_RECEBER" && c.situacao !== "RECEBIDO")
                .map((c) => (
                  <Badge key={c.situacao} variant="outline" className="font-mono text-[10px]">
                    {c.situacao} {c.quantidade}
                  </Badge>
                ))}
            </div>
          ) : null}
        </section>

        <section>
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Mais vendidos no período
          </h2>
          {maisVendidos.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum item vendido no período.
            </p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2 text-left font-semibold">Produto</th>
                  <th scope="col" className="w-20 py-2 text-right font-semibold">Qtd</th>
                  <th scope="col" className="w-28 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {maisVendidos.map((item) => (
                  <tr key={item.descricao} className="border-b border-border">
                    <td className="max-w-xs truncate py-2">{item.descricao}</td>
                    <td className="py-2 text-right font-mono text-xs tabular-nums">
                      {formatarQuantidade(item.quantidade)}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {moeda(item.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="mt-4 text-[11px] text-muted-foreground">
            Venda a venda, com quem operou e o que foi cobrado, fica em{" "}
            <Link to="/vendas" className="underline">
              Vendas
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  detalhe,
  destaque,
  alerta,
}: {
  rotulo: string
  valor: string
  detalhe?: string
  destaque?: boolean
  alerta?: boolean
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono font-bold tabular-nums",
          destaque ? "text-2xl" : "text-xl",
          alerta && "text-destructive"
        )}
      >
        {valor}
      </div>
      {detalhe ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{detalhe}</div>
      ) : null}
    </div>
  )
}
