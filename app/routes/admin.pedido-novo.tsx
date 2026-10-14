import { useEffect, useMemo, useRef, useState } from "react"
import { data, Link, redirect, useFetcher, useSearchParams } from "react-router"
import { ArrowLeft, Plus, Printer, Search, Send, ShoppingBag, Truck } from "lucide-react"

import type { Route } from "./+types/admin.pedido-novo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Dialog } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import {
  ComprasDoProduto,
  type ProdutoDoHistorico,
} from "~/components/pdv/compras-do-produto"
import { db } from "~/lib/db.server"
import { interpretarValor, moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { criarIndice } from "~/lib/pdv"
import { EscolhaDeProduto, type ProdutoDoCatalogo } from "~/components/pdv/escolha-de-produto"
import { cn } from "~/lib/utils"
import { exigirGerente } from "~/lib/sessao.server"
import { listarLojas } from "~/lib/lojas.server"
import { ultimoCustoPorProduto } from "~/lib/compras.server"
import {
  criarFornecedor,
  lerFornecedor,
  proximoCodigoDeFornecedor,
} from "~/lib/fornecedores.server"
import { SOMENTE_ATIVOS } from "~/lib/produtos.server"
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
    // O código sugerido para o cadastro rápido de fornecedor, aqui mesmo.
    return {
      fornecedores,
      fornecedor: null,
      itens: null,
      lojas: [],
      catalogo: [],
      custoConhecido: {},
      proximoCodigo: await proximoCodigoDeFornecedor(),
    }
  }

  const fornecedor = await db.fornecedor.findUnique({ where: { id: fornecedorId } })
  if (!fornecedor) {
    throw new Response("Fornecedor não encontrado", { status: 404 })
  }

  const [itens, lojas, catalogo] = await Promise.all([
    catalogoDoFornecedor(fornecedorId),
    listarLojas(),
    // O catálogo inteiro: dá para pedir a este fornecedor o que ele nunca vendeu.
    db.produto.findMany({
      where: SOMENTE_ATIVOS,
      orderBy: { descricao: "asc" },
      select: { id: true, codigo: true, descricao: true, unidade: true },
    }),
  ])
  // O último custo de qualquer fornecedor: a referência para o produto novo
  // neste fornecedor, que não tem custo dele.
  const custoConhecido = await ultimoCustoPorProduto(catalogo.map((p) => p.id))

  return {
    fornecedores,
    fornecedor: { id: fornecedor.id, nome: fornecedor.nomeFantasia || fornecedor.razaoSocial },
    itens,
    lojas: lojas.map((l) => l.codigo),
    catalogo,
    custoConhecido: Object.fromEntries(custoConhecido),
    proximoCodigo: "",
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verRelatorios")
  const form = await request.formData()

  /*
   * Cadastro rápido de fornecedor: o mesmo `lerFornecedor`/`criarFornecedor`
   * da tela de Fornecedores, para as regras valerem iguais. Cadastrado, já
   * abre o pedido com ele.
   */
  if (form.get("intencao") === "cadastrarFornecedor") {
    await exigirGerente(request, "editarProdutos")
    const r = await criarFornecedor(lerFornecedor(form))
    if (!r.ok) return data({ ok: false as const, erro: r.erro }, { status: 400 })
    throw redirect(`/admin/pedido-novo?fornecedor=${r.fornecedor.id}`)
  }

  const fornecedorId = String(form.get("fornecedorId") ?? "")
  let itens: { produtoId: string; quantidade: number; custoUnitario?: number }[] = []
  try {
    itens = JSON.parse(String(form.get("itens") ?? "[]"))
  } catch {
    itens = []
  }

  const resultado = await criarPedido({
    fornecedorId,
    itens,
    operador: eu.nome,
    entregaPrometida: String(form.get("entregaPrometida") ?? ""),
  })
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
  const { fornecedores, fornecedor, itens, lojas, catalogo, custoConhecido, proximoCodigo } =
    loaderData

  if (!fornecedor) {
    return <EscolherFornecedor fornecedores={fornecedores} proximoCodigo={proximoCodigo} />
  }

  return (
    <MontarPedido
      key={fornecedor.id}
      fornecedor={fornecedor}
      itens={itens ?? []}
      lojas={lojas}
      catalogo={catalogo}
      custoConhecido={custoConhecido}
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
  proximoCodigo,
}: {
  fornecedores: Route.ComponentProps["loaderData"]["fornecedores"]
  proximoCodigo: string
}) {
  const [busca, setBusca] = useState("")
  const [cadastrando, setCadastrando] = useState(false)
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
        <Button
          type="button"
          size="sm"
          variant={cadastrando ? "secondary" : "outline"}
          className="ml-auto rounded-lg"
          onClick={() => setCadastrando((c) => !c)}
        >
          <Plus className="size-4" /> Novo fornecedor
        </Button>
      </div>
      {cadastrando ? (
        <NovoFornecedor proximoCodigo={proximoCodigo} onCancelar={() => setCadastrando(false)} />
      ) : null}
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
  catalogo,
  custoConhecido,
}: {
  fornecedor: { id: string; nome: string }
  itens: ItemDoFornecedor[]
  lojas: string[]
  catalogo: ProdutoDoCatalogo[]
  custoConhecido: Record<string, number>
}) {
  /**
   * Produtos pedidos FORA do que este fornecedor já vendeu — o caso de todo
   * fornecedor novo. O custo é digitado (ele não tem custo deste fornecedor) e
   * vai junto no pedido; começa no último custo pago a qualquer um.
   */
  const [outros, setOutros] = useState<
    { produtoId: string; quantidadeTexto: string; custoTexto: string }[]
  >([])
  const [busca, setBusca] = useState("")
  // Nada vem marcado: a urgência aparece no selo de cada linha, mas o que entra
  // no pedido é escolha de quem está comprando, item por item.
  const [selecionados, setSelecionados] = useState<Record<string, boolean>>({})
  const [quantidades, setQuantidades] = useState<Record<string, number>>(() => {
    const inicial: Record<string, number> = {}
    for (const item of itens) {
      if (item.sugestao > 0) inicial[item.produtoId] = item.sugestao
    }
    return inicial
  })
  const [entregaPrometida, setEntregaPrometida] = useState("")
  // O produto cujo histórico de compra está aberto. Diálogo, e não navegação:
  // o pedido em montagem só existe na memória desta tela — sair para conferir
  // quanto se pagou da última vez perderia tudo que já foi marcado.
  const [compras, setCompras] = useState<ProdutoDoHistorico | null>(null)

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
  const outrosValidos = outros.map((o) => ({
    produtoId: o.produtoId,
    quantidade: Math.trunc(Number(o.quantidadeTexto)) || 0,
    custoUnitario: interpretarValor(o.custoTexto) ?? 0,
  }))
  const totalItens = selecionadosLista.length + outrosValidos.length
  const totalValor =
    selecionadosLista.reduce((soma, i) => soma + quantidadeDe(i) * i.custoUnitario, 0) +
    outrosValidos.reduce((soma, o) => soma + o.quantidade * o.custoUnitario, 0)
  const comQuantidadeInvalida =
    selecionadosLista.some((i) => !(quantidadeDe(i) > 0)) ||
    outrosValidos.some((o) => !(o.quantidade > 0) || !(o.custoUnitario > 0))

  function alternar(produtoId: string) {
    setSelecionados((s) => ({ ...s, [produtoId]: !s[produtoId] }))
  }

  function gerar() {
    if (totalItens === 0 || comQuantidadeInvalida || gerando) return
    const payload = [
      ...selecionadosLista.map((i) => ({
        produtoId: i.produtoId,
        quantidade: quantidadeDe(i),
      })),
      ...outrosValidos,
    ]
    fetcher.submit(
      {
        fornecedorId: fornecedor.id,
        itens: JSON.stringify(payload),
        entregaPrometida,
      },
      { method: "post" }
    )
  }

  if (fetcher.data?.ok) {
    return <PedidoGerado numero={fetcher.data.numero} id={fetcher.data.id} fornecedor={fornecedor} />
  }

  return (
    <div className="p-4 pb-24 sm:p-6">
      <Dialog open={compras !== null} onOpenChange={(aberto) => !aberto && setCompras(null)}>
        {compras ? <ComprasDoProduto produto={compras} /> : null}
      </Dialog>

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
          <p className="mt-1 text-xs text-muted-foreground">
            Peça qualquer produto do catálogo logo abaixo, com o custo combinado.
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

          <Tabela
            itens={encontrados}
            lojas={lojas}
            selecionados={selecionados}
            quantidades={quantidades}
            onAlternar={alternar}
            onQuantidade={(id, v) => {
              setQuantidades((q) => ({ ...q, [id]: v }))
              // Digitar a quantidade já é dizer que quer comprar: marca a linha.
              // Zerar desmarca — quantidade zero não vai para o pedido.
              setSelecionados((s) => ({ ...s, [id]: v > 0 }))
            }}
            onHistorico={setCompras}
          />
        </>
      )}

      <OutrosProdutos
        catalogo={catalogo}
        jaDoFornecedor={itens.map((i) => i.produtoId)}
        outros={outros}
        onMudar={setOutros}
        onJaDoFornecedor={(produtoId) => setSelecionados((s) => ({ ...s, [produtoId]: true }))}
        custoConhecido={custoConhecido}
      />

      {fetcher.data && !fetcher.data.ok ? (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {fetcher.data.erro}
        </p>
      ) : null}

      {totalItens > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] sm:px-6">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <span className="text-sm font-medium">
              {totalItens} {totalItens === 1 ? "item" : "itens"}
            </span>
            <span className="text-xs text-muted-foreground">≈ {moeda(totalValor)}</span>
            {comQuantidadeInvalida ? (
              <span className="text-xs font-medium text-destructive">
                Há item selecionado sem quantidade ou sem custo
              </span>
            ) : null}

            {/* Opcional: muitas vezes a promessa só vem na ligação em que se
                manda o pedido, e a consulta deixa anotar depois. */}
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              Entrega prometida
              <input
                type="date"
                value={entregaPrometida}
                onChange={(e) => setEntregaPrometida(e.target.value)}
                className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
              />
            </label>

            <Button
              type="button"
              size="sm"
              disabled={gerando || comQuantidadeInvalida}
              onClick={gerar}
              className="rounded-lg"
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
  onHistorico,
}: {
  itens: ItemDoFornecedor[]
  lojas: string[]
  selecionados: Record<string, boolean>
  quantidades: Record<string, number>
  onAlternar: (produtoId: string) => void
  onQuantidade: (produtoId: string, valor: number) => void
  onHistorico: (produto: ProdutoDoHistorico) => void
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
            onHistorico={() => onHistorico(doHistorico(item))}
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
              {lojas.map((loja) => (
                <th key={loja} className="py-2 pr-3 text-right font-normal text-muted-foreground/70">
                  {loja}
                </th>
              ))}
              <th className="py-2 pr-3 text-right font-semibold">Dura</th>
              <th className="py-2 pr-3 text-right font-semibold">Última compra</th>
              <th className="py-2 pr-3 text-right font-semibold">Último pedido</th>
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
                    {/*
                      Clicar no nome abre o histórico de compra do produto —
                      de quem mais se compra isto e por quanto. É a pergunta
                      que aparece na hora de decidir a quantidade, e o
                      checkbox e a caixa de quantidade continuam intactos
                      porque o clique fica só no texto.
                    */}
                    <button
                      type="button"
                      onClick={() => onHistorico(doHistorico(item))}
                      title="Ver de quem já se comprou, por quanto e quando"
                      className="text-left underline decoration-dotted decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground"
                    >
                      <span className="font-mono text-xs text-muted-foreground">{item.codigo}</span>{" "}
                      {item.descricao}
                    </button>
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
                  {lojas.map((loja) => {
                    const saldo = item.porLoja[loja] ?? 0
                    return (
                      <td
                        key={loja}
                        className={cn(
                          "py-2 pr-3 text-right text-muted-foreground",
                          saldo <= 0 && "text-destructive/70"
                        )}
                      >
                        {formatarQuantidade(saldo)}
                      </td>
                    )
                  })}
                  <td className="py-2 pr-3 text-right">
                    <Duracao dias={item.diasRestantes} />
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    <UltimaCompra em={item.ultimaCompra} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <UltimoPedido item={item} />
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
                      onChange={(e) => onQuantidade(item.produtoId, Math.trunc(Number(e.target.value)) || 0)}
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
  onHistorico,
}: {
  item: ItemDoFornecedor
  lojas: string[]
  selecionado: boolean
  quantidade: number
  onAlternar: () => void
  onQuantidade: (valor: number) => void
  onHistorico: () => void
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
            <button
              type="button"
              onClick={onHistorico}
              title="Ver de quem já se comprou, por quanto e quando"
              className="text-left text-sm leading-snug underline decoration-dotted decoration-muted-foreground/40 underline-offset-4"
            >
              <span className="font-mono text-xs text-muted-foreground">{item.codigo}</span>{" "}
              {item.descricao}
            </button>
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
            <span className="text-muted-foreground">
              última compra <UltimaCompra em={item.ultimaCompra} />
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
              onChange={(e) => onQuantidade(Math.trunc(Number(e.target.value)) || 0)}
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

/**
 * O que se pediu da última vez — a informação que se leva para a ligação com
 * o vendedor: quanto, por quanto e quando.
 *
 * A variação do custo vem junto porque é o argumento da negociação: "subiu
 * 12% desde o último pedido" é uma frase que se usa ao telefone; dois números
 * soltos em colunas distantes, não.
 */
function UltimoPedido({ item }: { item: ItemDoFornecedor }) {
  const ultimo = item.ultimoPedido
  if (!ultimo) return <span className="text-muted-foreground">—</span>

  const variacao =
    ultimo.custoUnitario > 0
      ? ((item.custoUnitario - ultimo.custoUnitario) / ultimo.custoUnitario) * 100
      : 0

  return (
    // Aba nova, e não navegação: o pedido em montagem está só na memória desta
    // tela — sair dele para conferir o anterior perderia tudo que já foi
    // marcado. É a mesma razão de os outros links de papel abrirem à parte.
    <a
      href={`/pedidos-de-compra/${ultimo.id}/impressao`}
      target="_blank"
      rel="noreferrer"
      className="tabular-nums underline decoration-dotted underline-offset-2 hover:decoration-solid"
      title={
        `Abrir o pedido #${ultimo.numero} (${ultimo.situacao}) de ` +
        `${new Date(ultimo.em).toLocaleDateString("pt-BR")} — ` +
        `${formatarQuantidade(ultimo.quantidade)} ${item.unidade} a ${moeda(ultimo.custoUnitario)}`
      }
    >
      {formatarQuantidade(ultimo.quantidade)}{" "}
      <span className="text-muted-foreground">· {dataCurta(ultimo.em)}</span>
      {Math.abs(variacao) >= 1 ? (
        <span
          className={cn(
            "ml-1 text-[10px]",
            variacao > 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"
          )}
        >
          {variacao > 0 ? "+" : ""}
          {variacao.toFixed(0)}%
        </span>
      ) : null}
    </a>
  )
}

/** "03/10/26": a data cabe na coluna estreita, e o ano curto não confunde. */
function dataCurta(em: Date | string) {
  return new Date(em).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: "America/Sao_Paulo",
  })
}

