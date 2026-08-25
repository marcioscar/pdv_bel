import { useEffect, useMemo, useRef, useState } from "react"
import { data, Link, useFetcher, useSearchParams } from "react-router"
import { ArrowLeft, Printer, Search, Send, ShoppingBag, Truck } from "lucide-react"

import type { Route } from "./+types/admin.pedido-novo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { db } from "~/lib/db.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { cn } from "~/lib/utils"
import { exigirGerente } from "~/lib/sessao.server"
import { listarLojas } from "~/lib/lojas.server"
import { criarPedido, catalogoDoFornecedor, type ItemDoFornecedor } from "~/lib/pedidos-compra.server"
import { DIAS_DE_ENTREGA, ROTULOS_DE_URGENCIA, type Urgencia } from "~/lib/compras"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Novo pedido — BrasSaco" }]
}

/**
 * O pedido de compra visto de trás para frente: primeiro o fornecedor, depois
 * o que pedir dele.
 *
 * A tela de Compras já resolve "o que está faltando" — daqui a pergunta é a
 * outra, que também é real: "vou ligar para a plazapel, o que peço?". As duas
 * telas usam a mesma régua de urgência por baixo, só a entrada é diferente.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const url = new URL(request.url)
  const fornecedorId = url.searchParams.get("fornecedor")

  const fornecedores = await db.fornecedor.findMany({
    where: { ativo: true },
    orderBy: [{ ultimaCompra: "desc" }, { razaoSocial: "asc" }],
    select: { id: true, razaoSocial: true, nomeFantasia: true, cidade: true, ultimaCompra: true },
  })

  if (!fornecedorId) {
    return { fornecedores, fornecedor: null, itens: null, lojas: [] }
  }

  const fornecedor = await db.fornecedor.findUnique({ where: { id: fornecedorId } })
  if (!fornecedor) {
    throw new Response("Fornecedor não encontrado", { status: 404 })
  }

  const [itens, lojas] = await Promise.all([
    catalogoDoFornecedor(fornecedorId),
    listarLojas(),
  ])

  return {
    fornecedores,
    fornecedor: { id: fornecedor.id, nome: fornecedor.nomeFantasia || fornecedor.razaoSocial },
    itens,
    lojas: lojas.map((l) => l.codigo),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verRelatorios")
  const form = await request.formData()

  const fornecedorId = String(form.get("fornecedorId") ?? "")
  let itens: { produtoId: string; quantidade: number }[] = []
  try {
    itens = JSON.parse(String(form.get("itens") ?? "[]"))
  } catch {
    itens = []
  }

  const resultado = await criarPedido({ fornecedorId, itens, operador: eu.nome })
  if (!resultado.ok) {
    return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
  }

  return { ok: true as const, numero: resultado.numero, id: resultado.id }
}

const CORES: Record<Urgencia, string> = {
  sem_estoque: "bg-destructive/10 text-destructive",
  critico: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  comprar: "bg-primary/10 text-foreground",
  ok: "bg-muted text-muted-foreground",
}

export default function AdminPedidoNovo({ loaderData }: Route.ComponentProps) {
  const { fornecedores, fornecedor, itens, lojas } = loaderData

  if (!fornecedor) {
    return <EscolherFornecedor fornecedores={fornecedores} />
  }

  return (
    <MontarPedido
      key={fornecedor.id}
      fornecedor={fornecedor}
      itens={itens ?? []}
      lojas={lojas}
    />
  )
}

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

function EscolherFornecedor({
  fornecedores,
}: {
  fornecedores: Route.ComponentProps["loaderData"]["fornecedores"]
}) {
  const [busca, setBusca] = useState("")
  const campoBusca = useRef<HTMLInputElement>(null)

  useEffect(() => {
    campoBusca.current?.focus()
  }, [])

  const encontrados = useMemo(() => {
    const termo = normalizar(busca)
    if (!termo) return fornecedores
    return fornecedores.filter(
      (f) =>
        normalizar(f.razaoSocial).includes(termo) ||
        normalizar(f.nomeFantasia ?? "").includes(termo) ||
        normalizar(f.cidade).includes(termo)
    )
  }, [busca, fornecedores])

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ShoppingBag className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Novo pedido</h1>
      </div>
      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        Escolha o fornecedor. Depois disso a tela mostra o que ele vende, com o
        que está faltando já sinalizado — e dá para pedir qualquer outra coisa do
        catálogo dele também.
      </p>

      <Input
        ref={campoBusca}
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        type="search"
        placeholder="Buscar fornecedor por nome ou cidade…"
        autoComplete="off"
        className="mt-5 h-10 w-full max-w-md rounded-lg border-border bg-background text-sm"
      />

      {encontrados.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border py-16 text-center">
          <Search className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhum fornecedor com esse termo.
          </p>
        </div>
      ) : (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {encontrados.map((f) => (
            <li key={f.id}>
              <Link
                to={`?fornecedor=${f.id}`}
                className="block rounded-xl border border-border p-3 text-sm transition-colors hover:border-primary hover:bg-primary/5"
              >
                <p className="font-medium">{f.nomeFantasia || f.razaoSocial}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{f.cidade}</p>
                {f.ultimaCompra ? (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
                    última compra {new Date(f.ultimaCompra).toLocaleDateString("pt-BR")}
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground/50">nunca comprou</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MontarPedido({
  fornecedor,
  itens,
  lojas,
}: {
  fornecedor: { id: string; nome: string }
  itens: ItemDoFornecedor[]
  lojas: string[]
}) {
  const [busca, setBusca] = useState("")
  const [selecionados, setSelecionados] = useState<Record<string, boolean>>(() => {
    // Já vem marcado o que precisa — quem pediu já sabe o que falta sem clicar
    // item por item; o resto fica disponível, mas exige uma escolha.
    const inicial: Record<string, boolean> = {}
    for (const item of itens) {
      if (item.urgencia && item.urgencia !== "ok") inicial[item.produtoId] = true
    }
    return inicial
  })
  const [quantidades, setQuantidades] = useState<Record<string, number>>(() => {
    const inicial: Record<string, number> = {}
    for (const item of itens) {
      if (item.sugestao > 0) inicial[item.produtoId] = item.sugestao
    }
    return inicial
  })

  const fetcher = useFetcher<typeof action>()
  const gerando = fetcher.state !== "idle"

  const encontrados = useMemo(() => {
    const termo = normalizar(busca)
    if (!termo) return itens
    return itens.filter(
      (i) => normalizar(i.descricao).includes(termo) || i.codigo.includes(termo)
    )
  }, [busca, itens])

  function quantidadeDe(item: ItemDoFornecedor) {
    return quantidades[item.produtoId] ?? item.sugestao
  }

  const selecionadosLista = itens.filter((i) => selecionados[i.produtoId])
  const totalItens = selecionadosLista.length
  const totalValor = selecionadosLista.reduce(
    (soma, i) => soma + quantidadeDe(i) * i.custoUnitario,
    0
  )
  const comQuantidadeInvalida = selecionadosLista.some((i) => !(quantidadeDe(i) > 0))

  function alternar(produtoId: string) {
    setSelecionados((s) => ({ ...s, [produtoId]: !s[produtoId] }))
  }

  function gerar() {
    if (totalItens === 0 || comQuantidadeInvalida || gerando) return
    const payload = selecionadosLista.map((i) => ({
      produtoId: i.produtoId,
      quantidade: quantidadeDe(i),
    }))
    fetcher.submit(
      {
        fornecedorId: fornecedor.id,
        itens: JSON.stringify(payload),
      },
      { method: "post" }
    )
  }

  if (fetcher.data?.ok) {
    return <PedidoGerado numero={fetcher.data.numero} id={fetcher.data.id} fornecedor={fornecedor} />
  }

  return (
    <div className="p-4 pb-24 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          to="/admin/pedido-novo"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Trocar fornecedor
        </Link>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">{fornecedor.nome}</h1>
        <span className="text-xs text-muted-foreground">
          {itens.length} {itens.length === 1 ? "produto no catálogo" : "produtos no catálogo"}
        </span>
      </div>

      {itens.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border py-16 text-center">
          <ShoppingBag className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhum produto ligado a este fornecedor ainda.
          </p>
        </div>
      ) : (
        <>
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por código ou descrição"
            autoComplete="off"
            className="mt-5 h-10 w-full min-w-0 rounded-lg border-border bg-background text-sm sm:w-72"
          />

          {fetcher.data && !fetcher.data.ok ? (
            <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {fetcher.data.erro}
            </p>
          ) : null}

          <Tabela
            itens={encontrados}
            lojas={lojas}
            selecionados={selecionados}
            quantidades={quantidades}
            onAlternar={alternar}
            onQuantidade={(id, v) => setQuantidades((q) => ({ ...q, [id]: v }))}
          />
        </>
      )}

      {totalItens > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] sm:px-6">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <span className="text-sm font-medium">
              {totalItens} {totalItens === 1 ? "item" : "itens"}
            </span>
            <span className="text-xs text-muted-foreground">≈ {moeda(totalValor)}</span>
            {comQuantidadeInvalida ? (
              <span className="text-xs font-medium text-destructive">
                Há item selecionado sem quantidade
              </span>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={gerando || comQuantidadeInvalida}
              onClick={gerar}
              className="ml-auto rounded-lg"
            >
              <Send className="size-4" />
              {gerando ? "Gerando…" : "Gerar pedido"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Tabela({
  itens,
  lojas,
  selecionados,
  quantidades,
  onAlternar,
  onQuantidade,
}: {
  itens: ItemDoFornecedor[]
  lojas: string[]
  selecionados: Record<string, boolean>
  quantidades: Record<string, number>
  onAlternar: (produtoId: string) => void
  onQuantidade: (produtoId: string, valor: number) => void
}) {
  return (
    <>
      {/* Telefone: cartão por produto. */}
      <ul className="mt-4 grid gap-2 sm:hidden">
        {itens.map((item) => (
          <ItemCartao
            key={item.produtoId}
            item={item}
            lojas={lojas}
            selecionado={!!selecionados[item.produtoId]}
            quantidade={quantidades[item.produtoId] ?? item.sugestao}
            onAlternar={() => onAlternar(item.produtoId)}
            onQuantidade={(v) => onQuantidade(item.produtoId, v)}
          />
        ))}
      </ul>

      <div className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-8 py-2 pr-2" />
              <th className="py-2 pr-3 font-semibold">Produto</th>
              <th className="py-2 pr-3 text-right font-semibold">Estoque</th>
              <th className="py-2 pr-3 text-right font-semibold">Dura</th>
              <th className="py-2 pr-3 text-right font-semibold">Sugestão</th>
              <th className="py-2 pr-3 text-right font-semibold">Quantidade</th>
              <th className="py-2 pr-3 text-right font-semibold">Custo</th>
              <th className="py-2 text-right font-semibold">Subtotal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {itens.map((item) => {
              const marcado = !!selecionados[item.produtoId]
              const qtd = quantidades[item.produtoId] ?? item.sugestao
              return (
                <tr key={item.produtoId} className={cn(marcado && "bg-primary/5")}>
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() => onAlternar(item.produtoId)}
                      className="size-4 accent-primary"
                      aria-label={`Selecionar ${item.descricao}`}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs text-muted-foreground">{item.codigo}</span>{" "}
                    {item.descricao}
                    {item.urgencia && item.urgencia !== "ok" ? (
                      <Badge
                        variant="outline"
                        className={cn("ml-2 border-0 text-[10px]", CORES[item.urgencia])}
                      >
                        {ROTULOS_DE_URGENCIA[item.urgencia]}
                      </Badge>
                    ) : null}
                    {!item.principal ? (
                      <span
                        className="ml-2 text-[10px] text-muted-foreground"
                        title="Este fornecedor não é o principal deste produto"
                      >
                        alternativo
                      </span>
                    ) : null}
                  </td>
                  <td
                    className={cn(
                      "py-2 pr-3 text-right",
                      item.estoque <= 0 && "font-semibold text-destructive"
                    )}
                  >
                    {formatarQuantidade(item.estoque)}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Duracao dias={item.diasRestantes} />
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {item.sugestao > 0 ? formatarQuantidade(item.sugestao) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={qtd}
                      onChange={(e) => onQuantidade(item.produtoId, Number(e.target.value) || 0)}
                      className="h-7 w-20 rounded border border-border bg-background px-1.5 text-right text-sm tabular-nums"
                    />
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {moeda(item.custoUnitario)}
                  </td>
                  <td className="py-2 text-right text-muted-foreground">
                    {marcado && qtd > 0 ? moeda(qtd * item.custoUnitario) : "—"}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function ItemCartao({
  item,
  lojas,
  selecionado,
  quantidade,
  onAlternar,
  onQuantidade,
}: {
  item: ItemDoFornecedor
  lojas: string[]
  selecionado: boolean
  quantidade: number
  onAlternar: () => void
  onQuantidade: (valor: number) => void
}) {
  return (
    <li className={cn("rounded-xl border border-border p-3", selecionado && "bg-primary/5")}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selecionado}
          onChange={onAlternar}
          className="mt-0.5 size-4 shrink-0 accent-primary"
          aria-label={`Selecionar ${item.descricao}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm leading-snug">
              <span className="font-mono text-xs text-muted-foreground">{item.codigo}</span>{" "}
              {item.descricao}
            </p>
            {item.urgencia && item.urgencia !== "ok" ? (
              <Badge
                variant="outline"
                className={cn("shrink-0 border-0 text-[10px]", CORES[item.urgencia])}
              >
                {ROTULOS_DE_URGENCIA[item.urgencia]}
              </Badge>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums">
            <span>
              <b className={cn("font-mono", item.estoque <= 0 && "text-destructive")}>
                {formatarQuantidade(item.estoque)}
              </b>{" "}
              <span className="text-muted-foreground">em estoque</span>
            </span>
            <span className="text-muted-foreground">
              <Duracao dias={item.diasRestantes} />
            </span>
          </div>

          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {lojas.map((loja) => `${loja} ${formatarQuantidade(item.porLoja[loja] ?? 0)}`).join("  ")}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
            <input
              type="number"
              min={0}
              step={1}
              value={quantidade}
              onChange={(e) => onQuantidade(Number(e.target.value) || 0)}
              className="h-9 w-20 rounded border border-border bg-background px-2 text-sm tabular-nums"
            />
            <span className="text-xs text-muted-foreground">{item.unidade}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {moeda(item.custoUnitario)} un · ≈ {moeda(quantidade * item.custoUnitario)}
            </span>
          </div>
        </div>
      </div>
    </li>
  )
}

function Duracao({ dias }: { dias: number | null }) {
  if (dias === null) return <span className="text-muted-foreground">—</span>
  if (dias <= 0) return <span className="font-semibold text-destructive">acabou</span>

  const cheio = Math.floor(dias)
  return (
    <span className={cn(cheio < DIAS_DE_ENTREGA && "font-semibold text-amber-700 dark:text-amber-400")}>
      {cheio > 365 ? "+1 ano" : `${cheio} d`}
    </span>
  )
}

function PedidoGerado({
  numero,
  id,
  fornecedor,
}: {
  numero: number
  id: string
  fornecedor: { id: string; nome: string }
}) {
  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-md rounded-xl border border-border p-6 text-center">
        <ShoppingBag className="mx-auto size-10 text-primary" aria-hidden />
        <p className="mt-3 text-sm text-muted-foreground">Pedido gerado</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">#{numero}</p>
        <p className="mt-1 text-sm text-muted-foreground">{fornecedor.nome}</p>

        <div className="mt-6 flex flex-col gap-2">
          <a
            href={`/pedidos-de-compra/${id}/impressao`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            <Printer className="size-4" aria-hidden />
            Abrir para imprimir ou gerar PDF
          </a>
          <p className="text-[11px] text-muted-foreground">
            Na caixa de impressão, escolha “Salvar como PDF” para mandar por e-mail
            ou WhatsApp.
          </p>
          <Link
            to="/admin/pedido-novo"
            className="mt-2 inline-flex h-10 items-center justify-center rounded-lg border border-border text-sm"
          >
            Fazer outro pedido
          </Link>
          <Link
            to="/admin/compras"
            className="inline-flex h-10 items-center justify-center rounded-lg text-sm text-muted-foreground"
          >
            Voltar para Compras
          </Link>
        </div>
      </div>
    </div>
  )
}
