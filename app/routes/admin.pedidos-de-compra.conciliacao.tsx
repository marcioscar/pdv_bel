import { useEffect, useMemo, useState } from "react"
import { Link, useFetcher, useSearchParams } from "react-router"
import { GitCompare, Plus } from "lucide-react"

import type { Route } from "./+types/admin.pedidos-de-compra.conciliacao"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { ESTILO_CAMPO } from "~/components/pdv/filtros"
import { ReceberPedido } from "~/components/pdv/pedido-compra"
import {
  itensComCustoDaNota,
  notasCandidatasDoPedido,
  receberComNota,
  type ItemDaNotaParaConciliar,
  type ItemReconciliado,
  type ResultadoReceberComNota,
} from "~/lib/conciliacao.server"
import { db } from "~/lib/db.server"
import { listarLojas } from "~/lib/lojas.server"
import { interpretarValor, moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { recebidoPorProduto } from "~/lib/pedidos-compra.server"
import { criarProduto, lerProduto, SOMENTE_ATIVOS } from "~/lib/produtos.server"
import { exigirGerente } from "~/lib/sessao.server"
import type { PedidoItem } from "@prisma/client"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Conciliar pedido com NF-e — BrasSaco" }]
}

/**
 * O que foi pedido, ao lado do que a nota do fornecedor realmente cobrou —
 * quantidade, preço, e o custo de aquisição de verdade (com IPI, ICMS-ST e o
 * rateio de frete/outras despesas, do jeito que serve para o Simples
 * Nacional: sem crédito, tudo vira custo).
 *
 * A quantidade da nota nem sempre bate direto com a do catálogo — o mesmo
 * produto pode vir em caixa de 12, pacote de 6, ou fracionado, dependendo do
 * pedido. Por isso a quantidade de cada item é editável (o gerente corrige
 * para a unidade do catálogo) e vários itens da nota podem apontar para o
 * mesmo produto do pedido — a comparação soma tudo que for pareado ao mesmo
 * produto antes de calcular o custo unitário.
 *
 * Só compara — não dá entrada de estoque nem atualiza `Fornecimento` ainda.
 * O pareamento não é gravado: reabrir a tela refaz a escolha, porque não
 * existe ainda o vínculo cProd-do-fornecedor → produto nosso que tornaria
 * isso automático.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const { pedido, fornecedor, notas } = await notasCandidatasDoPedido(params.pedidoId)
  if (!pedido) throw new Response("Pedido não encontrado", { status: 404 })

  const url = new URL(request.url)
  const notaId = url.searchParams.get("nota") ?? ""
  const notaEscolhida = notaId ? (notas.find((n) => n.id === notaId) ?? null) : (notas[0] ?? null)

  const itensDaNota = notaEscolhida?.xml ? itensComCustoDaNota(notaEscolhida.xml) : []
  const [lojas, recebidoAntes, catalogo] = await Promise.all([
    listarLojas(),
    recebidoPorProduto(pedido.id),
    // O catálogo inteiro, e não só os itens do pedido: a nota pode trazer
    // produto que já existe mas não foi pedido, e daí o pareamento certo está
    // no catálogo — sem isso o gerente cadastraria um duplicado.
    db.produto.findMany({
      where: SOMENTE_ATIVOS,
      orderBy: { descricao: "asc" },
      select: { id: true, codigo: true, descricao: true, unidade: true },
    }),
  ])

  return {
    pedido,
    fornecedor,
    notas,
    notaEscolhida,
    itensDaNota,
    lojas: lojas.map((l) => l.codigo),
    recebidoAntes: Object.fromEntries(recebidoAntes),
    catalogo,
  }
}

type AcaoReceber = {
  intencao: "receber"
  pedidoId: string
  notaId: string
  loja: string
  itens: ItemReconciliado[]
}

type AcaoCadastrar = {
  intencao: "cadastrarProduto"
  /** Posição do item da nota que originou o cadastro — volta na resposta para
   * a tela saber qual linha pré-selecionar com o produto recém-criado. */
  linha: number
  codigo: string
  descricao: string
  unidade: string
  preco: string
  ncm: string
}

