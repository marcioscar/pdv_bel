import { useEffect } from "react"
import { useFetcher } from "react-router"
import { FileText, Receipt, ShoppingBag, Truck } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import type { HistoricoDeCompras } from "~/routes/produto.compras"
import { cn } from "~/lib/utils"

export type ProdutoDoHistorico = {
  id: string
  codigo: string
  descricao: string
  unidade: string
}

/** Para onde cada documento leva — o papel que explica aquela entrada. */
const DOCUMENTOS = {
  nfe: { rotulo: "NF", caminho: (id: string) => `/admin/notas-de-entrada/${id}`, Icone: Receipt },
  af: { rotulo: "AF", caminho: (id: string) => `/admin/afs/${id}`, Icone: FileText },
  pedido: {
    rotulo: "Pedido",
    caminho: (id: string) => `/pedidos-de-compra/${id}/impressao`,
    Icone: ShoppingBag,
  },
} as const

const SITUACOES: Record<string, string> = {
  rascunho: "rascunho",
  enviado: "enviado",
  parcial: "chegou em parte",
}

/**
 * De quem já se comprou este produto, por quanto e quando.
 *
 * Abre de duas telas — do catálogo e da montagem do pedido — e por isso mora
 * aqui e não dentro de uma delas: é a mesma pergunta feita em dois momentos
 * ("quanto custa isto, afinal?" e "quanto peço, e a quem?"), e duas cópias
 * divergiriam na primeira vez que uma ganhasse coluna.
 *
 * Carrega quando abre, como o histórico do cliente: é o de UM produto que
 * interessa, no momento em que alguém pergunta.
 */
