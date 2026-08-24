import { useMemo, useState } from "react"
import { data, useFetcher } from "react-router"
import { CheckCircle2, PackageCheck, Printer, Send, ShoppingCart, X } from "lucide-react"

import type { Route } from "./+types/admin.compras"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { cn } from "~/lib/utils"
import { exigirGerente } from "~/lib/sessao.server"
import { db } from "~/lib/db.server"
import { listaDeCompra, origemDaPolitica, type LinhaDeCompra } from "~/lib/compras.server"
import {
  criarPedido,
  listarPedidos,
  marcarEnviado,
  marcarRecebido,
  cancelarPedido,
} from "~/lib/pedidos-compra.server"
import {
  DIAS_DE_COBERTURA,
  DIAS_DE_ENTREGA,
  DIAS_DE_SEGURANCA,
  ROTULOS_DE_URGENCIA,
  type Urgencia,
} from "~/lib/compras"
import { listarLojas } from "~/lib/lojas.server"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Compras — BrasSaco" }]
}

/**
 * O que comprar, para a rede toda — e daqui se manda o pedido.
 *
 * Só gerente: a lista revela consumo e custo de compra, que é informação de
 * negociação com fornecedor, não de balcão.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const [linhas, origem, lojas, pedidos, fornecedores] = await Promise.all([
    listaDeCompra({ incluirSuficientes: true }),
    origemDaPolitica(),
    listarLojas(),
    listarPedidos(20),
    db.fornecedor.findMany({
      where: { ativo: true },
      orderBy: [{ ultimaCompra: "desc" }, { razaoSocial: "asc" }],
      select: { id: true, razaoSocial: true, nomeFantasia: true },
    }),
  ])

  return {
    linhas,
    origem,
    lojas: lojas.map((l) => l.codigo),
    pedidos,
    fornecedores: fornecedores.map((f) => ({ id: f.id, nome: f.nomeFantasia || f.razaoSocial })),
  }
}

type ItemSelecionado = { produtoId: string; quantidade: number; fornecedorId: string }

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verRelatorios")
  const form = await request.formData()
  const intencao = String(form.get("intencao") ?? "")

  if (intencao === "gerarPedidos") {
    let itens: ItemSelecionado[] = []
    try {
      itens = JSON.parse(String(form.get("itens") ?? "[]"))
    } catch {
      itens = []
    }
    if (itens.length === 0) {
      return data({ ok: false as const, erro: "Nenhum item selecionado" }, { status: 400 })
    }

    // Um pedido por fornecedor: é assim que se manda — o fornecedor não recebe
    // uma lista com produtos de outra empresa misturados.
    const porFornecedor = new Map<string, { produtoId: string; quantidade: number }[]>()
    for (const item of itens) {
      if (!item.fornecedorId || !(item.quantidade > 0)) continue
      if (!porFornecedor.has(item.fornecedorId)) porFornecedor.set(item.fornecedorId, [])
      porFornecedor.get(item.fornecedorId)!.push({
        produtoId: item.produtoId,
        quantidade: item.quantidade,
      })
    }
    if (porFornecedor.size === 0) {
      return data(
        { ok: false as const, erro: "Escolha um fornecedor para os itens selecionados" },
        { status: 400 }
      )
    }

    const gerados: { numero: number; id: string }[] = []
    for (const [fornecedorId, itensDoFornecedor] of porFornecedor) {
      const resultado = await criarPedido({
        fornecedorId,
        itens: itensDoFornecedor,
        operador: eu.nome,
      })
      if (!resultado.ok) {
        return data(
          { ok: false as const, erro: `${resultado.erro} (pedidos anteriores já foram gravados)` },
          { status: 400 }
        )
      }
      gerados.push({ numero: resultado.numero, id: resultado.id })
    }

    return {
      ok: true as const,
      mensagem:
        gerados.length === 1
          ? `Pedido #${gerados[0].numero} gerado`
          : `${gerados.length} pedidos gerados: ${gerados.map((g) => `#${g.numero}`).join(", ")}`,
      gerados,
    }
  }

  if (intencao === "situacao") {
    const id = String(form.get("id") ?? "")
    const passo = String(form.get("passo") ?? "")
    const resultado =
      passo === "enviar"
        ? await marcarEnviado(id, eu.nome)
        : passo === "receber"
          ? await marcarRecebido(id, eu.nome)
          : passo === "cancelar"
            ? await cancelarPedido(id, eu.nome)
            : { ok: false as const, erro: "Ação inválida" }

    return resultado.ok
      ? { ok: true as const, mensagem: "Atualizado" }
      : data({ ok: false as const, erro: resultado.erro }, { status: 400 })
  }

  return data({ ok: false as const, erro: "Ação inválida" }, { status: 400 })
}

const CORES: Record<Urgencia, string> = {
  sem_estoque: "bg-destructive/10 text-destructive",
  critico: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  comprar: "bg-primary/10 text-foreground",
  ok: "bg-muted text-muted-foreground",
}

const ROTULO_SITUACAO: Record<string, string> = {
  rascunho: "Rascunho",
  enviado: "Enviado",
  recebido: "Recebido",
  cancelado: "Cancelado",
}

export default function AdminCompras({ loaderData }: Route.ComponentProps) {
  const { linhas, origem, lojas, pedidos, fornecedores } = loaderData
  const [busca, setBusca] = useState("")
  const [mostrarTudo, setMostrarTudo] = useState(false)
  const [selecionados, setSelecionados] = useState<Record<string, boolean>>({})
  const [quantidades, setQuantidades] = useState<Record<string, number>>({})
  const [fornecedorEscolhido, setFornecedorEscolhido] = useState<Record<string, string>>({})

  const pedidoFetcher = useFetcher<typeof action>()
  const gerando = pedidoFetcher.state !== "idle"

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    return linhas.filter((l) => {
      if (!mostrarTudo && l.urgencia === "ok") return false
      if (!termo) return true
      return (
        l.descricao.toLowerCase().includes(termo) || l.codigo.toLowerCase().includes(termo)
      )
    })
  }, [linhas, busca, mostrarTudo])

  const aComprar = linhas.filter((l) => l.urgencia !== "ok")
  const total = aComprar.reduce((soma, l) => soma + l.valorEstimado, 0)
  const semEstoque = aComprar.filter((l) => l.urgencia === "sem_estoque").length
  const semCusto = aComprar.filter((l) => !l.temCusto).length

  function fornecedorDe(l: LinhaDeCompra) {
    return fornecedorEscolhido[l.produtoId] ?? l.fornecedorId ?? ""
  }
  function quantidadeDe(l: LinhaDeCompra) {
    return quantidades[l.produtoId] ?? l.comprar
  }

  function alternar(l: LinhaDeCompra) {
    setSelecionados((s) => ({ ...s, [l.produtoId]: !s[l.produtoId] }))
  }

  const itensParaPedido = linhas
    .filter((l) => selecionados[l.produtoId])
    .map((l) => ({
      produtoId: l.produtoId,
      quantidade: quantidadeDe(l),
      fornecedorId: fornecedorDe(l),
    }))
    .filter((i) => i.quantidade > 0)

  const selecionadosSemFornecedor = itensParaPedido.filter((i) => !i.fornecedorId).length
  const totalSelecionado = linhas
    .filter((l) => selecionados[l.produtoId])
    .reduce((soma, l) => soma + quantidadeDe(l) * l.custoUnitario, 0)

  function gerarPedidos() {
    if (itensParaPedido.length === 0 || gerando) return
    pedidoFetcher.submit(
      { intencao: "gerarPedidos", itens: JSON.stringify(itensParaPedido) },
      { method: "post" }
    )
    setSelecionados({})
  }

  function mudarSituacao(id: string, passo: "enviar" | "receber" | "cancelar") {
    pedidoFetcher.submit({ intencao: "situacao", id, passo }, { method: "post" })
  }

  if (!origem) return <SemPolitica />

  const totalSelecionados = Object.values(selecionados).filter(Boolean).length

  return (
    <div className="p-4 pb-24 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ShoppingCart className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Compras</h1>
        <span className="text-xs text-muted-foreground">
          {aComprar.length} {aComprar.length === 1 ? "produto" : "produtos"} para repor
        </span>
      </div>

      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        A conta é da rede somada, porque a compra é central. O ponto de pedido cobre os{" "}
        {DIAS_DE_ENTREGA} dias do fornecedor mais {DIAS_DE_SEGURANCA} de folga; a
        quantidade sugerida enche {DIAS_DE_COBERTURA} dias de venda, já descontando o
        que está em trânsito entre lojas e o que já foi pedido a fornecedor.
      </p>

      <div className="mt-5 flex flex-wrap gap-3">
        <Cartao rotulo="Sem estoque" valor={String(semEstoque)} alerta={semEstoque > 0} />
        <Cartao rotulo="Itens a comprar" valor={String(aComprar.length)} />
        <Cartao rotulo="Valor estimado" valor={moeda(total)} />
        {semCusto > 0 ? (
          <Cartao rotulo="Sem custo real" valor={String(semCusto)} />
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por código ou descrição"
          autoComplete="off"
          className="h-10 w-full min-w-0 rounded-lg border-border bg-background text-sm sm:w-72"
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={mostrarTudo}
            onChange={(e) => setMostrarTudo(e.target.checked)}
            className="size-4 accent-primary"
          />
          Mostrar também o que está suficiente
        </label>
      </div>

      {visiveis.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border py-16 text-center">
          <ShoppingCart className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">
            {busca
              ? "Nenhum produto com esse termo."
              : "Nada abaixo do ponto de pedido. O estoque cobre a demanda."}
          </p>
        </div>
      ) : (
        <Tabela
          linhas={visiveis}
          lojas={lojas}
          fornecedores={fornecedores}
          selecionados={selecionados}
          quantidades={quantidades}
          fornecedorEscolhido={fornecedorEscolhido}
          onAlternar={alternar}
          onQuantidade={(id, v) => setQuantidades((q) => ({ ...q, [id]: v }))}
          onFornecedor={(id, v) => setFornecedorEscolhido((f) => ({ ...f, [id]: v }))}
        />
      )}

      <p className="mt-4 text-[11px] text-muted-foreground">
        Calculado em{" "}
        {new Date(origem.calculadoEm).toLocaleString("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        })}{" "}
        sobre {origem.diasAnalisados} dias de venda, {origem.produtos} produtos.
        {origem.diasAnalisados < 90 ? (
          <b className="ml-1 text-amber-700 dark:text-amber-400">
            Período curto: produto de giro lento tem média pouco confiável e a
            sazonalidade não aparece.
          </b>
        ) : null}
      </p>

      <PedidosRecentes pedidos={pedidos} onMudarSituacao={mudarSituacao} gravando={gerando} />

      {pedidoFetcher.data ? (
        <p
          role="alert"
          className={cn(
            "fixed inset-x-4 bottom-20 z-20 mx-auto max-w-md rounded-lg px-3 py-2 text-center text-sm shadow-lg sm:bottom-4",
            pedidoFetcher.data.ok
              ? "bg-primary text-primary-foreground"
              : "bg-destructive text-destructive-foreground"
          )}
        >
          {pedidoFetcher.data.ok ? pedidoFetcher.data.mensagem : pedidoFetcher.data.erro}
        </p>
      ) : null}

      {totalSelecionados > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] sm:px-6">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <span className="text-sm font-medium">
              {totalSelecionados} {totalSelecionados === 1 ? "item selecionado" : "itens selecionados"}
            </span>
            <span className="text-xs text-muted-foreground">≈ {moeda(totalSelecionado)}</span>
            {selecionadosSemFornecedor > 0 ? (
              <span className="text-xs font-medium text-destructive">
                {selecionadosSemFornecedor} sem fornecedor escolhido
              </span>
            ) : null}
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelecionados({})}
                className="rounded-lg"
              >
                <X className="size-4" />
                Limpar
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  gerando || itensParaPedido.length === 0 || selecionadosSemFornecedor > 0
                }
                onClick={gerarPedidos}
                className="rounded-lg"
              >
                <Send className="size-4" />
                {gerando ? "Gerando…" : "Gerar pedido"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Cartao({
  rotulo,
  valor,
  alerta,
}: {
  rotulo: string
  valor: string
  alerta?: boolean
}) {
  return (
    <div className="min-w-32 flex-1 rounded-xl border border-border px-4 py-3 sm:flex-none">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </p>
      <p
        className={cn(
          "mt-1 font-mono text-lg font-bold tabular-nums",
          alerta && "text-destructive"
        )}
      >
        {valor}
      </p>
    </div>
  )
}

function Tabela({
  linhas,
  lojas,
  fornecedores,
  selecionados,
  quantidades,
  fornecedorEscolhido,
  onAlternar,
  onQuantidade,
  onFornecedor,
}: {
  linhas: LinhaDeCompra[]
  lojas: string[]
  fornecedores: { id: string; nome: string }[]
  selecionados: Record<string, boolean>
  quantidades: Record<string, number>
  fornecedorEscolhido: Record<string, string>
  onAlternar: (l: LinhaDeCompra) => void
  onQuantidade: (produtoId: string, valor: number) => void
  onFornecedor: (produtoId: string, valor: string) => void
}) {
  return (
    <>
      {/* Telefone: cada produto é um cartão. */}
      <ul className="mt-4 grid gap-2 sm:hidden">
        {linhas.map((l) => (
          <Cartaozinho
            key={l.produtoId}
            linha={l}
            lojas={lojas}
            fornecedores={fornecedores}
            selecionado={!!selecionados[l.produtoId]}
            quantidade={quantidades[l.produtoId] ?? l.comprar}
            fornecedorId={fornecedorEscolhido[l.produtoId] ?? l.fornecedorId ?? ""}
            onAlternar={() => onAlternar(l)}
            onQuantidade={(v) => onQuantidade(l.produtoId, v)}
            onFornecedor={(v) => onFornecedor(l.produtoId, v)}
          />
        ))}
      </ul>

      <div className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-8 py-2 pr-2" />
              <th className="py-2 pr-3 font-semibold">Produto</th>
              <th className="py-2 pr-3 text-right font-semibold">Por dia</th>
              <th className="py-2 pr-3 text-right font-semibold">Estoque</th>
              <th className="py-2 pr-3 text-right font-semibold">Pedir em</th>
              <th className="py-2 pr-3 text-right font-semibold">Dura</th>
              <th className="py-2 pr-3 text-right font-semibold">Comprar</th>
              <th className="py-2 pr-3 text-right font-semibold">Custo</th>
              <th className="py-2 pr-3 text-left font-semibold">Fornecedor</th>
              <th className="py-2 text-right font-semibold">Valor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {linhas.map((l) => {
              const marcado = !!selecionados[l.produtoId]
              const qtd = quantidades[l.produtoId] ?? l.comprar
              const fornecedorId = fornecedorEscolhido[l.produtoId] ?? l.fornecedorId ?? ""
              return (
                <tr key={l.produtoId} className={cn(marcado && "bg-primary/5")}>
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() => onAlternar(l)}
                      className="size-4 accent-primary"
                      aria-label={`Selecionar ${l.descricao}`}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs text-muted-foreground">{l.codigo}</span>{" "}
                    {l.descricao}
                    <Badge
                      variant="outline"
                      className={cn("ml-2 border-0 text-[10px]", CORES[l.urgencia])}
                    >
                      {ROTULOS_DE_URGENCIA[l.urgencia]}
                    </Badge>
                    {l.emPedido > 0 ? (
                      <span
                        className="ml-2 text-[10px] text-muted-foreground"
                        title="Já foi pedido a um fornecedor e ainda não chegou"
                      >
                        {formatarQuantidade(l.emPedido)} em pedido
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {l.consumoMedioDiario.toFixed(1)}
                  </td>
                  <td
                    className={cn(
                      "py-2 pr-3 text-right font-semibold",
                      l.estoque <= 0 && "text-destructive"
                    )}
                  >
                    {formatarQuantidade(l.estoque)}
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {formatarQuantidade(l.pontoDePedido)}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Duracao dias={l.diasRestantes} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {l.comprar > 0 ? (
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={qtd}
                        onChange={(e) => onQuantidade(l.produtoId, Number(e.target.value) || 0)}
                        className="h-7 w-20 rounded border border-border bg-background px-1.5 text-right text-sm tabular-nums"
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {l.temCusto ? moeda(l.custoUnitario) : `~${moeda(l.custoUnitario)}`}
                  </td>
                  <td className="py-2 pr-3">
                    <SeletorFornecedor
                      valor={fornecedorId}
                      linha={l}
                      fornecedores={fornecedores}
                      onChange={(v) => onFornecedor(l.produtoId, v)}
                    />
                  </td>
                  <td className="py-2 text-right text-muted-foreground">
                    {qtd > 0 ? moeda(qtd * l.custoUnitario) : "—"}
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

/**
 * Quem fornece este produto. O principal vem marcado, os outros que já
 * forneceram entram como opção — é a comparação de preço que a lista existe
 * para dar — e por último todo o cadastro, para o caso raro sem histórico.
 */
function SeletorFornecedor({
  valor,
  linha,
  fornecedores,
  onChange,
}: {
  valor: string
  linha: LinhaDeCompra
  fornecedores: { id: string; nome: string }[]
  onChange: (valor: string) => void
}) {
  const conhecidos = new Set(
    [linha.fornecedorId, ...linha.outrosFornecedores.map((f) => f.fornecedorId)].filter(
      (v): v is string => !!v
    )
  )
  const demais = fornecedores.filter((f) => !conhecidos.has(f.id))

  return (
    <select
      value={valor}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-7 max-w-40 rounded border bg-background px-1.5 text-xs",
        valor ? "border-border" : "border-destructive/50 text-destructive"
      )}
    >
      <option value="">Escolher…</option>
      {linha.fornecedorId ? (
        <option value={linha.fornecedorId}>{linha.fornecedorNome} (último)</option>
      ) : null}
      {linha.outrosFornecedores.map((f) => (
        <option key={f.fornecedorId} value={f.fornecedorId}>
          {f.nome} — {moeda(f.custo)}
        </option>
      ))}
      {demais.length > 0 ? (
        <optgroup label="Outros cadastrados">
          {demais.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  )
}

function Cartaozinho({
  linha: l,
  lojas,
  fornecedores,
  selecionado,
  quantidade,
  fornecedorId,
  onAlternar,
  onQuantidade,
  onFornecedor,
}: {
  linha: LinhaDeCompra
  lojas: string[]
  fornecedores: { id: string; nome: string }[]
  selecionado: boolean
  quantidade: number
  fornecedorId: string
  onAlternar: () => void
  onQuantidade: (valor: number) => void
  onFornecedor: (valor: string) => void
}) {
  return (
    <li className={cn("rounded-xl border border-border p-3", selecionado && "bg-primary/5")}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selecionado}
          onChange={onAlternar}
          className="mt-0.5 size-4 shrink-0 accent-primary"
          aria-label={`Selecionar ${l.descricao}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm leading-snug">
              <span className="font-mono text-xs text-muted-foreground">{l.codigo}</span>{" "}
              {l.descricao}
            </p>
            <Badge
              variant="outline"
              className={cn("shrink-0 border-0 text-[10px]", CORES[l.urgencia])}
            >
              {ROTULOS_DE_URGENCIA[l.urgencia]}
            </Badge>
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums">
            <span>
              <b className={cn("font-mono", l.estoque <= 0 && "text-destructive")}>
                {formatarQuantidade(l.estoque)}
              </b>{" "}
              <span className="text-muted-foreground">em estoque</span>
            </span>
            <span className="text-muted-foreground">
              <Duracao dias={l.diasRestantes} />
            </span>
          </div>

          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {lojas.map((loja) => `${loja} ${formatarQuantidade(l.porLoja[loja] ?? 0)}`).join("  ")}
          </p>

          {l.comprar > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <input
                type="number"
                min={0}
                step={1}
                value={quantidade}
                onChange={(e) => onQuantidade(Number(e.target.value) || 0)}
                className="h-9 w-20 rounded border border-border bg-background px-2 text-sm tabular-nums"
              />
              <span className="text-xs text-muted-foreground">{l.unidade}</span>
              <SeletorFornecedor
                valor={fornecedorId}
                linha={l}
                fornecedores={fornecedores}
                onChange={onFornecedor}
              />
              <span className="ml-auto text-xs text-muted-foreground">
                ≈ {moeda(quantidade * l.custoUnitario)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function PedidosRecentes({
  pedidos,
  onMudarSituacao,
  gravando,
}: {
  pedidos: Awaited<ReturnType<typeof listarPedidos>>
  onMudarSituacao: (id: string, passo: "enviar" | "receber" | "cancelar") => void
  gravando: boolean
}) {
  if (pedidos.length === 0) return null

  return (
    <section className="mt-8">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Pedidos recentes
      </h2>
      <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
        {pedidos.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="font-mono text-sm font-semibold">#{p.numero}</span>
            <span className="text-sm">{p.fornecedorNome}</span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {moeda(p.total)}
            </span>
            <span className="text-xs text-muted-foreground">
              {p.itens.length} {p.itens.length === 1 ? "item" : "itens"} ·{" "}
              {new Date(p.criadoEm).toLocaleDateString("pt-BR")}
            </span>
            <Badge
              variant={p.situacao === "cancelado" ? "destructive" : "outline"}
              className="text-[10px]"
            >
              {ROTULO_SITUACAO[p.situacao] ?? p.situacao}
            </Badge>

            <div className="ml-auto flex items-center gap-1">
              <a
                href={`/pedidos-de-compra/${p.id}/impressao`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Printer className="size-3.5" aria-hidden />
                Imprimir
              </a>
              {p.situacao === "rascunho" ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={gravando}
                    onClick={() => onMudarSituacao(p.id, "enviar")}
                  >
                    <Send className="size-3.5" />
                    Enviado
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={gravando}
                    onClick={() => onMudarSituacao(p.id, "cancelar")}
                    className="text-destructive"
                  >
                    Cancelar
                  </Button>
                </>
              ) : null}
              {p.situacao === "enviado" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={gravando}
                  onClick={() => onMudarSituacao(p.id, "receber")}
                >
                  <PackageCheck className="size-3.5" />
                  Recebido
                </Button>
              ) : null}
              {p.situacao === "recebido" ? (
                <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** "Dura 4 dias" responde a pergunta melhor que "estoque 120". */
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

function SemPolitica() {
  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ShoppingCart className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Compras</h1>
      </div>
      <div className="mt-6 rounded-xl border border-dashed border-border px-6 py-16 text-center">
        <ShoppingCart className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
        <p className="mt-3 text-sm font-medium">Nenhuma política de compra calculada</p>
        <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">
          O ponto de pedido vem do histórico de venda. Rode{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
            node scripts/calcular-politica-de-compra.mjs dados/&lt;arquivo.csv&gt; --gravar
          </code>{" "}
          com o faturamento exportado do sistema antigo.
        </p>
      </div>
    </div>
  )
}
