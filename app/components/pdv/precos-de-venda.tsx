import { useState } from "react"
import { useFetcher } from "react-router"

import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  centavos,
  markupPorPreco,
  precoPorMarkup,
  propostaDeMarkup,
  textoDeMarkup,
  textoDePreco,
} from "~/lib/markup"
import { interpretarValor, moeda } from "~/lib/moeda"
import { conferirPrecoVenda } from "~/lib/precificacao"
import type { PercentuaisDaOperacao } from "~/lib/precificacao.server"
import { cn } from "~/lib/utils"

export type ItemParaPrecificar = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  /** O custo unitário da entrada — é sobre ele que o markup é aplicado. */
  custo: number
  precoHoje: number | null
  /** O custo de ANTES desta entrada: daí sai o markup que se propõe manter. */
  custoAnterior: number | null
}

export type RespostaPrecos =
  | { intencao: "atualizarPrecos"; ok: true; alterados: number }
  | { intencao: "atualizarPrecos"; ok: false; erro: string }

/**
 * O preço de venda novo a partir do custo de uma entrada já lançada — o mesmo
 * cálculo da nota de entrada e da digitação da AF (ver `~/lib/markup`), para o
 * documento que já está no estoque e cujo preço ficou para depois.
 *
 * Envia `intencao: "atualizarPrecos"` com os itens para a action da rota, que
 * grava pelo `alterarPrecos` (com histórico).
 */