export function ComprasDoProduto({ produto }: { produto: ProdutoDoHistorico }) {
  const busca = useFetcher<HistoricoDeCompras>()

  const carregar = busca.load
  useEffect(() => {
    carregar(`/produtos/${produto.id}/compras`)
  }, [carregar, produto.id])

  const carregando = busca.state !== "idle" && !busca.data
  const fornecedores = busca.data?.fornecedores ?? []
  const compras = busca.data?.compras ?? []
  const pedidosAbertos = busca.data?.pedidosAbertos ?? []

  // O argumento da negociação: entre quem vende isto, qual está mais barato.
  // Só com mais de um — apontar "o menor" numa lista de um é ruído.
  const custos = fornecedores
    .map((f) => f.ultimoCusto)
    .filter((c): c is number => c != null && c > 0)
  const menorCusto = custos.length > 1 ? Math.min(...custos) : null

  const ultima = fornecedores.find((f) => f.ultimaCompra)

  return (
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>
          <span className="font-mono text-xs text-muted-foreground">{produto.codigo}</span>{" "}
          {produto.descricao}
        </DialogTitle>
        <DialogDescription>
          {carregando
            ? "Buscando o histórico de compra…"
            : fornecedores.length === 0 && compras.length === 0
              ? "Nunca foi comprado por aqui, e o histórico importado não traz fornecedor para ele."
              : `${fornecedores.length} ${fornecedores.length === 1 ? "fornecedor" : "fornecedores"}` +
                (ultima?.ultimaCompra
                  ? ` · última compra em ${data(ultima.ultimaCompra)}`
                  : "") +
                ` · custo em ${produto.unidade || "un"}`}
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[60vh] space-y-5 overflow-y-auto">
        {fornecedores.length > 0 ? (
          <section>
            <Titulo>Quem fornece</Titulo>
            <table className="mt-1.5 w-full text-xs tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1.5 pr-3 font-semibold">Fornecedor</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Último custo</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Última compra</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Comprado</th>
                  <th className="py-1.5 text-right font-semibold">Compras</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fornecedores.map((f) => (
                  <tr key={f.fornecedorId}>
                    <td className="py-1.5 pr-3">
                      {f.nome}
                      {f.principal ? (
                        <Badge
                          variant="outline"
                          className="ml-1.5 border-0 bg-primary/10 text-[9px]"
                          title="Quem forneceu por último no histórico — é ele que entra no pedido por padrão"
                        >
                          principal
                        </Badge>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {f.ultimoCusto == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={cn(
                            menorCusto != null &&
                              f.ultimoCusto === menorCusto &&
                              "font-semibold text-emerald-700 dark:text-emerald-400"
                          )}
                          title={
                            menorCusto != null && f.ultimoCusto === menorCusto
                              ? "O menor entre os últimos custos conhecidos"
                              : undefined
                          }
                        >
                          {moeda(f.ultimoCusto)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-muted-foreground">
                      {f.ultimaCompra ? data(f.ultimaCompra) : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-muted-foreground">
                      {formatarQuantidade(f.quantidadeTotal)} {produto.unidade}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">{f.compras}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {pedidosAbertos.length > 0 ? (
          <section>
            <Titulo>A caminho</Titulo>
            <ul className="mt-1.5 space-y-1">
              {pedidosAbertos.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs tabular-nums"
                >
                  <Truck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <a
                    href={`/pedidos-de-compra/${p.id}/impressao`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid"
                  >
                    Pedido #{p.numero}
                  </a>
                  <span>{p.fornecedorNome}</span>
                  <span className="text-muted-foreground">
                    {formatarQuantidade(p.quantidade)} {produto.unidade} a{" "}
                    {moeda(p.custoUnitario)}
                  </span>
                  <Badge variant="outline" className="text-[9px]">
                    {SITUACOES[p.situacao] ?? p.situacao}
                  </Badge>
                  <span className="ml-auto text-muted-foreground">
                    {p.entregaPrometida
                      ? `entrega ${data(p.entregaPrometida)}`
                      : `pedido em ${data(p.em)}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {compras.length > 0 ? (
          <section>
            <Titulo>O que já chegou</Titulo>
            <table className="mt-1.5 w-full text-xs tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1.5 pr-3 font-semibold">Data</th>
                  <th className="py-1.5 pr-3 font-semibold">Fornecedor</th>
                  <th className="py-1.5 pr-3 font-semibold">Documento</th>
                  <th className="py-1.5 pr-3 font-semibold">Loja</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Quantidade</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Custo</th>
                  <th className="py-1.5 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {compras.map((c) => {
                  const doc = c.documento ? DOCUMENTOS[c.documento.tipo] : null
                  return (
                    <tr key={c.id}>
                      <td className="py-1.5 pr-3 text-muted-foreground">{data(c.em)}</td>
                      <td className="py-1.5 pr-3">
                        {c.fornecedorNome ?? (
                          <span className="text-muted-foreground">entrada sem documento</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        {doc && c.documento ? (
                          // Aba nova: quem abriu isto veio de um catálogo com
                          // busca digitada, ou de um pedido meio montado que só
                          // existe na memória da tela — sair perderia os dois.
                          <a
                            href={doc.caminho(c.documento.id)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid"
                          >
                            <doc.Icone className="size-3" aria-hidden />
                            {doc.rotulo} {c.documento.numero}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Badge variant="outline" className="font-mono text-[9px]">
                          {c.loja}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {formatarQuantidade(c.quantidade)} {produto.unidade}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {c.custoUnitario == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              // O esperado do pedido não é o que a nota cobrou:
                              // fica em cinza para ninguém usá-lo como preço.
                              c.origemDoCusto === "pedido" && "text-muted-foreground"
                            )}
                            title={
                              c.origemDoCusto === "pedido"
                                ? "O custo esperado no pedido — esta entrada não passou por nota"
                                : "O custo real da entrada"
                            }
                          >
                            {moeda(c.custoUnitario)}
                            {c.origemDoCusto === "pedido" ? "*" : ""}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right text-muted-foreground">
                        {c.custoUnitario == null ? "—" : moeda(c.custoUnitario * c.quantidade)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>

      <DialogFooter className="sm:justify-between">
        <span className="text-xs text-muted-foreground">
          {compras.some((c) => c.origemDoCusto === "pedido")
            ? "* custo esperado do pedido, não o que a nota cobrou"
            : "Custo é o que a rede pagou, com imposto e frete rateados quando a entrada veio de nota"}
        </span>
        <DialogClose render={<Button type="button" variant="outline" />}>Fechar</DialogClose>
      </DialogFooter>
    </DialogContent>
  )
}

function Titulo({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  )
}

function data(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR")
}
