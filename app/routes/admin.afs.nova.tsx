import { useEffect, useMemo, useState } from "react"
import { Link, redirect, useFetcher, useSearchParams } from "react-router"
import { ArrowLeft, FileText, Plus, Search } from "lucide-react"

import type { Route } from "./+types/admin.afs.nova"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Campo, ESTILO_CAMPO } from "~/components/pdv/filtros"
import { EscolhaDeProduto, type ProdutoDoCatalogo } from "~/components/pdv/escolha-de-produto"
import { lancarAf, ultimoCustoDoFornecedor, type ItemDaAf } from "~/lib/afs.server"
import { db } from "~/lib/db.server"
import { diaDeHoje } from "~/lib/dia"
import { formatarCpfCnpj } from "~/lib/documento"
import { listarFornecedores } from "~/lib/fornecedores.server"
import { listarLojas } from "~/lib/lojas.server"
import { interpretarValor, moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { criarIndice } from "~/lib/pdv"
import { recebidoPorProduto } from "~/lib/pedidos-compra.server"
import { SOMENTE_ATIVOS } from "~/lib/produtos.server"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Lançar AF — BrasSaco" }]
}

/**
 * Digitar uma AF e dar entrada com ela.
 *
 * O fornecedor e o pedido vivem na URL, e não só no estado da tela, porque o
 * loader precisa deles: é ele que busca os pedidos em aberto daquele
 * fornecedor, o que já chegou de cada um e o último custo pago — trabalho de
 * servidor, que a tela não teria como fazer sozinha.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "lancarAf")

  const url = new URL(request.url)
  const fornecedorId = url.searchParams.get("fornecedor") ?? ""
  const pedidoId = url.searchParams.get("pedido") ?? ""

  const [fornecedores, lojas, catalogo] = await Promise.all([
    listarFornecedores(),
    listarLojas(),
    db.produto.findMany({
      where: SOMENTE_ATIVOS,
      orderBy: { descricao: "asc" },
      select: { id: true, codigo: true, descricao: true, unidade: true },
    }),
  ])

  // Só "enviado" e "parcial": rascunho ainda não foi pedido a ninguém, e
  // recebido já fechou — mesma régua da conciliação com nota.
  const pedidos = fornecedorId
    ? await db.pedidoDeCompra.findMany({
        where: { fornecedorId, situacao: { in: ["enviado", "parcial"] } },
        orderBy: { numero: "desc" },
      })
    : []

  // Um pedido só em aberto é o caso comum: já vem escolhido, para não obrigar a
  // confirmar o óbvio. Com vários, quem recebeu é que sabe qual é.
  const pedidoEscolhido = pedidoId
    ? (pedidos.find((p) => p.id === pedidoId) ?? null)
    : (pedidos.length === 1 ? pedidos[0] : null)

  const [ultimoCusto, recebidoAntes] = await Promise.all([
    fornecedorId ? ultimoCustoDoFornecedor(fornecedorId) : new Map<string, number>(),
    pedidoEscolhido ? recebidoPorProduto(pedidoEscolhido.id) : new Map<string, number>(),
  ])

  return {
    fornecedores: fornecedores.map((f) => ({
      id: f.id,
      nome: f.nomeFantasia || f.razaoSocial,
      documento: f.documento,
    })),
    fornecedorId,
    lojas: lojas.map((l) => ({ codigo: l.codigo, nome: l.nome })),
    catalogo,
    pedidos: pedidos.map((p) => ({ id: p.id, numero: p.numero, situacao: p.situacao })),
    pedidoEscolhido: pedidoEscolhido
      ? {
          id: pedidoEscolhido.id,
          numero: pedidoEscolhido.numero,
          itens: pedidoEscolhido.itens.map((item) => ({
            produtoId: item.produtoId,
            quantidade: item.quantidade,
            custoUnitario: item.custoUnitario,
            // O que ainda falta chegar deste item — é isso que preenche a
            // linha, não o pedido inteiro: numa segunda entrega, repetir o
            // total dobraria o que já entrou.
            falta: Math.max(
              0,
              item.quantidade - (recebidoAntes.get(item.produtoId) ?? 0)
            ),
          })),
        }
      : null,
    ultimoCusto: Object.fromEntries(ultimoCusto),
    hoje: diaDeHoje(),
  }
}

export type RespostaLancar = { intencao: "lancar"; ok: false; erro: string }

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "lancarAf")

  const form = await request.formData()
  let itens: ItemDaAf[] = []
  try {
    itens = JSON.parse(String(form.get("itens") ?? "[]"))
  } catch {
    itens = []
  }

  const resultado = await lancarAf(
    {
      numero: String(form.get("numero") ?? ""),
      loja: String(form.get("loja") ?? ""),
      fornecedorId: String(form.get("fornecedorId") ?? ""),
      pedidoDeCompraId: String(form.get("pedidoDeCompraId") ?? "") || null,
      dataEmissao: String(form.get("dataEmissao") ?? ""),
      observacao: String(form.get("observacao") ?? ""),
      itens,
    },
    eu.nome
  )

  // Lançada, o lugar de quem lançou é o detalhe dela — é lá que se confere o
  // que entrou e se gera a conta a pagar, que é o passo seguinte do trabalho.
  if (resultado.ok) throw redirect(`/admin/afs/${resultado.id}`)

  return { intencao: "lancar" as const, ok: false as const, erro: resultado.erro }
}

type LinhaAf = { produtoId: string; quantidadeTexto: string; custoTexto: string }

const LINHA_VAZIA: LinhaAf = { produtoId: "", quantidadeTexto: "", custoTexto: "" }

export default function NovaAf({ loaderData }: Route.ComponentProps) {
  const {
    fornecedores,
    fornecedorId,
    lojas,
    catalogo,
    pedidos,
    pedidoEscolhido,
    ultimoCusto,
    hoje,
  } = loaderData

  const fetcher = useFetcher<typeof action>()
  const lancando = fetcher.state !== "idle"
  const [params, setParams] = useSearchParams()

  const [numero, setNumero] = useState("")
  const [dataEmissao, setDataEmissao] = useState(hoje)
  const [loja, setLoja] = useState("")
  const [observacao, setObservacao] = useState("")
  const [linhas, setLinhas] = useState<LinhaAf[]>([LINHA_VAZIA])

  const catalogoPorId = useMemo(() => new Map(catalogo.map((p) => [p.id, p])), [catalogo])
  const indice = useMemo(() => criarIndice(catalogo), [catalogo])
  const fornecedor = fornecedores.find((f) => f.id === fornecedorId) ?? null

  /**
   * O pedido preenche a digitação: cada item vira uma linha com o que falta
   * chegar e o custo combinado. É o palpite mais próximo do papel na mão — e
   * tudo continua editável, porque o que a AF cobra é que manda.
   */
  useEffect(() => {
    if (!pedidoEscolhido) {
      setLinhas([LINHA_VAZIA])
      return
    }
    const doPedido = pedidoEscolhido.itens
      .filter((item) => item.falta > 0)
      .map((item) => ({
        produtoId: item.produtoId,
        quantidadeTexto: formatarQuantidade(item.falta),
        custoTexto: String(item.custoUnitario).replace(".", ","),
      }))
    setLinhas(doPedido.length > 0 ? doPedido : [LINHA_VAZIA])
  }, [pedidoEscolhido?.id])

  function mudarUrl(mudancas: Record<string, string>) {
    const proximos = new URLSearchParams(params)
    for (const [chave, valor] of Object.entries(mudancas)) {
      if (valor) proximos.set(chave, valor)
      else proximos.delete(chave)
    }
    setParams(proximos, { preventScrollReset: true })
  }

  function atualizar(i: number, campo: keyof LinhaAf, valor: string) {
    setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)))
  }

  /**
   * Escolher o produto traz junto o último custo pago a este fornecedor,
   * quando a linha ainda não tem custo digitado — o número que o gerente vai
   * comparar com o do papel. Nunca sobrescreve o que já foi digitado: o que
   * está na tela veio da AF, e a AF é que vale.
   */
  function escolherProduto(i: number, produtoId: string) {
    setLinhas((atual) =>
      atual.map((l, idx) => {
        if (idx !== i) return l
        const sugestao = ultimoCusto[produtoId]
        return {
          ...l,
          produtoId,
          custoTexto:
            l.custoTexto || (sugestao ? String(sugestao).replace(".", ",") : l.custoTexto),
        }
      })
    )
  }

  const linhasComTotal = linhas.map((l) => {
    const quantidade = interpretarValor(l.quantidadeTexto) ?? 0
    const custo = interpretarValor(l.custoTexto) ?? 0
    return { ...l, quantidade, custo, total: quantidade * custo }
  })
  const total = linhasComTotal.reduce((soma, l) => soma + l.total, 0)

  const preenchidas = linhasComTotal.filter((l) => l.produtoId && l.quantidade > 0)
  const faltaAlgo =
    !numero.trim() ||
    !loja ||
    !fornecedorId ||
    !dataEmissao ||
    preenchidas.length === 0 ||
    preenchidas.some((l) => !(l.custo > 0))

  function lancar() {
    const itens: ItemDaAf[] = preenchidas.map((l) => ({
      produtoId: l.produtoId,
      quantidade: l.quantidade,
      custoUnitario: l.custo,
    }))
    fetcher.submit(
      {
        numero,
        loja,
        fornecedorId,
        pedidoDeCompraId: pedidoEscolhido?.id ?? "",
        dataEmissao,
        observacao,
        itens: JSON.stringify(itens),
      },
      { method: "post" }
    )
  }

  return (
    <div className="p-4 sm:p-6">
      <Link
        to="/admin/afs"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        AFs de compra
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Lançar AF</h1>
        <span className="text-xs text-muted-foreground">
          A mercadoria entra no estoque com o custo digitado, como se fosse a nota
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border p-3">
        <Campo rotulo="Fornecedor">
          <EscolhaDeFornecedor
            fornecedores={fornecedores}
            escolhido={fornecedor}
            onEscolher={(id) => mudarUrl({ fornecedor: id, pedido: "" })}
          />
        </Campo>

        <Campo rotulo="Nº da AF">
          <Input
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
            placeholder="do papel"
            className="w-32 font-mono"
          />
        </Campo>

        <Campo rotulo="Data da AF">
          <input
            type="date"
            value={dataEmissao}
            onChange={(e) => setDataEmissao(e.target.value)}
            className={ESTILO_CAMPO}
          />
        </Campo>

        <Campo rotulo="Loja que recebeu">
          <select
            value={loja}
            onChange={(e) => setLoja(e.target.value)}
            className={cn(ESTILO_CAMPO, "w-40", loja ? "" : "border-destructive/50")}
          >
            <option value="">Escolher…</option>
            {lojas.map((l) => (
              <option key={l.codigo} value={l.codigo}>
                {l.nome}
              </option>
            ))}
          </select>
        </Campo>

        {fornecedorId ? (
          <Campo rotulo="Pedido de compra">
            <select
              value={pedidoEscolhido?.id ?? ""}
              onChange={(e) => mudarUrl({ pedido: e.target.value })}
              className={cn(ESTILO_CAMPO, "w-44")}
              disabled={pedidos.length === 0}
            >
              <option value="">{pedidos.length === 0 ? "Nenhum em aberto" : "Sem pedido"}</option>
              {pedidos.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.numero} ({p.situacao})
                </option>
              ))}
            </select>
          </Campo>
        ) : null}
      </div>

      {!fornecedorId ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Escolha o fornecedor para começar — é ele que traz os pedidos em aberto e o último
          custo pago de cada produto.
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                  <th className="px-2 py-1.5">Produto</th>
                  <th className="w-28 px-2 py-1.5 text-right">Quantidade</th>
                  <th className="w-28 px-2 py-1.5 text-right">Custo unit.</th>
                  <th className="w-28 px-2 py-1.5 text-right">Total</th>
                  <th className="w-8 px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {linhasComTotal.map((linha, i) => {
                  const produto = catalogoPorId.get(linha.produtoId) ?? null
                  return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <EscolhaDeProduto
                            escolhido={produto}
                            destacados={pedidoEscolhido?.itens.map((i) => i.produtoId) ?? []}
                            indice={indice}
                            onEscolher={(produtoId) => escolherProduto(i, produtoId)}
                          />
                          {produto ? (
                            <span className="text-muted-foreground">{produto.unidade}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={linha.quantidadeTexto}
                          onChange={(e) => atualizar(i, "quantidadeTexto", e.target.value)}
                          className="h-7 w-full text-right font-mono text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={linha.custoTexto}
                          onChange={(e) => atualizar(i, "custoTexto", e.target.value)}
                          className={cn(
                            "h-7 w-full text-right font-mono text-xs",
                            linha.produtoId && linha.quantidade > 0 && !(linha.custo > 0)
                              ? "border-destructive/50"
                              : ""
                          )}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {linha.total > 0 ? moeda(linha.total) : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setLinhas((atual) =>
                              atual.length === 1
                                ? [LINHA_VAZIA]
                                : atual.filter((_, idx) => idx !== i)
                            )
                          }
                        >
                          ×
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setLinhas((atual) => [...atual, LINHA_VAZIA])}
            >
              <Plus className="size-3.5" />
              Acrescentar item
            </Button>

            {pedidoEscolhido ? (
              <Badge variant="secondary">
                preenchido pelo pedido #{pedidoEscolhido.numero} — o que ainda faltava chegar
              </Badge>
            ) : null}

            <span className="ml-auto text-sm">
              Total da AF: <strong className="tabular-nums">{moeda(total)}</strong>
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Campo rotulo="Observação">
              <Input
                value={observacao}
                onChange={(e) => setObservacao(e.target.value)}
                placeholder="o que o papel diz e os campos não cobrem"
                className="w-96"
              />
            </Campo>

            <Button
              type="button"
              className="ml-auto"
              disabled={lancando || faltaAlgo}
              onClick={lancar}
              title={
                faltaAlgo
                  ? "Faltam fornecedor, número, data, loja ou um item com quantidade e custo"
                  : undefined
              }
            >
              {lancando ? "Lançando…" : "Lançar entrada"}
            </Button>
          </div>

          {fetcher.data && !fetcher.data.ok ? (
            <p className="mt-2 text-sm text-destructive">{fetcher.data.erro}</p>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * Escolhe o fornecedor digitando — mesmo padrão da busca de fornecedor na tela
 * de notas de entrada, e pela mesma razão: são mais de cem cadastros com nomes
 * parecidos, e achar o certo numa lista rolante é pior que digitar três letras.
 * Procura por nome e por CNPJ no mesmo campo, porque quem procura tem um ou
 * outro na mão.
 */
function EscolhaDeFornecedor({
  fornecedores,
  escolhido,
  onEscolher,
}: {
  fornecedores: { id: string; nome: string; documento: string | null }[]
  escolhido: { id: string; nome: string } | null
  onEscolher: (fornecedorId: string) => void
}) {
  const [termo, setTermo] = useState("")
  const [aberto, setAberto] = useState(false)

  const achados = useMemo(() => {
    const busca = termo.trim().toLowerCase()
    if (!busca) return fornecedores.slice(0, 12)
    const digitos = busca.replace(/\D/g, "")
    return fornecedores
      .filter(
        (f) =>
          f.nome.toLowerCase().includes(busca) ||
          (digitos.length >= 3 && (f.documento ?? "").includes(digitos))
      )
      .slice(0, 12)
  }, [fornecedores, termo])

  return (
    <div className="relative w-72">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={aberto ? termo : (escolhido?.nome ?? "")}
        onChange={(e) => {
          setTermo(e.target.value)
          setAberto(true)
        }}
        onFocus={() => {
          setTermo("")
          setAberto(true)
        }}
        // `onBlur` com atraso: o clique num item da lista dispara o blur antes
        // do próprio clique, e fechar na hora engoliria a escolha.
        onBlur={() => setTimeout(() => setAberto(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setAberto(false)
        }}
        placeholder="Escolher — nome ou CNPJ"
        type="search"
        autoComplete="off"
        className={cn("pl-8", escolhido ? "" : "border-destructive/50")}
      />

      {aberto ? (
        <ul className="absolute z-30 mt-1 max-h-72 w-full divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
          {achados.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => {
                  onEscolher(f.id)
                  setAberto(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 truncate">{f.nome}</span>
                {f.documento ? (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {formatarCpfCnpj(f.documento)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          {achados.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              Nenhum fornecedor com esse termo.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