export function PrecosDeVenda({
  itens,
  percentuais,
}: {
  itens: ItemParaPrecificar[]
  percentuais: PercentuaisDaOperacao | null
}) {
  const fetcher = useFetcher<RespostaPrecos>()
  const [editados, setEditados] = useState<
    Record<string, { markup?: string; preco?: string; fixo: "markup" | "preco" }>
  >({})
  const [manter, setManter] = useState<Set<string>>(new Set())
  const [markupTodos, setMarkupTodos] = useState("")

  // Um produto pode aparecer em duas linhas da entrada; o preço é um só.
  const unicos = [...new Map(itens.map((i) => [i.produtoId, i])).values()]

  const linhas = unicos.map((item) => {
    const proposta = propostaDeMarkup({
      custo: item.custo,
      precoHoje: item.precoHoje,
      custoAnterior: item.custoAnterior,
    })
    const ed = editados[item.produtoId]
    let markup = proposta.markup
    let preco = proposta.preco
    if (ed?.fixo === "markup") {
      markup = ed.markup ?? ""
      const m = interpretarValor(markup)
      preco = m != null && item.custo > 0 ? textoDePreco(precoPorMarkup(item.custo, m)) : ""
    } else if (ed?.fixo === "preco") {
      preco = ed.preco ?? ""
      const p = interpretarValor(preco)
      markup = p != null && p > 0 && item.custo > 0 ? textoDeMarkup(markupPorPreco(item.custo, p)) : ""
    }
    return { ...item, markup, preco }
  })

  const aAtualizar = linhas.flatMap((l) => {
    if (manter.has(l.produtoId)) return []
    const novo = interpretarValor(l.preco)
    if (novo == null || !(novo > 0) || centavos(novo) === centavos(l.precoHoje ?? 0)) return []
    return [{ produtoId: l.produtoId, preco: centavos(novo) }]
  })

  function aplicarATodos() {
    if (interpretarValor(markupTodos) == null) return
    setEditados(
      Object.fromEntries(
        unicos.map((i) => [i.produtoId, { markup: markupTodos, fixo: "markup" as const }])
      )
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <h3 className="mr-2 text-sm font-medium">Preço de venda</h3>
        <span className="text-muted-foreground">Markup para todos</span>
        <Input
          value={markupTodos}
          onChange={(e) => setMarkupTodos(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              aplicarATodos()
            }
          }}
          inputMode="decimal"
          placeholder="ex. 40"
          className="h-7 w-16 text-right font-mono text-xs"
        />
        <span className="text-muted-foreground">%</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={interpretarValor(markupTodos) == null}
          onClick={aplicarATodos}
        >
          Aplicar
        </Button>
      </div>

      <div className="mt-2 overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-muted-foreground">
              <th className="px-2 py-1.5">Produto</th>
              <th className="w-24 px-2 py-1.5 text-right">Custo</th>
              <th className="w-28 px-2 py-1.5 text-right">Preço hoje</th>
              <th className="w-24 px-2 py-1.5 text-right">Markup</th>
              <th className="w-36 px-2 py-1.5 text-right">Novo preço</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => {
              const novo = interpretarValor(l.preco)
              const conferencia =
                percentuais?.temDados && novo != null && novo > 0 && l.custo > 0
                  ? conferirPrecoVenda({
                      custo: l.custo,
                      preco: novo,
                      pctFixos: percentuais.pctFixas,
                      pctVariaveis: percentuais.pctVariaveis,
                    })
                  : null
              return (
                <tr key={l.produtoId} className="border-b last:border-0">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{l.descricao}</div>
                    <div className="font-mono text-muted-foreground">{l.codigo}</div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{moeda(l.custo)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {l.precoHoje ? (
                      <>
                        <div>{moeda(l.precoHoje)}</div>
                        {l.custo > 0 ? (
                          <div
                            className={cn(
                              "text-[11px]",
                              l.precoHoje <= l.custo
                                ? "font-medium text-destructive"
                                : "text-muted-foreground"
                            )}
                          >
                            {markupPorPreco(l.custo, l.precoHoje).toFixed(0)}% s/ custo
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">sem preço</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Input
                        value={l.markup}
                        disabled={!(l.custo > 0)}
                        onChange={(e) =>
                          setEditados((a) => ({
                            ...a,
                            [l.produtoId]: { markup: e.target.value, fixo: "markup" },
                          }))
                        }
                        inputMode="decimal"
                        className="h-7 w-16 text-right font-mono text-xs"
                      />
                      <span className="text-muted-foreground">%</span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <input
                        type="checkbox"
                        checked={!manter.has(l.produtoId)}
                        onChange={(e) =>
                          setManter((a) => {
                            const novoSet = new Set(a)
                            if (e.target.checked) novoSet.delete(l.produtoId)
                            else novoSet.add(l.produtoId)
                            return novoSet
                          })
                        }
                        title="Atualizar o preço de venda deste produto"
                        className="size-3.5"
                      />
                      <Input
                        value={l.preco}
                        disabled={!(l.custo > 0)}
                        onChange={(e) =>
                          setEditados((a) => ({
                            ...a,
                            [l.produtoId]: { preco: e.target.value, fixo: "preco" },
                          }))
                        }
                        inputMode="decimal"
                        className="h-7 w-20 text-right font-mono text-xs"
                      />
                    </div>
                    <div className="text-right text-[11px]">
                      <span className="text-muted-foreground">/{l.unidade}</span>
                      {novo != null && novo > 0 && novo < l.custo ? (
                        <span className="ml-1 font-medium text-destructive">· abaixo do custo</span>
                      ) : conferencia?.status === "prejuizo" ? (
                        <span className="ml-1 font-medium text-destructive">· dá prejuízo</span>
                      ) : conferencia?.status === "empate" ? (
                        <span className="ml-1 text-amber-600 dark:text-amber-500">· empata</span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={aAtualizar.length === 0 || fetcher.state !== "idle"}
          onClick={() =>
            fetcher.submit(
              { intencao: "atualizarPrecos", itens: JSON.stringify(aAtualizar) },
              { method: "post" }
            )
          }
        >
          {fetcher.state !== "idle"
            ? "Atualizando…"
            : aAtualizar.length === 0
              ? "Nenhum preço de venda a mudar"
              : `Atualizar ${aAtualizar.length} ${aAtualizar.length === 1 ? "preço" : "preços"} de venda`}
        </Button>
        {fetcher.data?.intencao === "atualizarPrecos" ? (
          fetcher.data.ok ? (
            <span className="text-muted-foreground">
              {fetcher.data.alterados}{" "}
              {fetcher.data.alterados === 1 ? "preço atualizado" : "preços atualizados"} no catálogo
            </span>
          ) : (
            <span className="text-destructive">{fetcher.data.erro}</span>
          )
        ) : null}
        <span className="text-muted-foreground">
          Preço = custo × (1 + markup). Começa no markup que o produto tinha antes desta entrada.
        </span>
      </div>
    </div>
  )
}
