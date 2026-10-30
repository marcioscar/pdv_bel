import { useMemo, useState } from "react"
import { useFetcher } from "react-router"
import { PackagePlus, Plus, Trash2 } from "lucide-react"

import { EscolhaDeProduto, type ProdutoDoCatalogo } from "~/components/pdv/escolha-de-produto"
import { ESTILO_CAMPO } from "~/components/pdv/filtros"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { ratearPorValor } from "~/lib/custo-nfe"
import { arredondar, interpretarValor, moeda } from "~/lib/moeda"
import { criarIndice } from "~/lib/pdv"
import { cn } from "~/lib/utils"

type PedidoAberto = {
  id: string
  numero: number
  itens: { produtoId: string; quantidade: number; custoUnitario: number }[]
}

type Linha = { chave: number; produtoId: string | null; quantidade: string; custo: string }

type Resposta =
  | { intencao: "receber"; ok: true; situacao: "recebido" | "parcial" | "sem-pedido" }
  | { intencao: "receber"; ok: false; erro: string }

let proximaChave = 1
const linhaVazia = (): Linha => ({ chave: proximaChave++, produtoId: null, quantidade: "", custo: "" })

const emTexto = (valor: number) => valor.toFixed(2).replace(".", ",")

/**
 * Os itens de uma nota que chegou só como resumo, digitados à mão.
 *
 * Às vezes o XML completo não vem nem depois da ciência da operação — e a
 * mercadoria já está na prateleira. Sem isto, o caminho era a entrada avulsa do
 * estoque, sem custo e sem ligação com a nota, ou deixar a nota parada.
 *
 * Grava pelo MESMO `receberComNota` da nota completa: estoque com custo, pedido
 * de compra baixado, nota marcada como recebida. A única diferença é de onde
 * vêm os itens — do papel, e não do XML. Se o XML chegar depois, os produtos já
 * lançados por esta nota não entram de novo: `receberComNota` pula os que a
 * nota já lançou.
 */
