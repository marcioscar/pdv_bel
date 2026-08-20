import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { ScrollText, Search } from "lucide-react"

import type { Route } from "./+types/admin.ficha"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { db } from "~/lib/db.server"
import { fichaDoProduto } from "~/lib/estoque.server"
import { quantidade as formatarQuantidade } from "~/lib/moeda"
import { ajudaDoTipo, rotuloDoTipo } from "~/lib/movimentos"
import { buscarProdutos, criarIndice } from "~/lib/pdv"
import { SOMENTE_ATIVOS } from "~/lib/produtos.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Ficha de estoque — BrasSaco" }]
}

/**
 * A vida inteira de um produto no estoque, movimento a movimento.
 *
 * É a tela que responde "por que o saldo está assim". O saldo sozinho é um
 * número sem defesa: quando alguém diz que faltou mercadoria, é aqui que se vê
 * o que entrou, o que saiu, quando e por conta de quê. Como o estoque deste
 * sistema é a soma do livro, a ficha não é um relatório derivado de outro lugar
 * — é o próprio livro, mostrado em ordem.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const cadastro = await db.produto.findMany({
    where: SOMENTE_ATIVOS,
    orderBy: { descricao: "asc" },
    select: { id: true, codigo: true, descricao: true, unidade: true, preco: true },
  })

  const escolhido = new URL(request.url).searchParams.get("produto")
  const produto = escolhido ? cadastro.find((p) => p.id === escolhido) : null

  return {
    eu,
    // Só o que a busca precisa: mandar o catálogo com preço e tudo seria mandar
    // o dobro de bytes para uma tela que só procura por código e nome.
    produtos: cadastro.map((p) => ({
      id: p.id,
      codigo: p.codigo,
      descricao: p.descricao,
      unidade: p.unidade,
      // A busca do caixa espera este campo; a ficha não usa o preço.
      preco: 0,
      estoque: 0,
    })),
    produto: produto ?? null,
    ficha: produto ? await fichaDoProduto(produto.id, eu.lojasPermitidas) : null,
  }
}

export default function AdminFicha({ loaderData }: Route.ComponentProps) {
  const { produtos, produto, ficha } = loaderData
  const [, setParams] = useSearchParams()
  const [termo, setTermo] = useState("")

  const indice = useMemo(() => criarIndice(produtos), [produtos])
  const achados = useMemo(
    () => (termo.trim() ? buscarProdutos(indice, termo, 8) : []),
    [indice, termo]
  )

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ScrollText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Ficha de estoque</h1>
        <span className="text-xs text-muted-foreground">
          todo movimento de um produto, com o saldo depois de cada um
        </span>
      </div>

      <div className="relative mt-4 max-w-xl">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
          placeholder="Código ou nome do produto"
          type="search"
          autoComplete="off"
          className="h-10 rounded-lg border-border bg-background pl-8"
        />
        {achados.length > 0 ? (
          <ul className="absolute z-10 mt-1 w-full divide-y divide-border rounded-lg border border-border bg-card shadow-lg">
            {achados.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setParams({ produto: p.id })
                    setTermo("")
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                >
                  <span className="font-mono text-xs text-muted-foreground">{p.codigo}</span>
                  <span className="min-w-0 flex-1 truncate">{p.descricao}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{p.unidade}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {!produto ? (
        <div className="mt-8 rounded-xl border border-dashed border-border py-16 text-center">
          <ScrollText className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">
            Procure um produto para ver a ficha dele.
          </p>
        </div>
      ) : (
        <Ficha produto={produto} ficha={ficha!} />
      )}
    </div>
  )
}

function Ficha({
  produto,
  ficha,
}: {
  produto: { codigo: string; descricao: string; unidade: string }
  ficha: NonNullable<Route.ComponentProps["loaderData"]["ficha"]>
}) {
  const [loja, setLoja] = useState<string>("todas")

  const linhas = useMemo(
    () =>
      // Do mais recente para o mais antigo: a pergunta quase sempre é sobre o
      // que aconteceu ontem. O saldo de cada linha já foi acumulado no servidor,
      // em ordem cronológica, então inverter aqui não o desalinha.
      [...ficha.linhas].reverse().filter((l) => loja === "todas" || l.loja === loja),
    [ficha.linhas, loja]
  )

  const lojasComMovimento = ficha.saldos.map((s) => s.loja)

  return (
    <>
      <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm text-muted-foreground">{produto.codigo}</span>
        <h2 className="text-base font-semibold">{produto.descricao}</h2>
        <span className="text-xs text-muted-foreground">{produto.unidade}</span>
      </div>

      {ficha.saldos.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Este produto nunca teve movimento nenhum.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-3">
            {ficha.saldos.map((s) => (
              <div key={s.loja} className="rounded-xl border border-border px-4 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {s.loja}
                </div>
                <div
                  className={cn(
                    "font-mono text-xl font-bold tabular-nums",
                    s.saldo < 0 && "text-destructive"
                  )}
                >
                  {formatarQuantidade(s.saldo)}
                </div>
              </div>
            ))}
          </div>

          {lojasComMovimento.length > 1 ? (
            <div className="mt-4 flex flex-wrap gap-1">
              <Filtro atual={loja} valor="todas" onEscolher={setLoja}>
                Todas
              </Filtro>
              {lojasComMovimento.map((l) => (
                <Filtro key={l} atual={loja} valor={l} onEscolher={setLoja}>
                  {l}
                </Filtro>
              ))}
            </div>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2.5 text-left font-semibold">Quando</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Loja</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">O que foi</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Entrou</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Saiu</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Saldo</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Quem · documento</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.id} className="border-b border-border align-top">
                    <td className="whitespace-nowrap py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                      {new Date(l.criadoEm).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-2 py-2.5">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {l.loja}
                      </Badge>
                    </td>
                    <td className="px-2 py-2.5 text-xs" title={ajudaDoTipo(l.tipo)}>
                      {rotuloDoTipo(l.tipo)}
                    </td>
                    {/* Entrou e saiu em colunas separadas: é como se lê uma ficha
                        de estoque no papel, e o sinal de menos numa coluna só
                        passa despercebido quando se percorre a lista rápido. */}
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                      {l.quantidade > 0 ? formatarQuantidade(l.quantidade) : ""}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-destructive tabular-nums">
                      {l.quantidade < 0 ? formatarQuantidade(-l.quantidade) : ""}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2.5 text-right font-mono font-semibold tabular-nums",
                        l.saldo < 0 && "text-destructive"
                      )}
                    >
                      {formatarQuantidade(l.saldo)}
                    </td>
                    <td className="px-2 py-2.5 text-xs">
                      <span className="block">{l.operador}</span>
                      {/* O documento é link: da ficha se chega ao que causou o
                          movimento, que é o passo seguinte de toda investigação. */}
                      {l.vendaNumero ? (
                        <Link
                          to={`/admin/vendas?numero=${l.vendaNumero}&de=2000-01-01`}
                          className="font-mono text-[11px] underline"
                        >
                          venda #{l.vendaNumero}
                        </Link>
                      ) : null}
                      {l.transferenciaNumero ? (
                        <a
                          href={`/transferencias/${l.transferenciaId}/romaneio`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[11px] underline"
                        >
                          transferência #{l.transferenciaNumero}
                        </a>
                      ) : null}
                      {l.observacao ? (
                        <span className="block max-w-[22rem] text-[11px] text-muted-foreground">
                          {l.observacao}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            {linhas.length} {linhas.length === 1 ? "movimento" : "movimentos"} · o saldo de
            cada linha é o que havia logo depois dela, na loja daquela linha.
          </p>
        </>
      )}
    </>
  )
}

function Filtro({
  atual,
  valor,
  onEscolher,
  children,
}: {
  atual: string
  valor: string
  onEscolher: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={atual === valor ? "default" : "outline"}
      onClick={() => onEscolher(valor)}
      className="rounded-lg font-mono"
    >
      {children}
    </Button>
  )
}
