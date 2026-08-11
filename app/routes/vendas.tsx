import { useCallback, useEffect, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { Receipt } from "lucide-react"

import type { Route } from "./+types/vendas"
import { Topo } from "~/components/pdv/topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { db } from "~/lib/db.server"
import { cancelarVenda } from "~/lib/estoque.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { FORMAS_PAGAMENTO } from "~/lib/pdv"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

const OPERADOR = "Marcio"
const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export function meta(_: Route.MetaArgs) {
  return [{ title: "Vendas — BrasSaco" }]
}

export async function loader() {
  const vendas = await db.venda.findMany({
    orderBy: { numero: "desc" },
    take: 100,
  })

  const validas = vendas.filter((venda) => !venda.canceladaEm)

  return {
    vendas,
    resumo: {
      quantidade: validas.length,
      faturamento: validas.reduce((acc, venda) => acc + venda.total, 0),
      canceladas: vendas.length - validas.length,
    },
  }
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData()
  const vendaId = String(form.get("vendaId") ?? "")

  if (!OBJECT_ID.test(vendaId)) {
    return data({ ok: false as const, erro: "Venda inválida" }, { status: 400 })
  }

  const resultado = await cancelarVenda(vendaId, OPERADOR)
  if (!resultado.ok) return data(resultado, { status: 400 })

  return {
    ok: true as const,
    mensagem: `Venda #${resultado.numero} cancelada · ${resultado.estornados} ${
      resultado.estornados === 1 ? "item estornado" : "itens estornados"
    }`,
  }
}

export default function Vendas({ loaderData }: Route.ComponentProps) {
  const { vendas, resumo } = loaderData

  const [indiceAtivo, setIndiceAtivo] = useState(0)
  const [confirmando, setConfirmando] = useState<string | null>(null)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const linhaAtiva = useRef<HTMLTableRowElement>(null)
  const ultimaResposta = useRef<unknown>(null)
  const fetcher = useFetcher<typeof action>()
  const cancelando = fetcher.state !== "idle"

  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao()

  const ativa = vendas[indiceAtivo]

  useEffect(() => {
    linhaAtiva.current?.scrollIntoView({ block: "nearest" })
  }, [indiceAtivo])

  const avisar = useCallback((texto: string, tipo: "erro" | "sucesso") => {
    setAviso({ texto, tipo })
  }, [])

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 5000)
    return () => clearTimeout(id)
  }, [aviso])

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data

    setConfirmando(null)
    avisar(
      fetcher.data.ok ? fetcher.data.mensagem : fetcher.data.erro,
      fetcher.data.ok ? "sucesso" : "erro"
    )
  }, [fetcher.state, fetcher.data, avisar])

  const pedirCancelamento = useCallback(() => {
    if (!ativa || cancelando) return
    if (ativa.canceladaEm) {
      avisar(`Venda #${ativa.numero} já está cancelada`, "erro")
      return
    }
    // Cancelar estorna estoque; exige uma segunda confirmação deliberada.
    setConfirmando(ativa.id)
  }, [ativa, avisar, cancelando])

  const confirmarCancelamento = useCallback(() => {
    if (!confirmando) return
    fetcher.submit({ vendaId: confirmando }, { method: "post" })
  }, [confirmando, fetcher])

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      const { key, ctrlKey, shiftKey, altKey } = evento

      if (ctrlKey && !shiftKey && !altKey && key === "F6") {
        evento.preventDefault()
        alternar()
        return
      }

      // Ctrl+F1..F3 navegam (ver ~/lib/navegacao); o resto é sem modificador.
      if (ctrlKey || altKey || evento.metaKey) return

      if (confirmando) {
        if (key === "Enter") {
          evento.preventDefault()
          confirmarCancelamento()
        } else if (key === "Escape") {
          evento.preventDefault()
          setConfirmando(null)
        }
        return
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        evento.preventDefault()
        const delta = key === "ArrowDown" ? 1 : -1
        setIndiceAtivo((atual) =>
          Math.min(Math.max(atual + delta, 0), Math.max(vendas.length - 1, 0))
        )
        return
      }

      if (key === "F9" || key === "Delete") {
        evento.preventDefault()
        pedirCancelamento()
      }
    }

    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [alternar, confirmando, confirmarCancelamento, pedirCancelamento, vendas.length])

  const vendaConfirmando = vendas.find((venda) => venda.id === confirmando)

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={OPERADOR}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      >
        <span>
          <b className="font-semibold text-foreground">{resumo.quantidade}</b>{" "}
          {resumo.quantidade === 1 ? "venda" : "vendas"} ·{" "}
          <b className="font-semibold text-foreground">{moeda(resumo.faturamento)}</b>
          {resumo.canceladas > 0
            ? ` · ${resumo.canceladas} ${resumo.canceladas === 1 ? "cancelada" : "canceladas"}`
            : ""}
        </span>
      </Topo>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="w-20 px-5 py-2.5 text-left font-semibold">
                    Venda
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                    Quando
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                    Itens
                  </th>
                  <th scope="col" className="w-24 px-2 py-2.5 text-left font-semibold">
                    Forma
                  </th>
                  <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">
                    Total
                  </th>
                  <th scope="col" className="w-32 px-5 py-2.5 text-left font-semibold">
                    Situação
                  </th>
                </tr>
              </thead>
              <tbody>
                {vendas.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-16 text-center">
                      <Receipt
                        className="mx-auto size-10 text-muted-foreground/40"
                        aria-hidden
                      />
                      <p className="mt-3 text-sm text-muted-foreground">
                        Nenhuma venda registrada ainda.
                      </p>
                    </td>
                  </tr>
                ) : (
                  vendas.map((venda, indice) => {
                    const selecionada = indice === indiceAtivo
                    const cancelada = Boolean(venda.canceladaEm)
                    return (
                      <tr
                        key={venda.id}
                        ref={selecionada ? linhaAtiva : undefined}
                        onClick={() => setIndiceAtivo(indice)}
                        aria-current={selecionada ? "true" : undefined}
                        className={cn(
                          "cursor-default border-b border-border transition-colors",
                          selecionada
                            ? "bg-accent shadow-[inset_3px_0_0_var(--primary)]"
                            : "hover:bg-muted/40",
                          cancelada && "opacity-60"
                        )}
                      >
                        <td className="px-5 py-2.5 font-mono font-semibold tabular-nums">
                          #{venda.numero}
                        </td>
                        <td className="px-2 py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                          {new Date(venda.criadaEm).toLocaleString("pt-BR", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </td>
                        <td className="max-w-sm px-2 py-2.5 text-xs text-muted-foreground">
                          {venda.itens.length}{" "}
                          {venda.itens.length === 1 ? "produto" : "produtos"} ·{" "}
                          <span className="truncate">
                            {venda.itens
                              .map(
                                (item) =>
                                  `${formatarQuantidade(item.quantidade)}× ${item.descricao}`
                              )
                              .join(", ")}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-xs">
                          {FORMAS_PAGAMENTO.find((f) => f.id === venda.forma)?.rotulo ??
                            venda.forma}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right font-mono font-medium tabular-nums",
                            cancelada && "line-through"
                          )}
                        >
                          {moeda(venda.total)}
                        </td>
                        <td className="px-5 py-2.5">
                          {cancelada ? (
                            <Badge variant="destructive" className="text-[10px]">
                              cancelada
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                tabIndex={-1}
                variant="destructive"
                size="sm"
                disabled={!ativa || Boolean(ativa?.canceladaEm) || cancelando}
                onClick={pedirCancelamento}
                className="rounded-lg"
              >
                <Kbd>F9</Kbd> Cancelar venda
              </Button>
              <span className="ml-1 text-xs text-muted-foreground">
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> escolhe a venda · o cancelamento estorna o
                estoque
              </span>
            </div>

            {aviso ? (
              <span
                className={cn(
                  "text-xs font-medium",
                  aviso.tipo === "erro" ? "text-destructive" : "text-foreground"
                )}
                role="status"
              >
                {aviso.texto}
              </span>
            ) : null}
          </div>
        </section>
      </div>

      {vendaConfirmando ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar cancelamento"
          className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-8 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
            <h2 className="text-base font-semibold">
              Cancelar a venda #{vendaConfirmando.numero}?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {moeda(vendaConfirmando.total)} em{" "}
              {FORMAS_PAGAMENTO.find((f) => f.id === vendaConfirmando.forma)?.rotulo}.{" "}
              {vendaConfirmando.itens.length === 1
                ? "O item volta"
                : `Os ${vendaConfirmando.itens.length} itens voltam`}{" "}
              para o estoque. A venda não é apagada — fica marcada como cancelada.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                tabIndex={-1}
                variant="outline"
                onClick={() => setConfirmando(null)}
                className="rounded-lg"
              >
                <Kbd>Esc</Kbd> Voltar
              </Button>
              <Button
                type="button"
                tabIndex={-1}
                variant="destructive"
                disabled={cancelando}
                onClick={confirmarCancelamento}
                className="rounded-lg"
              >
                {cancelando ? "Cancelando…" : "Confirmar"}
                {cancelando ? null : <Kbd>Enter</Kbd>}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