export function LancamentoManualDaNota({
  notaId,
  lojaPadrao,
  lojas,
  pedidos,
  catalogo,
  valorDaNota,
  frete,
}: {
  notaId: string
  /** A loja destinatária da nota — quase sempre é ela que recebeu. */
  lojaPadrao: string
  lojas: string[]
  pedidos: PedidoAberto[]
  catalogo: ProdutoDoCatalogo[]
  valorDaNota: number | null
  /** O frete à parte gravado na nota — rateado no custo dos itens digitados. */
  frete: number
}) {
  const porId = useMemo(() => new Map(catalogo.map((p) => [p.id, p])), [catalogo])
  const indice = useMemo(() => criarIndice(catalogo), [catalogo])

  const [aberto, setAberto] = useState(false)
  const [loja, setLoja] = useState(lojas.includes(lojaPadrao) ? lojaPadrao : (lojas[0] ?? ""))
  const [pedidoId, setPedidoId] = useState(pedidos.length === 1 ? pedidos[0].id : "")
  const [linhas, setLinhas] = useState<Linha[]>(() =>
    pedidos.length === 1 ? linhasDoPedido(pedidos[0]) : [linhaVazia()]
  )

  const fetcher = useFetcher<Resposta>()
  const gravando = fetcher.state !== "idle"

  /** Com pedido, as linhas já vêm dele: só se confere quantidade e custo do papel. */
  function linhasDoPedido(pedido: PedidoAberto): Linha[] {
    return pedido.itens.map((item) => ({
      chave: proximaChave++,
      produtoId: item.produtoId,
      quantidade: String(item.quantidade),
      custo: emTexto(item.custoUnitario),
    }))
  }

  function escolherPedido(id: string) {
    setPedidoId(id)
    const pedido = pedidos.find((p) => p.id === id)
    setLinhas(pedido ? linhasDoPedido(pedido) : [linhaVazia()])
  }

  function alterar(chave: number, mudanca: Partial<Linha>) {
    setLinhas((atuais) => atuais.map((l) => (l.chave === chave ? { ...l, ...mudanca } : l)))
  }

  const lidas = linhas.map((linha) => {
    const produto = linha.produtoId ? (porId.get(linha.produtoId) ?? null) : null
    const quantidade = Number(linha.quantidade)
    const custo = interpretarValor(linha.custo)
    const erro = !produto
      ? null
      : !Number.isInteger(quantidade) || quantidade <= 0
        ? "quantidade inteira"
        : custo === null || custo < 0
          ? "informe o custo"
          : null
    return {
      linha,
      produto,
      quantidade,
      custo: custo ?? 0,
      erro,
      total: produto && !erro ? arredondar(quantidade * (custo ?? 0)) : 0,
    }
  })
  const validas = lidas.filter((l) => l.produto && !l.erro)
  const soma = arredondar(validas.reduce((s, l) => s + l.total, 0))
  // O frete à parte por unidade de cada linha, na proporção do valor dela.
  const rateios = ratearPorValor(lidas.map((l) => l.total), frete)
  const custoComFrete = (i: number) =>
    lidas[i].quantidade > 0 ? lidas[i].custo + rateios[i] / lidas[i].quantidade : lidas[i].custo
  const comErro = lidas.some((l) => l.erro)
  const repetido = new Set(validas.map((l) => l.produto!.id)).size !== validas.length
  const pronto = !gravando && Boolean(loja) && validas.length > 0 && !comErro && !repetido

  function lancar() {
    if (!pronto) return
    fetcher.submit(
      {
        intencao: "receber",
        notaId,
        loja,
        pedidoId,
        itens: JSON.stringify(
          lidas.flatMap((l, i) =>
            l.produto && !l.erro
              ? [{ produtoId: l.produto.id, quantidade: l.quantidade, custoUnitario: custoComFrete(i) }]
              : []
          )
        ),
      },
      { method: "post" }
    )
  }

  if (!aberto) {
    return (
      <div className="mt-3 rounded-lg border border-border px-4 py-3">
        <p className="text-sm font-medium">O XML não chega?</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Com a mercadoria e o DANFE em mãos, lance os itens à mão: entram no estoque com o
          custo do papel, baixam o pedido de compra e a nota fica como recebida.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3 rounded-lg"
          onClick={() => setAberto(true)}
        >
          <PackagePlus className="size-4" /> Lançar os itens à mão
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">Itens lançados à mão</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Do DANFE que veio com a mercadoria. O custo é o unitário que a nota cobrou — com
        IPI e frete rateado, se houver.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Loja que recebeu
          </span>
          <select value={loja} onChange={(e) => setLoja(e.target.value)} className={cn(ESTILO_CAMPO, "w-28")}>
            {lojas.map((codigo) => (
              <option key={codigo} value={codigo}>
                {codigo}
              </option>
            ))}
          </select>
        </label>
        {pedidos.length > 0 ? (
          <label className="text-xs">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Pedido de compra
            </span>
            <select
              value={pedidoId}
              onChange={(e) => escolherPedido(e.target.value)}
              className={cn(ESTILO_CAMPO, "w-40")}
            >
              <option value="">Sem pedido</option>
              {pedidos.map((p) => (
                <option key={p.id} value={p.id}>
                  Pedido #{p.numero}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Produto</th>
              <th className="px-3 py-2 text-right font-semibold">Qtd</th>
              <th className="px-3 py-2 text-right font-semibold">Custo unit.</th>
              <th className="px-3 py-2 text-right font-semibold">Total</th>
              {frete > 0 ? (
                <th className="px-3 py-2 text-right font-semibold">Custo c/ frete</th>
              ) : null}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lidas.map(({ linha, produto, erro, total }, i) => (
              <tr key={linha.chave}>
                <td className="px-3 py-2">
                  <EscolhaDeProduto
                    escolhido={produto}
                    destacados={pedidos.find((p) => p.id === pedidoId)?.itens.map((i) => i.produtoId) ?? []}
                    indice={indice}
                    onEscolher={(produtoId) => alterar(linha.chave, { produtoId })}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <Input
                    value={linha.quantidade}
                    onChange={(e) => alterar(linha.chave, { quantidade: e.target.value.replace(/\D/g, "") })}
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label="Quantidade"
                    className="ml-auto h-8 w-20 rounded-lg text-right font-mono tabular-nums"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <Input
                    value={linha.custo}
                    onChange={(e) => alterar(linha.chave, { custo: e.target.value })}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Custo unitário"
                    className={cn(
                      "ml-auto h-8 w-24 rounded-lg text-right font-mono tabular-nums",
                      erro && "border-destructive text-destructive"
                    )}
                  />
                  {erro ? <div className="mt-0.5 text-[10px] text-destructive">{erro}</div> : null}
                </td>
                <td className="px-3 py-2 text-right font-mono">{total > 0 ? moeda(total) : "—"}</td>
                {frete > 0 ? (
                  <td className="px-3 py-2 text-right font-mono">
                    {total > 0 ? moeda(custoComFrete(i)) : "—"}
                  </td>
                ) : null}
                <td className="pr-2">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Tirar a linha"
                    disabled={linhas.length === 1}
                    onClick={() => setLinhas((atuais) => atuais.filter((l) => l.chave !== linha.chave))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="mt-1.5 rounded-lg text-muted-foreground"
        onClick={() => setLinhas((atuais) => [...atuais, linhaVazia()])}
      >
        <Plus className="size-4" /> Outro produto
      </Button>
      {repetido ? (
        <p className="mt-1 text-xs text-destructive">
          O mesmo produto aparece duas vezes — junte numa linha só.
        </p>
      ) : null}

      {/* A soma não precisa bater com a nota — frete, IPI e desconto mexem no
          total —, mas a diferença à vista é o que pega item esquecido. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-sm">
        <span>
          Itens: <b className="font-mono tabular-nums">{moeda(soma)}</b>
        </span>
        {frete > 0 ? (
          <span className="text-muted-foreground">
            Frete à parte: <span className="font-mono tabular-nums">{moeda(frete)}</span>
          </span>
        ) : null}
        {valorDaNota != null ? (
          <span className="text-muted-foreground">
            Nota: <span className="font-mono tabular-nums">{moeda(valorDaNota)}</span>
            {Math.abs(soma - valorDaNota) > 0.005 && soma > 0 ? (
              <span className="ml-2 text-xs">
                (diferença de {moeda(Math.abs(soma - valorDaNota))} — confira frete, IPI ou item
                esquecido)
              </span>
            ) : null}
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={!pronto}
          onClick={lancar}
          className="ml-auto rounded-lg"
        >
          <PackagePlus className="size-4" />
          {gravando ? "Lançando…" : "Dar entrada no estoque"}
        </Button>
      </div>

      {fetcher.data && !fetcher.data.ok ? (
        <p className="mt-2 text-xs font-medium text-destructive" role="alert">
          {fetcher.data.erro}
        </p>
      ) : null}
    </div>
  )
}
