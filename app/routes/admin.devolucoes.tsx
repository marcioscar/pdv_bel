import { data, Link, useFetcher } from "react-router"
import { FileText, Undo2 } from "lucide-react"

import type { Route } from "./+types/admin.devolucoes"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { db } from "~/lib/db.server"
import { listarDevolucoes } from "~/lib/devolucoes.server"
import { emitirDaDevolucao } from "~/lib/nota-fiscal.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Devoluções — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "devolverMercadoria")

  const devolucoes = await listarDevolucoes(eu.lojasPermitidas)

  /*
   * As notas de devolução vêm por `ref`, não por `vendaId`: a nota é da
   * devolução, e gravá-la na venda faria a tela de Vendas mostrar duas notas
   * para a mesma venda — uma delas de entrada.
   */
  const notas = await db.notaFiscalEmitida.findMany({
    where: { ref: { in: devolucoes.map((d) => `devolucao-${d.id}`) } },
    select: { ref: true, status: true, numero: true, chave: true, erro: true, caminhoDanfe: true },
  })
  const porRef = new Map(notas.map((n) => [n.ref, n]))

  return {
    devolucoes: devolucoes.map((d) => ({
      id: d.id,
      numero: d.numero,
      loja: d.loja,
      criadaEm: d.criadaEm.toISOString(),
      vendaId: d.vendaId,
      vendaNumero: d.vendaNumero,
      clienteNome: d.clienteNome,
      itens: d.itens,
      total: d.total,
      motivo: d.motivo,
      operador: d.operador,
      emEspecie: Boolean(d.movimentoCaixaId),
      nota: porRef.get(`devolucao-${d.id}`) ?? null,
    })),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "devolverMercadoria")

  const form = await request.formData()
  const resultado = await emitirDaDevolucao(String(form.get("id") ?? ""), {
    emitidaPor: eu.nome,
  })

  return resultado.ok
    ? { ok: true as const, mensagem: `Nota ${resultado.status}` }
    : data({ ok: false as const, erro: resultado.erro }, { status: 400 })
}

export default function Devolucoes({ loaderData }: Route.ComponentProps) {
  const { devolucoes } = loaderData
  const fetcher = useFetcher<typeof action>()

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Undo2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Devoluções</h1>
        <span className="text-xs text-muted-foreground">
          Mercadoria que voltou depois que a venda virou fato — a venda continua de pé
        </span>
      </div>

      {fetcher.data ? (
        <p
          className={cn(
            "mt-3 rounded-lg px-3 py-2 text-sm",
            fetcher.data.ok
              ? "bg-muted/60 text-muted-foreground"
              : "bg-destructive/10 text-destructive"
          )}
          role="status"
        >
          {fetcher.data.ok ? fetcher.data.mensagem : fetcher.data.erro}
        </p>
      ) : null}

      {devolucoes.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border py-16 text-center">
          <Undo2 className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhuma devolução registrada. Ela nasce na tela de Vendas, na venda que o
            cliente trouxe de volta.
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {devolucoes.map((d) => (
            <li key={d.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-semibold">#{d.numero}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {d.loja}
                </Badge>
                <Link
                  to={`/vendas?numero=${d.vendaNumero}`}
                  className="text-xs underline decoration-dotted underline-offset-2"
                >
                  venda #{d.vendaNumero}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {new Date(d.criadaEm).toLocaleString("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                  {d.clienteNome ? ` · ${d.clienteNome}` : ""} · {d.operador}
                </span>
                <span className="ml-auto font-mono font-semibold tabular-nums">
                  {moeda(d.total)}
                </span>
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
                {d.itens
                  .map((i) => `${formatarQuantidade(i.quantidade)} ${i.unidade} ${i.descricao}`)
                  .join(" · ")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {d.motivo}
                {d.emEspecie ? " · dinheiro devolvido pela gaveta" : " · acerto por fora"}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
                {d.nota?.status === "autorizado" ? (
                  <Badge variant="outline" className="text-[10px]">
                    NF-e {d.nota.numero} autorizada
                  </Badge>
                ) : d.nota?.status === "processando_autorizacao" ? (
                  <Badge variant="outline" className="text-[10px]">
                    NF-e processando
                  </Badge>
                ) : (
                  <>
                    {d.nota?.erro ? (
                      <span className="text-xs text-destructive">{d.nota.erro}</span>
                    ) : null}
                    <fetcher.Form method="post">
                      <input type="hidden" name="id" value={d.id} />
                      <Button
                        type="submit"
                        size="xs"
                        variant="outline"
                        disabled={fetcher.state !== "idle"}
                        className="rounded-lg"
                      >
                        <FileText className="size-3.5" />
                        {d.nota ? "Tentar a NF-e de novo" : "Emitir NF-e de devolução"}
                      </Button>
                    </fetcher.Form>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
