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
import { movimentosRecentes, saldosPorProdutoELoja } from "~/lib/estoque.server"
import { listarLojas } from "~/lib/lojas.server"
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

  const [cadastro, saldos, movimentos, lojas] = await Promise.all([
    db.produto.findMany({ where: SOMENTE_ATIVOS, orderBy: { descricao: "asc" } }),
    // Uma agregação para as quatro lojas. É o que um banco único entrega de graça:
    // com banco por loja, isto seria quatro conexões e uma junção na aplicação.
    saldosPorProdutoELoja(),
    movimentosRecentes(eu.loja),
    listarLojas(),
  ])

  const produtos = cadastro.map((produto) => {
    const porLoja = saldos.get(produto.id)
    const saldoPorLoja: Record<string, number> = {}
    let rede = 0
    for (const loja of lojas) {
      const saldo = porLoja?.get(loja.codigo) ?? 0
      saldoPorLoja[loja.codigo] = saldo
      rede += saldo
    }
    return {
      id: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      preco: produto.preco,
      // `estoque` é o desta loja: é o campo que o índice de busca usa.
      estoque: saldoPorLoja[eu.loja] ?? 0,
      saldoPorLoja,
      rede,
    }
  })

  return {
    eu,
    lojas,
    produtos,
    movimentos,
    semEstoque: produtos.filter((p) => p.estoque <= 0).length,
    faltamAqui: produtos.filter((p) => p.estoque <= 0 && p.rede > 0).length,
  }
}

/**
 * Consulta de estoque — as duas perguntas de balcão: "tem esse aí?" e, quando não
 * tem, "tem em outra loja?".
 *
 * Mostrar a rede inteira aqui, e não numa tela da administração, é deliberado: a
 * segunda pergunta é feita com o cliente na frente, e mandar o vendedor a outra
 * tela para responder é o mesmo que não responder.
 *
 * É só leitura. Entrada e inventário moveram para /admin/estoque: ter o campo que
 * **escreve** no saldo na tela que se abre com cliente esperando convida ao acidente.
 */
export default function Estoque({ loaderData }: Route.ComponentProps) {
  const { eu, lojas, produtos, movimentos, semEstoque, faltamAqui } = loaderData

  const [busca, setBusca] = useState("")
  const campo = useRef<HTMLInputElement>(null)
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  const indice = useMemo(() => criarIndice(produtos), [produtos])
  const porId = useMemo(() => new Map(produtos.map((p) => [p.id, p])), [produtos])

  /**
   * Sem busca, a lista mais útil não é "o que falta": é **o que falta aqui e tem
   * em outra loja**, que é o que vira venda em vez de cliente perdido. Só quando
   * não há nenhum desses ela cai na lista do que falta.
   */
  const encontrados = useMemo(() => {
    if (busca.trim()) {
      return buscarProdutos(indice, busca, 40)
        .map((p) => porId.get(p.id)!)
        .filter(Boolean)
    }
    const temNoutra = produtos
      .filter((p) => p.estoque <= 0 && p.rede > 0)
      .sort((a, b) => b.rede - a.rede)
    return (temNoutra.length > 0 ? temNoutra : produtos.filter((p) => p.estoque <= 0)).slice(
      0,
      40
    )
  }, [busca, indice, porId, produtos])

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
          <b className="font-semibold text-foreground">{semEstoque}</b> sem estoque
          nesta loja
          {faltamAqui > 0 ? (
            <>
              {" · "}
              <b className="font-semibold text-foreground">{faltamAqui}</b> tem em
              outra
            </>
          ) : null}
        </span>
      </Topo>

      <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-5 py-3">
        <ScanLine className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          ref={campo}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Bipe o código ou digite a descrição para ver o saldo nas quatro lojas…"
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
                <th scope="col" className="w-12 px-1 py-2.5 text-left font-semibold">
                  Un
                </th>
                <th scope="col" className="w-24 px-2 py-2.5 text-right font-semibold">
                  Preço
                </th>
                {lojas.map((loja) => (
                  <th
                    key={loja.codigo}
                    scope="col"
                    className={cn(
                      "w-16 px-1 py-2.5 text-right font-semibold",
                      loja.codigo === eu.loja && "text-foreground"
                    )}
                  >
                    {loja.codigo}
                  </th>
                ))}
                <th scope="col" className="w-16 px-5 py-2.5 text-right font-semibold">
                  Rede
                </th>
              </tr>
            </thead>
            <tbody>
              {encontrados.length === 0 ? (
                <tr>
                  <td colSpan={5 + lojas.length} className="px-5 py-16 text-center">
                    <PackageSearch
                      className="mx-auto size-10 text-muted-foreground/40"
                      aria-hidden
                    />
                    <p className="mt-3 text-sm text-muted-foreground">
                      {busca.trim()
                        ? `Nada encontrado para “${busca}”`
                        : "Nada faltando nesta loja."}
                    </p>
                  </td>
                </tr>
              ) : (
                encontrados.map((produto) => (
                  <tr key={produto.id} className="border-b border-border">
                    <td className="px-5 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                      {produto.codigo}
                    </td>
                    <td className="max-w-sm truncate px-2 py-2">{produto.descricao}</td>
                    <td className="px-1 py-2">
                      <Badge variant="outline" className="font-mono text-[9px]">
                        {produto.unidade}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-xs tabular-nums">
                      {moeda(produto.preco)}
                    </td>
                    {lojas.map((loja) => {
                      const saldo = produto.saldoPorLoja[loja.codigo] ?? 0
                      const minha = loja.codigo === eu.loja
                      return (
                        <td
                          key={loja.codigo}
                          className={cn(
                            "px-1 py-2 text-right font-mono tabular-nums",
                            // A coluna da loja do turno vem em negrito e com fundo;
                            // as outras em cinza, para o olho achar a sua primeiro.
                            minha
                              ? saldo > 0
                                ? "bg-muted/60 font-bold text-foreground"
                                : "bg-muted/60 font-bold text-destructive"
                              : saldo > 0
                                ? "text-muted-foreground"
                                : "text-muted-foreground/30"
                          )}
                        >
                          {saldo === 0 ? "—" : formatarQuantidade(saldo)}
                        </td>
                      )
                    })}
                    <td
                      className={cn(
                        "px-5 py-2 text-right font-mono text-xs tabular-nums",
                        produto.rede > 0 ? "text-muted-foreground" : "text-destructive"
                      )}
                    >
                      {produto.rede === 0 ? "0" : formatarQuantidade(produto.rede)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-muted/30">
          <div className="border-b border-border px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Movimentos · {eu.loja}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {movimentos.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">
                Nenhum movimento nesta loja. As entradas ficam em{" "}
                <Link to="/admin/estoque" className="underline">
                  Adm → Entradas
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
        Só consulta · <Kbd>Esc</Kbd> limpa a busca ·{" "}
        {busca.trim()
          ? "a coluna da sua loja está em destaque"
          : "sem busca, mostra o que falta aqui e tem em outra loja"}
      </div>
    </main>
  )
}