export type RespostaConciliacao =
  | ({ tipo: "receber" } & ResultadoReceberComNota)
  | { tipo: "cadastrarProduto"; ok: true; linha: number; produtoId: string }
  | { tipo: "cadastrarProduto"; ok: false; erro: string }

export async function action({ request }: Route.ActionArgs): Promise<RespostaConciliacao> {
  const eu = await exigirGerente(request, "verRelatorios")
  const corpo = (await request.json()) as AcaoReceber | AcaoCadastrar

  if (corpo.intencao === "cadastrarProduto") {
    // Passa por `lerProduto`, o mesmo do cadastro de produtos, para as regras
    // (código obrigatório, descrição mínima, preço válido) valerem iguais nos
    // dois caminhos — cadastro rápido não é cadastro relaxado.
    const form = new FormData()
    form.set("codigo", corpo.codigo)
    form.set("descricao", corpo.descricao)
    form.set("unidade", corpo.unidade)
    form.set("preco", corpo.preco || "0")
    form.set("ncm", corpo.ncm ?? "")

    const lido = lerProduto(form)
    if ("erro" in lido) return { tipo: "cadastrarProduto", ok: false, erro: lido.erro }

    const resultado = await criarProduto(lido)
    return resultado.ok
      ? { tipo: "cadastrarProduto", ok: true, linha: corpo.linha, produtoId: resultado.produto.id }
      : { tipo: "cadastrarProduto", ok: false, erro: resultado.erro }
  }

  const resultado = await receberComNota(corpo.pedidoId, corpo.notaId, corpo.loja, eu.nome, corpo.itens)
  return { tipo: "receber", ...resultado }
}

