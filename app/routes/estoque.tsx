import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import { PackageSearch, ScanLine } from "lucide-react"

import type { Route } from "./+types/estoque"
import { Topo } from "~/components/pdv/topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { db } from "~/lib/db.server"
import { movimentosRecentes, saldosPorProduto } from "~/lib/estoque.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { buscarProdutos, criarIndice } from "~/lib/pdv"
import { SOMENTE_ATIVOS } from "~/lib/produtos.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Estoque — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const [cadastro, saldos, movimentos] = await Promise.all([
    db.produto.findMany({ where: SOMENTE_ATIVOS, orderBy: { descricao: "asc" } }),
    saldosPorProduto(eu.loja),
    movimentosRecentes(eu.loja),
  ])

  const produtos = cadastro.map((produto) => ({
    ...produto,
    estoque: saldos.get(produto.id) ?? 0,
  }))

  return {
    eu,
    produtos,
    movimentos,
    semEstoque: produtos.filter((p) => p.estoque <= 0).length,
  }
}

/**
 * Consulta de estoque — a pergunta de balcão: "tem esse aí?".
 *
 * É só leitura. Entrada de mercadoria e inventário moveram para
 * /admin/estoque: são tarefas de escritório, e ter o campo que **escreve** no
 * saldo na mesma tela que se abre com cliente esperando convida ao acidente.
 */
export default function Estoque({ loaderData }: Route.ComponentProps) {
  const { eu, produtos, movimentos, semEstoque } = loaderData

  const [busca, setBusca] = useState("")
  const campo = useRef<HTMLInputElement>(null)
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  const indice = useMemo(() => criarIndice(produtos), [produtos])

  // Sem busca, mostra o que está faltando: é a informação mais útil de graça.
  const encontrados = useMemo(() => {
    if (!busca.trim()) {
      return produtos.filter((p) => p.estoque <= 0).slice(0, 40)
    }
    return buscarProdutos(indice, busca, 40)
  }, [busca, indice, produtos])

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.ctrlKey || evento.altKey || evento.metaKey) return
      if (evento.key === "F6") {
        evento.preventDefault()
        alternar()
        return
      }
      if (evento.key === "Escape") {
        setBusca("")
        campo.current?.focus()
      }
    }
    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [alternar])

  useEffect(() => campo.current?.focus(), [])

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        loja={eu.loja}
        lojasPermitidas={eu.lojasPermitidas.length}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      >
        <span>
          {produtos.length.toLocaleString("pt-BR")} produtos ·{" "}
          <b className="font-semibold text-foreground">{semEstoque}</b> sem estoque
        </span>
      </Topo>

      <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-5 py-3">
        <ScanLine className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          ref={campo}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Bipe o código ou digite a descrição para ver o saldo…"
          aria-label="Buscar produto"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          className="h-9 flex-1 rounded-none border-0 bg-transparent px-0 font-mono text-lg tracking-tight tabular-nums shadow-none placeholder:font-sans placeholder:text-sm placeholder:tracking-normal focus-visible:border-transparent focus-visible:ring-0 md:text-lg"
        />
        <Button
          type="button"
          tabIndex={-1}
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/admin/estoque" />}
          className="shrink-0 rounded-lg"
        >
          Dar entrada
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="w-20 px-5 py-2.5 text-left font-semibold">
                  Código
                </th>
                <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                  Produto
                </th>
                <th scope="col" className="w-16 px-2 py-2.5 text-left font-semibold">
                  Un
                </th>
                <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">
                  Preço
                </th>
                <th scope="col" className="w-28 px-5 py-2.5 text-right font-semibold">
                  Saldo
                </th>
              </tr>
            </thead>
            <tbody>
              {encontrados.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-16 text-center">
                    <PackageSearch
                      className="mx-auto size-10 text-muted-foreground/40"
                      aria-hidden
                    />
                    <p className="mt-3 text-sm text-muted-foreground">
                      {busca.trim()
                        ? `Nada encontrado para “${busca}”`
                        : "Todos os produtos têm saldo."}
                    </p>
                  </td>
                </tr>
              ) : (
                encontrados.map((produto) => (
                  <tr key={produto.id} className="border-b border-border">
                    <td className="px-5 py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                      {produto.codigo}
                    </td>
                    <td className="max-w-md px-2 py-2.5">{produto.descricao}</td>
                    <td className="px-2 py-2.5">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {produto.unidade}
                      </Badge>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                      {moeda(produto.preco)}
                    </td>
                    <td
                      className={cn(
                        "px-5 py-2.5 text-right font-mono font-semibold tabular-nums",
                        produto.estoque <= 0 ? "text-destructive" : "text-foreground"
                      )}
                    >
                      {produto.estoque <= 0
                        ? "sem estoque"
                        : formatarQuantidade(produto.estoque)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-muted/30">
          <div className="border-b border-border px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Últimos movimentos
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {movimentos.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">
                Nenhum movimento ainda. As entradas ficam em{" "}
                <Link to="/admin/estoque" className="underline">
                  Administração → Entradas
                </Link>
                .
              </p>
            ) : (
              <ul>
                {movimentos.map((movimento) => (
                  <li
                    key={movimento.id}
                    className="border-b border-border px-4 py-2 text-xs"
                  >
                    <div className="flex items-baseline gap-2">
                      <Badge
                        variant={movimento.tipo === "venda" ? "outline" : "secondary"}
                        className="font-mono text-[9px]"
                      >
                        {movimento.tipo}
                      </Badge>
                      <span
                        className={cn(
                          "ml-auto font-mono font-semibold tabular-nums",
                          movimento.quantidade < 0
                            ? "text-destructive"
                            : "text-foreground"
                        )}
                      >
                        {movimento.quantidade > 0 ? "+" : ""}
                        {formatarQuantidade(movimento.quantidade)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-muted-foreground">
                      {movimento.descricao}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {new Date(movimento.criadoEm).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                      {movimento.vendaNumero ? ` · venda #${movimento.vendaNumero}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      <div className="border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
        Só consulta · <Kbd>Esc</Kbd> limpa a busca · o saldo é a soma dos movimentos,
        não um número guardado
      </div>
    </main>
  )
}
