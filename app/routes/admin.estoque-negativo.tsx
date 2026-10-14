import { useState } from "react"
import { data, Link, useFetcher } from "react-router"
import { Check, PackageX } from "lucide-react"

import type { Route } from "./+types/admin.estoque-negativo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  avisosPendentes,
  darCiencia,
  negativosAgora,
} from "~/lib/estoque-negativo.server"
import { quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Estoque negativo — BrasSaco" }]
}

/**
 * O estoque que ficou abaixo de zero, e a ciência do gerente.
 *
 * A venda e a transferência não recusam por falta de saldo — a mercadoria
 * chega antes da entrada lançada. Esta tela é o outro lado disso: os avisos
 * de cada documento que deixou um produto negativo (para dar ciência) e a
 * lista de quem continua negativo agora (para lançar a entrada que falta).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verEstoqueNegativo")
  const lojas = eu.lojasPermitidas
  const [pendentes, negativos] = await Promise.all([avisosPendentes(lojas), negativosAgora(lojas)])
  return {
    pendentes: pendentes.map((a) => ({ ...a, criadoEm: a.criadoEm.toISOString() })),
    negativos,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verEstoqueNegativo")
  const form = await request.formData()
  const todos = form.get("todos") === "1"
  const id = String(form.get("id") ?? "")
  if (!todos && !/^[0-9a-fA-F]{24}$/.test(id)) {
    return data({ ok: false as const, erro: "Aviso inválido" }, { status: 400 })
  }
  const quantos = await darCiencia({
    ids: todos ? "todos" : [id],
    lojas: eu.lojasPermitidas,
    gerente: eu.nome,
  })
  return { ok: true as const, quantos }
}

export default function EstoqueNegativo({ loaderData }: Route.ComponentProps) {
  const { pendentes, negativos } = loaderData
  const todos = useFetcher<typeof action>()
  const [ocultos, setOcultos] = useState<string[]>([])
  const visiveis = pendentes.filter((a) => !ocultos.includes(a.id))

  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <PackageX className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Estoque negativo</h1>
        <span className="text-xs text-muted-foreground">
          vendas e transferências feitas sem saldo — falta dar entrada na mercadoria
        </span>
      </div>

      <section className="mt-5">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">
            Avisos para dar ciência
            <Badge variant={visiveis.length > 0 ? "destructive" : "secondary"} className="ml-2">
              {visiveis.length}
            </Badge>
          </h2>
          {visiveis.length > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto rounded-lg"
              disabled={todos.state !== "idle"}
              onClick={() => {
                setOcultos(pendentes.map((a) => a.id))
                todos.submit({ todos: "1" }, { method: "post" })
              }}
            >
              <Check className="size-4" /> Ciente em todos
            </Button>
          ) : null}
        </div>

        {visiveis.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nenhum aviso esperando ciência.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="w-36 py-2 text-left font-semibold">Quando</th>
                  <th className="w-14 px-2 py-2 text-left font-semibold">Loja</th>
                  <th className="px-2 py-2 text-left font-semibold">Produto</th>
                  <th className="px-2 py-2 text-left font-semibold">Documento</th>
                  <th className="w-24 px-2 py-2 text-right font-semibold">Saiu</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Saldo depois</th>
                  <th className="w-24 px-2 py-2 text-right font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visiveis.map((a) => (
                  <LinhaAviso key={a.id} aviso={a} onCiente={() => setOcultos((o) => [...o, a.id])} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">
          Negativos agora
          <Badge variant="secondary" className="ml-2">
            {negativos.length}
          </Badge>
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Calculado do estoque, não dos avisos: some sozinho quando a entrada da mercadoria é
          lançada (nota de entrada, AF ou entrada manual).
        </p>
        {negativos.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nenhum produto abaixo de zero.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="w-14 py-2 text-left font-semibold">Loja</th>
                  <th className="w-24 px-2 py-2 text-left font-semibold">Código</th>
                  <th className="px-2 py-2 text-left font-semibold">Produto</th>
                  <th className="w-32 px-2 py-2 text-right font-semibold">Saldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {negativos.map((n) => (
                  <tr key={`${n.loja}-${n.produtoId}`}>
                    <td className="py-2 font-mono text-xs">{n.loja}</td>
                    <td className="px-2 py-2 font-mono text-xs">{n.codigo}</td>
                    <td className="px-2 py-2">
                      <Link
                        to={`/admin/ficha?produto=${n.produtoId}&loja=${n.loja}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {n.descricao}
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums text-destructive">
                      {formatarQuantidade(n.saldo)} {n.unidade}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

type Aviso = Route.ComponentProps["loaderData"]["pendentes"][number]

function LinhaAviso({ aviso, onCiente }: { aviso: Aviso; onCiente: () => void }) {
  const fetcher = useFetcher<typeof action>()
  return (
    <tr>
      <td className="py-2 text-xs tabular-nums text-muted-foreground">
        {new Date(aviso.criadoEm).toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })}
        <div>{aviso.operador}</div>
      </td>
      <td className="px-2 py-2 font-mono text-xs">{aviso.loja}</td>
      <td className="px-2 py-2">
        <div className="font-medium">{aviso.descricao}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{aviso.codigo}</div>
      </td>
      <td className="px-2 py-2 text-xs">{aviso.documento}</td>
      <td className="px-2 py-2 text-right tabular-nums">
        {formatarQuantidade(aviso.quantidade)} {aviso.unidade}
      </td>
      <td
        className={cn(
          "px-2 py-2 text-right font-semibold tabular-nums",
          aviso.saldoDepois < 0 && "text-destructive"
        )}
      >
        {formatarQuantidade(aviso.saldoDepois)} {aviso.unidade}
      </td>
      <td className="px-2 py-2 text-right">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={fetcher.state !== "idle"}
          onClick={() => {
            onCiente()
            fetcher.submit({ id: aviso.id }, { method: "post" })
          }}
        >
          <Check className="size-3.5" /> Ciente
        </Button>
      </td>
    </tr>
  )
}