/**
 * A última vez que se COMPROU deste fornecedor — do histórico de fornecimentos,
 * que inclui o sistema antigo. Diferente do "Último pedido", que é só o que se
 * pediu por este sistema.
 */
function UltimaCompra({ em }: { em: Date | string | null }) {
  if (!em) return <span>—</span>
  return <span title={new Date(em).toLocaleDateString("pt-BR")}>{dataCurta(em)}</span>
}

/** O punhado que o diálogo de histórico precisa, do item do catálogo. */
function doHistorico(item: ItemDoFornecedor): ProdutoDoHistorico {
  return {
    id: item.produtoId,
    codigo: item.codigo,
    descricao: item.descricao,
    unidade: item.unidade,
  }
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

/**
 * Cadastro rápido de fornecedor sem sair do pedido — os mesmos campos e as
 * mesmas regras da tela de Fornecedores (o servidor usa `criarFornecedor`).
 * Cadastrado, a tela já abre o pedido com ele.
 */
function NovoFornecedor({
  proximoCodigo,
  onCancelar,
}: {
  proximoCodigo: string
  onCancelar: () => void
}) {
  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"
  const erro = fetcher.data && !fetcher.data.ok ? fetcher.data.erro : null

  return (
    <fetcher.Form
      method="post"
      className="mt-4 max-w-3xl rounded-xl border border-border p-4"
    >
      <input type="hidden" name="intencao" value="cadastrarFornecedor" />
      <h2 className="text-sm font-semibold">Novo fornecedor</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Código
          <Input name="codigo" defaultValue={proximoCodigo} required className="font-mono" />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
          Razão social
          <Input name="razaoSocial" required autoFocus />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
          Nome fantasia
          <Input name="nomeFantasia" placeholder="como a loja chama o fornecedor" />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          CNPJ/CPF
          <Input name="documento" inputMode="numeric" placeholder="opcional" />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Cidade
          <Input name="cidade" required />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Bairro
          <Input name="bairro" required />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Observação
          <Input name="observacao" />
        </label>
      </div>
      {erro ? <p className="mt-2 text-sm text-destructive">{erro}</p> : null}
      <div className="mt-3 flex gap-2">
        <Button type="submit" size="sm" disabled={gravando}>
          {gravando ? "Cadastrando…" : "Cadastrar e montar o pedido"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </fetcher.Form>
  )
}

/**
 * Pedir ao fornecedor um produto que ele nunca vendeu. O produto que já está na
 * lista dele não entra aqui: é só marcado na tabela de cima, com o custo dele.
 */
function OutrosProdutos({
  catalogo,
  jaDoFornecedor,
  outros,
  onMudar,
  onJaDoFornecedor,
  custoConhecido,
}: {
  catalogo: ProdutoDoCatalogo[]
  jaDoFornecedor: string[]
  outros: { produtoId: string; quantidadeTexto: string; custoTexto: string }[]
  onMudar: (
    outros: { produtoId: string; quantidadeTexto: string; custoTexto: string }[]
  ) => void
  onJaDoFornecedor: (produtoId: string) => void
  custoConhecido: Record<string, number>
}) {
  const indice = useMemo(() => criarIndice(catalogo), [catalogo])
  const porId = useMemo(() => new Map(catalogo.map((p) => [p.id, p])), [catalogo])

  function escolher(produtoId: string) {
    if (jaDoFornecedor.includes(produtoId)) {
      onJaDoFornecedor(produtoId)
      return
    }
    if (outros.some((o) => o.produtoId === produtoId)) return
    const custo = custoConhecido[produtoId]
    onMudar([
      ...outros,
      {
        produtoId,
        quantidadeTexto: "",
        custoTexto: custo ? String(custo).replace(".", ",") : "",
      },
    ])
  }

  function mudar(i: number, campo: "quantidadeTexto" | "custoTexto", valor: string) {
    onMudar(outros.map((o, idx) => (idx === i ? { ...o, [campo]: valor } : o)))
  }

  return (
    <div className="mt-6 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Pedir outro produto do catálogo</h2>
        <span className="text-xs text-muted-foreground">
          o que este fornecedor ainda não vendeu — com o custo combinado
        </span>
        <div className="w-full sm:ml-auto sm:w-80">
          <EscolhaDeProduto escolhido={null} destacados={[]} indice={indice} onEscolher={escolher} />
        </div>
      </div>

      {outros.length > 0 ? (
        <table className="mt-3 w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Produto</th>
              <th className="w-28 py-2 pr-3 text-right font-semibold">Quantidade</th>
              <th className="w-28 py-2 pr-3 text-right font-semibold">Custo</th>
              <th className="w-28 py-2 pr-3 text-right font-semibold">Subtotal</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {outros.map((o, i) => {
              const produto = porId.get(o.produtoId)
              const quantidade = Math.trunc(Number(o.quantidadeTexto)) || 0
              const custo = interpretarValor(o.custoTexto) ?? 0
              return (
                <tr key={o.produtoId}>
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs text-muted-foreground">{produto?.codigo}</span>{" "}
                    {produto?.descricao}{" "}
                    <span className="text-xs text-muted-foreground">{produto?.unidade}</span>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={o.quantidadeTexto}
                      onChange={(e) => mudar(i, "quantidadeTexto", e.target.value)}
                      className={cn(
                        "h-7 w-20 rounded border border-border bg-background px-1.5 text-right text-sm tabular-nums",
                        !(quantidade > 0) && "border-destructive/50"
                      )}
                    />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Input
                      value={o.custoTexto}
                      onChange={(e) => mudar(i, "custoTexto", e.target.value)}
                      inputMode="decimal"
                      className={cn(
                        "h-7 w-24 text-right font-mono text-xs",
                        !(custo > 0) && "border-destructive/50"
                      )}
                    />
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {quantidade > 0 && custo > 0 ? moeda(quantidade * custo) : "—"}
                  </td>
                  <td>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => onMudar(outros.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
