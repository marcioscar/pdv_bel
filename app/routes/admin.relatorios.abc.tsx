import { useMemo, useRef, useState } from "react"
import { ListFilter, Search } from "lucide-react"

import type { Route } from "./+types/admin.relatorios.abc"
import { GraficoAbc } from "~/components/painel/graficos"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { curvaAbc, type Faixa } from "~/lib/abc.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Curva ABC — BrasSaco" }]
}

/**
 * A curva ABC inteira, e não só os dez do painel.
 *
 * O painel responde "quem são os maiores"; este relatório responde "onde está
 * o meu dinheiro" — e para isso precisa da lista toda, com filtro por faixa e
 * por grupo. É a tela que se abre quando a pergunta é qual produto cortar, qual
 * negociar com o fornecedor e qual não pode faltar na prateleira.
 *
 * A curva chega pronta e completa do servidor, e o filtro é do navegador: as
 * faixas e a participação de cada linha só existem contra o total de TODOS os
 * produtos. Filtrar no servidor e recalcular sobre o recorte daria uma faixa A
 * dentro de "Copos" — outra pergunta, com o mesmo nome, e ninguém perceberia a
 * troca.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")
  return { curva: await curvaAbc() }
}

const FAIXAS: { valor: Faixa | "todas"; rotulo: string }[] = [
  { valor: "todas", rotulo: "Todas" },
  { valor: "A", rotulo: "A" },
  { valor: "B", rotulo: "B" },
  { valor: "C", rotulo: "C" },
]

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

export default function RelatorioAbc({ loaderData }: Route.ComponentProps) {
  const { curva } = loaderData

  const [faixa, setFaixa] = useState<Faixa | "todas">("todas")
  const [grupo, setGrupo] = useState("todos")
  const [busca, setBusca] = useState("")
  const campoBusca = useRef<HTMLInputElement>(null)

  const grupos = useMemo(() => {
    if (!curva) return []
    const nomes = new Set<string>()
    for (const l of curva.linhas) if (l.grupoNome) nomes.add(l.grupoNome)
    return [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR"))
  }, [curva])

  const filtradas = useMemo(() => {
    if (!curva) return []
    const termo = normalizar(busca.trim())
    return curva.linhas.filter((l) => {
      if (faixa !== "todas" && l.faixa !== faixa) return false
      if (grupo !== "todos" && (l.grupoNome ?? "") !== grupo) return false
      if (!termo) return true
      return normalizar(l.descricao).includes(termo) || l.codigo.includes(busca.trim())
    })
  }, [busca, curva, faixa, grupo])

  const valorFiltrado = filtradas.reduce((s, l) => s + l.valor, 0)

  if (!curva) {
    return (
      <div className="px-5 py-16 text-center">
        <ListFilter className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
        <p className="mt-3 text-sm text-muted-foreground">
          Ainda não há curva: a política de compra nunca foi calculada.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ela nasce de <code>scripts/calcular-politica-de-compra.mjs</code>, sobre o
          histórico de vendas.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:gap-3 sm:px-5">
        <ListFilter className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Curva ABC</h1>
        <span className="shrink-0 text-xs text-muted-foreground">
          {curva.produtos.toLocaleString("pt-BR")} produtos · {moeda(curva.total)} no período
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---- As três faixas, que são a leitura inteira do relatório ---- */}
        <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-3 sm:px-5">
          {(["A", "B", "C"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFaixa(faixa === f ? "todas" : f)}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition-colors",
                faixa === f
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent/50"
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold">Faixa {f}</span>
                <span className="text-xs text-muted-foreground">
                  {f === "A"
                    ? "até 80% do valor"
                    : f === "B"
                      ? "os 15% seguintes"
                      : "os últimos 5%"}
                </span>
              </div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                {curva.faixas[f].produtos.toLocaleString("pt-BR")}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  produtos
                </span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {moeda(curva.faixas[f].valor)} · {curva.faixas[f].participacao.toFixed(1)}% do
                valor
              </div>
            </button>
          ))}
        </div>

        {/* ---- Filtros ---- */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5">
          <Input
            ref={campoBusca}
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            type="search"
            placeholder="Buscar por código ou descrição…"
            aria-label="Buscar produto na curva"
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full min-w-0 rounded-lg sm:max-w-xs"
          />

          <select
            value={grupo}
            onChange={(e) => setGrupo(e.target.value)}
            aria-label="Filtrar por grupo"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
          >
            <option value="todos">Todos os grupos</option>
            {grupos.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>

          <div className="flex gap-1">
            {FAIXAS.map((f) => (
              <Button
                key={f.valor}
                type="button"
                size="xs"
                variant={faixa === f.valor ? "secondary" : "ghost"}
                onClick={() => setFaixa(f.valor)}
                className="rounded-lg"
              >
                {f.rotulo}
              </Button>
            ))}
          </div>

          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {filtradas.length.toLocaleString("pt-BR")} linha
            {filtradas.length === 1 ? "" : "s"} · {moeda(valorFiltrado)}
            {filtradas.length !== curva.produtos ? (
              <> · {((valorFiltrado / curva.total) * 100).toFixed(1)}% do total</>
            ) : null}
          </span>
        </div>

        {filtradas.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Search className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              Nada encontrado com esses filtros.
            </p>
          </div>
        ) : (
          <>
            {/* Os dez maiores DO RECORTE — com "Copos" filtrado, são outros dez
                que os do painel, e é justamente essa a graça. */}
            <div className="border-b border-border px-4 py-4 sm:px-5">
              <h2 className="mb-2 text-sm font-semibold">
                Os {Math.min(10, filtradas.length)} maiores
                {grupo !== "todos" ? ` em ${grupo}` : ""}
                {faixa !== "todas" ? ` na faixa ${faixa}` : ""}
              </h2>
              <GraficoAbc linhas={filtradas.slice(0, 10)} />
            </div>

            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="w-20 px-4 py-2 font-semibold sm:px-5">
                    Código
                  </th>
                  <th scope="col" className="px-2 py-2 font-semibold">
                    Descrição
                  </th>
                  <th scope="col" className="w-40 px-2 py-2 font-semibold">
                    Grupo
                  </th>
                  <th scope="col" className="w-24 px-2 py-2 text-right font-semibold">
                    Qtd
                  </th>
                  <th scope="col" className="w-24 px-2 py-2 text-right font-semibold">
                    Preço
                  </th>
                  <th scope="col" className="w-28 px-2 py-2 text-right font-semibold">
                    Valor
                  </th>
                  <th scope="col" className="w-16 px-2 py-2 text-right font-semibold">
                    Part.
                  </th>
                  <th scope="col" className="w-16 px-2 py-2 text-right font-semibold">
                    Acum.
                  </th>
                  <th scope="col" className="w-14 px-4 py-2 text-right font-semibold sm:px-5">
                    Faixa
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtradas.map((l) => (
                  <tr key={l.produtoId} className="hover:bg-accent/40">
                    <td className="px-4 py-1.5 font-mono text-[10px] text-muted-foreground sm:px-5">
                      {l.codigo}
                    </td>
                    <td className="max-w-md truncate px-2 py-1.5" title={l.descricao}>
                      {l.descricao}
                    </td>
                    <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      {l.grupoNome ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {formatarQuantidade(l.quantidade)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {moeda(l.preco)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium">{moeda(l.valor)}</td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {l.participacao.toFixed(2)}%
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {l.acumulado.toFixed(1)}%
                    </td>
                    <td className="px-4 py-1.5 text-right sm:px-5">
                      <Badge variant="outline" className="text-[10px] font-semibold">
                        {l.faixa}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {/*
          De onde vem e de quando é. Sem isto o relatório passaria a impressão de
          número vivo, e alguém decidiria compra em cima de um retrato de meses
          atrás sem saber.
        */}
        <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          Retrato do histórico de vendas do sistema antigo — {curva.diasAnalisados} dias,
          calculado em {new Date(curva.calculadoEm).toLocaleDateString("pt-BR")}. Não muda
          sozinho: só quando a política de compra é recalculada. O valor é estimativa —
          quantidade vendida × preço de hoje, porque o preço praticado então não foi
          guardado.
          {curva.foraPorGrupo > 0 ? (
            <>
              {" "}
              Fora da conta: {curva.foraPorGrupo} produto
              {curva.foraPorGrupo === 1 ? "" : "s"} de grupo que não é mercadoria de
              prateleira.
            </>
          ) : null}
        </p>
      </div>
    </div>
  )
}