export default function ConciliacaoPedido({ loaderData }: Route.ComponentProps) {
  const { pedido, fornecedor, notas, notaEscolhida, itensDaNota, lojas, recebidoAntes, catalogo } =
    loaderData
  const podeReceber = pedido.situacao === "enviado" || pedido.situacao === "parcial"
  const [, setSearchParams] = useSearchParams()
  const fetcher = useFetcher<RespostaConciliacao>()
  const cadastroFetcher = useFetcher<RespostaConciliacao>()
  const recebendo = fetcher.state !== "idle"

  // produtoId do pedido escolhido para cada item da nota, por posição na lista.
  const [pareamento, setPareamento] = useState<Record<number, string>>(() =>
    // Mesma quantidade de itens dos dois lados é o caso comum — pareia por
    // ordem como ponto de partida, e o gerente corrige o que estiver errado.
    itensDaNota.length === pedido.itens.length
      ? Object.fromEntries(itensDaNota.map((_, i) => [i, pedido.itens[i].produtoId]))
      : {}
  )

  // A quantidade que a nota trouxe, mas na unidade do catálogo — texto livre
  // (vírgula como se digita), porque a conversão de embalagem é o gerente
  // quem sabe fazer, não uma fórmula.
  const [quantidades, setQuantidades] = useState<Record<number, string>>(() =>
    Object.fromEntries(itensDaNota.map((item, i) => [i, formatarQuantidade(item.quantidade)]))
  )

  const porProdutoId = useMemo(
    () => new Map(pedido.itens.map((item) => [item.produtoId, item])),
    [pedido.itens]
  )
  const catalogoPorId = useMemo(() => new Map(catalogo.map((p) => [p.id, p])), [catalogo])

  /** Qual item da nota está com o cadastro rápido aberto (índice), se algum. */
  const [cadastrando, setCadastrando] = useState<number | null>(null)

  // Produto recém-cadastrado já entra pareado na linha que o originou — foi
  // para ela que o gerente o criou; obrigá-lo a escolher de novo no select,
  // logo depois de digitar o cadastro, seria trabalho repetido.
  useEffect(() => {
    const resposta = cadastroFetcher.data
    if (resposta?.tipo !== "cadastrarProduto" || !resposta.ok) return
    setPareamento((atual) => ({ ...atual, [resposta.linha]: resposta.produtoId }))
    setCadastrando(null)
  }, [cadastroFetcher.data])

  // Cada item da nota, com a quantidade e o custo unitário já recalculados
  // pela edição do gerente — o custo TOTAL do item (o que a nota cobrou) não
  // muda; o que muda é por quantas unidades do catálogo ele se divide.
  const linhasEfetivas = useMemo(
    () =>
      itensDaNota.map((item, i) => {
        const valor = interpretarValor(quantidades[i] ?? "")
        const quantidade = valor != null && valor > 0 ? valor : item.quantidade
        return {
          ...item,
          produtoId: pareamento[i] ?? "",
          quantidadeEfetiva: quantidade,
          custoUnitarioEfetivo: quantidade > 0 ? item.custoTotalReal / quantidade : item.custoUnitarioReal,
        }
      }),
    [itensDaNota, quantidades, pareamento]
  )

  // Soma por produto do pedido: é assim que dois itens da nota (caixa de 12 e
  // pacote de 6 do mesmo produto, por exemplo) viram uma comparação só.
  const gruposPorProduto = useMemo(() => {
    const mapa = new Map<string, { quantidade: number; custoTotal: number }>()
    for (const linha of linhasEfetivas) {
      if (!linha.produtoId) continue
      const atual = mapa.get(linha.produtoId) ?? { quantidade: 0, custoTotal: 0 }
      atual.quantidade += linha.quantidadeEfetiva
      atual.custoTotal += linha.custoTotalReal
      mapa.set(linha.produtoId, atual)
    }
    return mapa
  }, [linhasEfetivas])

  /**
   * O que de fato entra no estoque, por produto — editável.
   *
   * Começa como o que a nota pareada somou, mas o que vale é o que chegou na
   * porta: o fornecedor fatura a caixa inteira e manda meia, ou vem quebrado, e
   * é a contagem física que manda no saldo. Vazio significa "usa o da nota"; o
   * custo unitário não muda com isso — ele vem da nota, e é ele que multiplica.
   */
  const [quantidadeRecebida, setQuantidadeRecebida] = useState<Record<string, string>>({})

  function quantidadeAReceber(produtoId: string) {
    const texto = quantidadeRecebida[produtoId]
    if (texto !== undefined && texto !== "") return interpretarValor(texto) ?? 0
    return gruposPorProduto.get(produtoId)?.quantidade ?? 0
  }

  function custoUnitarioDe(produtoId: string) {
    const grupo = gruposPorProduto.get(produtoId)
    if (grupo && grupo.quantidade > 0) return grupo.custoTotal / grupo.quantidade
    return porProdutoId.get(produtoId)?.custoUnitario ?? 0
  }

  /**
   * As linhas da comparação: todo item do pedido, mais o que a nota trouxe
   * fora dele.
   *
   * O extra entra no estoque igual (a mercadoria chegou), mas com quantidade
   * esperada zero — ele não conta para fechar o pedido, e por isso aparece
   * marcado, para o gerente ver que veio coisa que não foi pedida.
   */
  const linhasDaComparacao = useMemo(() => {
    const doPedido = pedido.itens.map((item) => ({
      produtoId: item.produtoId,
      codigo: item.codigo,
      descricao: item.descricao,
      unidade: item.unidade,
      quantidadeEsperada: item.quantidade,
      custoEsperado: item.custoUnitario,
      foraDoPedido: false,
    }))

    const idsDoPedido = new Set(pedido.itens.map((i) => i.produtoId))
    const extras = [...new Set(linhasEfetivas.map((l) => l.produtoId).filter(Boolean))]
      .filter((id) => !idsDoPedido.has(id))
      .map((id) => {
        const produto = catalogoPorId.get(id)
        return {
          produtoId: id,
          codigo: produto?.codigo ?? "",
          descricao: produto?.descricao ?? "(produto)",
          unidade: produto?.unidade ?? "",
          quantidadeEsperada: 0,
          custoEsperado: 0,
          foraDoPedido: true,
        }
      })

    return [...doPedido, ...extras]
  }, [pedido.itens, linhasEfetivas, catalogoPorId])

  // Nada a lançar: não faz sentido nem tentar — mas lançar só uma parte é o
  // caso normal de entrega parcial, não um erro a bloquear.
  const nadaPareado = linhasDaComparacao.every((l) => quantidadeAReceber(l.produtoId) <= 0)

  function receber(loja: string) {
    const itens: ItemReconciliado[] = linhasDaComparacao.map((linha) => ({
      produtoId: linha.produtoId,
      quantidade: quantidadeAReceber(linha.produtoId),
      custoUnitario: custoUnitarioDe(linha.produtoId),
    }))

    fetcher.submit(
      { intencao: "receber", pedidoId: pedido.id, notaId: notaEscolhida!.id, loja, itens },
      { method: "post", encType: "application/json" }
    )
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GitCompare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">
          Conciliar pedido #{pedido.numero} — {pedido.fornecedorNome}
        </h1>
      </div>

      {!fornecedor?.documento ? (
        <p className="mt-4 text-sm text-destructive">
          Este fornecedor não tem CNPJ/CPF cadastrado — sem documento não dá para achar a
          nota dele entre as sincronizadas.
        </p>
      ) : notas.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Nenhuma nota completa deste fornecedor foi sincronizada ainda. Sincronize a loja
          em <Link to="/admin/notas-de-entrada" className="underline">Notas de entrada</Link>{" "}
          e volte aqui.
        </p>
      ) : (
        <>
          <label className="mt-4 flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Nota do fornecedor</span>
            <select
              value={notaEscolhida?.id ?? ""}
              onChange={(e) => setSearchParams({ nota: e.target.value })}
              className={cn(ESTILO_CAMPO, "w-96")}
            >
              {notas.map((n) => (
                <option key={n.id} value={n.id}>
                  nº {n.numero}/{n.serie} — {n.dataEmissao ? new Date(n.dataEmissao).toLocaleDateString("pt-BR") : "—"}{" "}
                  — {n.valorTotal != null ? moeda(n.valorTotal) : "—"}
                </option>
              ))}
            </select>
          </label>

          {notaEscolhida ? (
            <>
              <div className="mt-4 overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                      <th className="px-2 py-1.5">Item da nota</th>
                      <th className="px-2 py-1.5">Produto no catálogo</th>
                      <th className="px-2 py-1.5 text-right">Qtd na nota</th>
                      <th className="px-2 py-1.5 text-right">Qtd no catálogo</th>
                      <th className="px-2 py-1.5 text-right">Custo unitário real</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itensDaNota.map((item, i) => (
                      <LinhaItemDaNota
                        key={i}
                        item={item}
                        pedidoItens={pedido.itens}
                        catalogo={catalogo}
                        produtoIdEscolhido={pareamento[i] ?? ""}
                        quantidadeTexto={quantidades[i] ?? ""}
                        custoUnitarioEfetivo={linhasEfetivas[i].custoUnitarioEfetivo}
                        cadastrando={cadastrando === i}
                        cadastroFetcher={cadastroFetcher}
                        onEscolherProduto={(produtoId) =>
                          setPareamento((atual) => ({ ...atual, [i]: produtoId }))
                        }
                        onMudarQuantidade={(texto) =>
                          setQuantidades((atual) => ({ ...atual, [i]: texto }))
                        }
                        onAbrirCadastro={() => setCadastrando(cadastrando === i ? null : i)}
                        onCadastrar={(dados) =>
                          cadastroFetcher.submit(
                            { intencao: "cadastrarProduto", linha: i, ...dados },
                            { method: "post", encType: "application/json" }
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 className="mt-6 text-sm font-medium">O que entra no estoque</h2>
              <div className="mt-2 overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                      <th className="px-2 py-1.5">Produto</th>
                      <th className="px-2 py-1.5 text-right">Qtd esperada</th>
                      <th className="px-2 py-1.5 text-right">Já recebido</th>
                      <th className="px-2 py-1.5 text-right">Recebendo agora</th>
                      <th className="px-2 py-1.5 text-right">Custo esperado</th>
                      <th className="px-2 py-1.5 text-right">Custo real</th>
                      <th className="px-2 py-1.5 text-right">Diferença</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhasDaComparacao.map((linha) => (
                      <LinhaResumoProduto
                        key={linha.produtoId}
                        linha={linha}
                        jaRecebido={recebidoAntes[linha.produtoId] ?? 0}
                        grupo={gruposPorProduto.get(linha.produtoId)}
                        quantidadeTexto={
                          quantidadeRecebida[linha.produtoId] ??
                          formatarQuantidade(gruposPorProduto.get(linha.produtoId)?.quantidade ?? 0)
                        }
                        custoUnitario={custoUnitarioDe(linha.produtoId)}
                        quantidade={quantidadeAReceber(linha.produtoId)}
                        onMudarQuantidade={(texto) =>
                          setQuantidadeRecebida((atual) => ({ ...atual, [linha.produtoId]: texto }))
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                Na tabela de cima, "Qtd no catálogo" converte a embalagem do fornecedor para a
                unidade do pedido (caixa, pacote, fracionado) — é o que define o custo unitário.
                Aqui embaixo, "Recebendo agora" é o que de fato entra no estoque: corrija para o
                que você contou na porta. O que faltar deixa o pedido parcial, e você concilia de
                novo quando o resto chegar.
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border p-3">
                {!podeReceber ? (
                  <span className="text-sm text-muted-foreground">
                    Este pedido já está <strong>{pedido.situacao}</strong> — não recebe de novo.
                  </span>
                ) : nadaPareado ? (
                  <span className="text-sm text-amber-600 dark:text-amber-500">
                    Pareie ao menos um item da nota para dar entrada — não precisa ser o pedido
                    inteiro, o que faltar fica pendente como entrega parcial.
                  </span>
                ) : (
                  <>
                    <span className="text-sm">
                      Dar entrada no estoque com o custo real do que estiver pareado:
                    </span>
                    <ReceberPedido lojas={lojas} gravando={recebendo} onReceber={receber} />
                  </>
                )}

                {fetcher.data?.tipo === "receber" && !fetcher.data.ok ? (
                  <span className="text-xs text-destructive">{fetcher.data.erro}</span>
                ) : null}
                {fetcher.data?.tipo === "receber" && fetcher.data.ok ? (
                  <span className="text-xs text-muted-foreground">
                    Entrada gravada —{" "}
                    {fetcher.data.situacao === "recebido"
                      ? "pedido totalmente recebido."
                      : "pedido fica parcial; concilie de novo quando o resto chegar."}
                  </span>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  )
}

type ProdutoDoCatalogo = { id: string; codigo: string; descricao: string; unidade: string }

function LinhaItemDaNota({
  item,
  pedidoItens,
  catalogo,
  produtoIdEscolhido,
  quantidadeTexto,
  custoUnitarioEfetivo,
  cadastrando,
  cadastroFetcher,
  onEscolherProduto,
  onMudarQuantidade,
  onAbrirCadastro,
  onCadastrar,
}: {
  item: ItemDaNotaParaConciliar
  pedidoItens: PedidoItem[]
  catalogo: ProdutoDoCatalogo[]
  produtoIdEscolhido: string
  quantidadeTexto: string
  custoUnitarioEfetivo: number
  cadastrando: boolean
  cadastroFetcher: ReturnType<typeof useFetcher<RespostaConciliacao>>
  onEscolherProduto: (produtoId: string) => void
  onMudarQuantidade: (texto: string) => void
  onAbrirCadastro: () => void
  onCadastrar: (dados: { codigo: string; descricao: string; unidade: string; preco: string; ncm: string }) => void
}) {
  const idsDoPedido = new Set(pedidoItens.map((p) => p.produtoId))
  const foraDoPedido = catalogo.filter((p) => !idsDoPedido.has(p.id))

  return (
    <tr className="border-b last:border-0">
      <td className="px-2 py-1.5 align-top">
        <div className="font-medium">{item.descricao}</div>
        <div className="text-muted-foreground">cód. fornecedor {item.codigo}</div>
      </td>
      <td className="px-2 py-1.5 align-top">
        <div className="flex items-center gap-1">
          <select
            value={produtoIdEscolhido}
            onChange={(e) => onEscolherProduto(e.target.value)}
            className={cn(
              "h-7 max-w-56 rounded border bg-background px-1.5 text-xs",
              produtoIdEscolhido ? "border-border" : "border-destructive/50 text-destructive"
            )}
          >
            <option value="">Escolher…</option>
            {/* Os do pedido primeiro: é o pareamento esperado na maioria das
                linhas, e caçá-lo no meio do catálogo inteiro seria trabalho. */}
            <optgroup label="Do pedido">
              {pedidoItens.map((p) => (
                <option key={p.produtoId} value={p.produtoId}>
                  {p.codigo} — {p.descricao}
                </option>
              ))}
            </optgroup>
            <optgroup label="Resto do catálogo">
              {foraDoPedido.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.codigo} — {p.descricao}
                </option>
              ))}
            </optgroup>
          </select>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onAbrirCadastro}
            title="Produto que ainda não existe no catálogo: cadastre agora, sem sair da conciliação"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>

        {cadastrando ? (
          <CadastroRapido
            item={item}
            fetcher={cadastroFetcher}
            onCadastrar={onCadastrar}
            onCancelar={onAbrirCadastro}
          />
        ) : null}
      </td>
      <td className="px-2 py-1.5 text-right align-top text-muted-foreground">
        {formatarQuantidade(item.quantidade)}
      </td>
      <td className="px-2 py-1.5 text-right align-top">
        <Input
          value={quantidadeTexto}
          onChange={(e) => onMudarQuantidade(e.target.value)}
          className="h-7 w-24 text-right font-mono text-xs"
        />
      </td>
      <td className="px-2 py-1.5 text-right align-top font-medium">{moeda(custoUnitarioEfetivo)}</td>
    </tr>
  )
}

/**
 * Cadastro de produto sem sair da conciliação.
 *
 * Vem pré-preenchido com o que a nota diz (descrição, unidade e o código do
 * fornecedor) porque é a melhor informação disponível na hora — mas tudo
 * editável: o código do fornecedor raramente é o código que a rede usa, e a
 * descrição do fabricante costuma vir em caixa alta e abreviada.
 *
 * O preço de venda nasce zerado de propósito. Ele depende do custo real desta
 * mesma nota mais as despesas da casa, que é conta para outro momento —
 * inventar um preço aqui seria pior que deixar explícito que falta definir.
 */
function CadastroRapido({
  item,
  fetcher,
  onCadastrar,
  onCancelar,
}: {
  item: ItemDaNotaParaConciliar
  fetcher: ReturnType<typeof useFetcher<RespostaConciliacao>>
  onCadastrar: (dados: { codigo: string; descricao: string; unidade: string; preco: string; ncm: string }) => void
  onCancelar: () => void
}) {
  const [codigo, setCodigo] = useState(item.codigo ?? "")
  const [descricao, setDescricao] = useState(item.descricao ?? "")
  const [unidade, setUnidade] = useState("")
  const [preco, setPreco] = useState("0")
  // O NCM vem da nota do fabricante — melhor fonte que existe para isto, e
  // sem ele a NF-e que a rede emitir depois seria rejeitada.
  const [ncm, setNcm] = useState(item.ncm ?? "")

  const resposta = fetcher.data
  const erro = resposta?.tipo === "cadastrarProduto" && !resposta.ok ? resposta.erro : null

  return (
    <div className="mt-2 w-72 space-y-1.5 rounded-lg border bg-muted/30 p-2">
      <div className="text-[11px] font-medium text-muted-foreground">Cadastrar no catálogo</div>
      <div className="flex gap-1.5">
        <Input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          placeholder="Código"
          className="h-7 w-24 text-xs"
        />
        <Input
          value={unidade}
          onChange={(e) => setUnidade(e.target.value)}
          placeholder="UN"
          className="h-7 w-16 text-xs"
        />
        <Input
          value={preco}
          onChange={(e) => setPreco(e.target.value)}
          placeholder="Preço"
          className="h-7 flex-1 text-right font-mono text-xs"
        />
      </div>
      <Input
        value={ncm}
        onChange={(e) => setNcm(e.target.value.replace(/\D/g, "").slice(0, 8))}
        placeholder="NCM (8 dígitos)"
        className="h-7 font-mono text-xs"
      />
      <Input
        value={descricao}
        onChange={(e) => setDescricao(e.target.value)}
        placeholder="Descrição"
        className="h-7 text-xs"
      />
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          disabled={fetcher.state !== "idle"}
          onClick={() => onCadastrar({ codigo, descricao, unidade, preco, ncm })}
        >
          Cadastrar
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
      {erro ? <p className="text-[11px] text-destructive">{erro}</p> : null}
      <p className="text-[11px] text-muted-foreground">
        O preço de venda pode ficar zerado agora e ser definido depois, com o custo real desta nota.
      </p>
    </div>
  )
}

type LinhaDaComparacao = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  quantidadeEsperada: number
  custoEsperado: number
  foraDoPedido: boolean
}

function LinhaResumoProduto({
  linha,
  jaRecebido,
  grupo,
  quantidadeTexto,
  quantidade,
  custoUnitario,
  onMudarQuantidade,
}: {
  linha: LinhaDaComparacao
  jaRecebido: number
  grupo: { quantidade: number; custoTotal: number } | undefined
  quantidadeTexto: string
  quantidade: number
  custoUnitario: number
  onMudarQuantidade: (texto: string) => void
}) {
  const custoEsperadoTotal = linha.quantidadeEsperada * linha.custoEsperado
  // Sem nada pedido não há o que comparar — o extra é mercadoria a mais, não
  // um desvio de preço.
  const comparavel = grupo && !linha.foraDoPedido
  const diferenca = comparavel ? custoUnitario - linha.custoEsperado : null
  const diferencaPct =
    diferenca != null && linha.custoEsperado > 0 ? (diferenca / linha.custoEsperado) * 100 : null
  const completoSemEsta = !linha.foraDoPedido && jaRecebido >= linha.quantidadeEsperada - 0.001
  // Depois desta entrada, ainda falta algo? É o que decide se o pedido fica
  // parcial — mostrado por linha para o gerente ver de onde vem a pendência.
  const faltaDepois = linha.quantidadeEsperada - jaRecebido - quantidade

  return (
    <tr className="border-b last:border-0">
      <td className="px-2 py-1.5">
        <div className="font-medium">{linha.descricao}</div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {linha.codigo}
          {linha.foraDoPedido ? (
            <Badge variant="secondary" className="text-[10px]">
              fora do pedido
            </Badge>
          ) : null}
        </div>
      </td>
      <td className="px-2 py-1.5 text-right">
        {linha.foraDoPedido ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${formatarQuantidade(linha.quantidadeEsperada)} ${linha.unidade}`
        )}
      </td>
      <td className="px-2 py-1.5 text-right">
        <span className={completoSemEsta ? "text-muted-foreground" : ""}>
          {formatarQuantidade(jaRecebido)} {linha.unidade}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <Input
            value={quantidadeTexto}
            onChange={(e) => onMudarQuantidade(e.target.value)}
            className="h-7 w-24 text-right font-mono text-xs"
          />
          <span className="text-muted-foreground">{linha.unidade}</span>
        </div>
        {faltaDepois > 0.001 ? (
          <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-500">
            faltam {formatarQuantidade(faltaDepois)}
          </div>
        ) : null}
      </td>
      <td className="px-2 py-1.5 text-right text-muted-foreground">
        {linha.foraDoPedido ? "—" : moeda(custoEsperadoTotal)}
      </td>
      <td className="px-2 py-1.5 text-right font-medium">
        {grupo ? moeda(custoUnitario * quantidade) : "—"}
      </td>
      <td className="px-2 py-1.5 text-right">
        {diferenca == null ? (
          <span className="text-muted-foreground">
            {linha.foraDoPedido ? "não pedido" : completoSemEsta ? "completo" : "sem nota pareada"}
          </span>
        ) : (
          <Badge variant={Math.abs(diferencaPct ?? 0) < 1 ? "outline" : diferenca > 0 ? "destructive" : "secondary"}>
            {diferenca > 0 ? "+" : ""}
            {moeda(diferenca)}/un ({diferencaPct?.toFixed(0)}%)
          </Badge>
        )}
      </td>
    </tr>
  )
}
