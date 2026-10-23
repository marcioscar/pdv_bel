import { useEffect, useMemo, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { CircleCheck, PackageCheck, Plus } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { ESTILO_CAMPO } from "~/components/pdv/filtros"
import {
  EscolhaDeProduto,
  type ProdutoDoCatalogo,
} from "~/components/pdv/escolha-de-produto"
import type { ItemDaNotaParaConciliar, ItemReconciliado } from "~/lib/conciliacao.server"
import { interpretarValor, moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { conferirPrecoVenda } from "~/lib/precificacao"
import {
  centavos,
  markupPorPreco,
  precoPorMarkup,
  propostaDeMarkup,
  textoDeMarkup,
  textoDePreco,
} from "~/lib/markup"
import type { PercentuaisDaOperacao } from "~/lib/precificacao.server"
import { buscarProdutos, criarIndice, type EntradaIndice } from "~/lib/pdv"
import { cn } from "~/lib/utils"

/**
 * Dar entrada da mercadoria a partir da nota: parear item da NF-e com produto
 * do catálogo, conferir o que chegou de verdade, e lançar no estoque com o
 * custo real da nota.
 *
 * Mora aqui, junto da nota, e não numa tela de conciliação à parte, porque é um
 * trabalho só: a nota chega com a mercadoria, se confere contra o pedido, dá
 * entrada e gera o que se vai pagar. Eram duas telas em direções opostas (uma
 * partindo do pedido, outra da nota) para um evento único.
 */

export type ItemDoPedido = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  quantidade: number
  custoUnitario: number
}

export type PedidoCandidato = {
  id: string
  numero: number
  situacao: string
  itens: ItemDoPedido[]
}

/** O que a action da rota devolve para este bloco — a rota reexporta no seu union. */
export type RespostaEntrada =
  | { intencao: "receber"; ok: true; situacao: "recebido" | "parcial" | "sem-pedido" }
  | { intencao: "receber"; ok: false; erro: string }
  | { intencao: "cadastrarProduto"; ok: true; linha: number; produtoId: string }
  | { intencao: "cadastrarProduto"; ok: false; erro: string }
  | { intencao: "atualizarPrecos"; ok: true; alterados: number }
  | { intencao: "atualizarPrecos"; ok: false; erro: string }

export type { ProdutoDoCatalogo }

export function EntradaDeNota({
  notaId,
  itensDaNota,
  pedidos,
  pedidoEscolhido,
  onEscolherPedido,
  catalogo,
  percentuais,
  lojas,
  recebidoAntes,
  lojaPadrao,
  jaLancados,
  recebidoEm,
  recebidoPor,
}: {
  notaId: string
  itensDaNota: ItemDaNotaParaConciliar[]
  pedidos: PedidoCandidato[]
  pedidoEscolhido: PedidoCandidato | null
  onEscolherPedido: (pedidoId: string) => void
  catalogo: ProdutoDoCatalogo[]
  /** Null quando a nota não tem itens — sem custo não há o que precificar. */
  percentuais: PercentuaisDaOperacao | null
  lojas: string[]
  recebidoAntes: Record<string, number>
  /** A loja destinatária da nota — quase sempre é ela que recebeu. */
  lojaPadrao: string
  /** O que esta nota já lançou no estoque, por movimento. Vazio antes da primeira entrada. */
  jaLancados: { produtoId: string; loja: string; quantidade: number }[]
  recebidoEm: string | null
  recebidoPor: string | null
}) {
  const fetcher = useFetcher<RespostaEntrada>()
  const [loja, setLoja] = useState(lojas.includes(lojaPadrao) ? lojaPadrao : "")
  const cadastroFetcher = useFetcher<RespostaEntrada>()
  const recebendo = fetcher.state !== "idle"

  const itensDoPedido = pedidoEscolhido?.itens ?? []

  // produtoId escolhido para cada item da nota, por posição na lista.
  const [pareamento, setPareamento] = useState<Record<number, string>>({})

  // Mesma quantidade de itens dos dois lados é o caso comum — pareia por ordem
  // como ponto de partida, e o gerente corrige o que estiver errado. Refeito
  // quando o pedido muda, porque o palpite anterior era sobre outro pedido.
  useEffect(() => {
    if (itensDoPedido.length > 0 && itensDoPedido.length === itensDaNota.length) {
      setPareamento(Object.fromEntries(itensDaNota.map((_, i) => [i, itensDoPedido[i].produtoId])))
    } else {
      setPareamento({})
    }
    setQuantidadeRecebida({})
  }, [pedidoEscolhido?.id, itensDaNota.length])

  // A quantidade que a nota trouxe, mas na unidade do catálogo — texto livre
  // (vírgula como se digita), porque a conversão de embalagem é o gerente quem
  // sabe fazer, não uma fórmula.
  const [quantidades, setQuantidades] = useState<Record<number, string>>(() =>
    Object.fromEntries(itensDaNota.map((item, i) => [i, formatarQuantidade(item.quantidade)]))
  )

  const precoFetcher = useFetcher<RespostaEntrada>()
  /*
   * O preço de venda novo de cada produto, por markup sobre o CUSTO REAL desta
   * nota: preço = custo × (1 + markup). Os dois campos andam juntos — mexer no
   * markup recalcula o preço, digitar o preço recalcula o markup. Vazio no
   * estado é "ainda não mexi": vale a proposta inicial (ver `propostaDe`).
   */
  const [precos, setPrecos] = useState<Record<string, { markup: string; preco: string }>>({})
  /** Produtos que o gerente desmarcou: o preço deles fica como está. */
  const [manterPreco, setManterPreco] = useState<Set<string>>(new Set())
  const [markupTodosTexto, setMarkupTodosTexto] = useState("")

  const catalogoPorId = useMemo(() => new Map(catalogo.map((p) => [p.id, p])), [catalogo])
  /*
   * Índice montado uma vez para a tabela toda, não por linha: são mais de mil
   * produtos, e refazê-lo em cada uma das dezenas de linhas da nota seria mil
   * normalizações vezes o número de itens a cada tecla digitada.
   */
  const indiceDoCatalogo = useMemo(() => criarIndice(catalogo), [catalogo])
  const porProdutoId = useMemo(
    () => new Map(itensDoPedido.map((item) => [item.produtoId, item])),
    [itensDoPedido]
  )
  /** Os produtos que o pedido esperava — o palpite de pareamento de cada linha. */
  const idsDoPedido = useMemo(() => itensDoPedido.map((i) => i.produtoId), [itensDoPedido])

  /** Qual item da nota está com o cadastro rápido aberto (índice), se algum. */
  const [cadastrando, setCadastrando] = useState<number | null>(null)

  // Produto recém-cadastrado já entra pareado na linha que o originou — foi
  // para ela que o gerente o criou; obrigá-lo a escolher de novo no select,
  // logo depois de digitar o cadastro, seria trabalho repetido.
  useEffect(() => {
    const resposta = cadastroFetcher.data
    if (resposta?.intencao !== "cadastrarProduto" || !resposta.ok) return
    setPareamento((atual) => ({ ...atual, [resposta.linha]: resposta.produtoId }))
    setCadastrando(null)
  }, [cadastroFetcher.data])

  // Cada item da nota, com a quantidade e o custo unitário já recalculados pela
  // edição do gerente — o custo TOTAL do item (o que a nota cobrou) não muda; o
  // que muda é por quantas unidades do catálogo ele se divide.
  const linhasEfetivas = useMemo(
    () =>
      itensDaNota.map((item, i) => {
        const valor = interpretarValor(quantidades[i] ?? "")
        const quantidade = valor != null && valor > 0 ? valor : item.quantidade
        return {
          ...item,
          produtoId: pareamento[i] ?? "",
          quantidadeEfetiva: quantidade,
          custoUnitarioEfetivo:
            quantidade > 0 ? item.custoTotalReal / quantidade : item.custoUnitarioReal,
        }
      }),
    [itensDaNota, quantidades, pareamento]
  )

  // Soma por produto: é assim que dois itens da nota (caixa de 12 e pacote de 6
  // do mesmo produto, por exemplo) viram uma comparação só.
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
   * As linhas do que entra: todo item do pedido, mais o que a nota trouxe fora
   * dele.
   *
   * O extra entra no estoque igual (a mercadoria chegou), mas com quantidade
   * esperada zero — ele não conta para fechar o pedido, e por isso aparece
   * marcado, para o gerente ver que veio coisa que não foi pedida.
   */
  const linhasDaComparacao = useMemo(() => {
    const doPedido = itensDoPedido.map((item) => ({
      produtoId: item.produtoId,
      codigo: item.codigo,
      descricao: item.descricao,
      unidade: item.unidade,
      quantidadeEsperada: item.quantidade,
      custoEsperado: item.custoUnitario,
      foraDoPedido: false,
    }))

    const doPedidoIds = new Set(idsDoPedido)
    const extras = [...new Set(linhasEfetivas.map((l) => l.produtoId).filter(Boolean))]
      .filter((id) => !doPedidoIds.has(id))
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
  }, [itensDoPedido, idsDoPedido, linhasEfetivas, catalogoPorId])

  /*
   * O que esta nota já pôs no estoque, por produto. A entrada pode ser feita em
   * partes — um item hoje, o resto quando se acha o produto certo —, e o
   * servidor já pula o que foi lançado; aqui a tela mostra isso e não manda de novo.
   */
  const lancadosPorProduto = useMemo(() => {
    const mapa = new Map<string, { quantidade: number; lojas: string[] }>()
    for (const m of jaLancados) {
      const atual = mapa.get(m.produtoId) ?? { quantidade: 0, lojas: [] }
      atual.quantidade += m.quantidade
      if (!atual.lojas.includes(m.loja)) atual.lojas.push(m.loja)
      mapa.set(m.produtoId, atual)
    }
    return mapa
  }, [jaLancados])

  const pendentes = linhasDaComparacao.filter((l) => !lancadosPorProduto.has(l.produtoId))
  const aLancar = pendentes.filter((l) => quantidadeAReceber(l.produtoId) > 0)
  const nadaPareado = aLancar.length === 0

  const linhasPareadas = itensDaNota.filter((_, i) => pareamento[i]).length
  const linhasJaLancadas = itensDaNota.filter((_, i) => lancadosPorProduto.has(pareamento[i] ?? "")).length
  // Sem saber qual linha virou qual produto (o movimento guarda o produto, não a
  // linha da nota), "tudo lançado" é ter tantos produtos lançados quanto linhas.
  const tudoLancado = lancadosPorProduto.size > 0 && lancadosPorProduto.size >= itensDaNota.length

  /** O ponto de partida de cada linha: manter o markup que o produto tinha. */
  function propostaDe(produtoId: string): { markup: string; preco: string } {
    const produto = catalogoPorId.get(produtoId)
    return propostaDeMarkup({
      custo: custoUnitarioDe(produtoId),
      precoHoje: produto?.preco,
      custoAnterior: produto?.custoAnterior,
    })
  }

  function precoDaLinha(produtoId: string) {
    return precos[produtoId] ?? propostaDe(produtoId)
  }

  function mudarMarkup(produtoId: string, texto: string) {
    const custo = custoUnitarioDe(produtoId)
    const markup = interpretarValor(texto)
    setPrecos((atual) => ({
      ...atual,
      [produtoId]: {
        markup: texto,
        preco: markup != null && custo > 0 ? textoDePreco(precoPorMarkup(custo, markup)) : "",
      },
    }))
  }

  function mudarPreco(produtoId: string, texto: string) {
    const custo = custoUnitarioDe(produtoId)
    const preco = interpretarValor(texto)
    setPrecos((atual) => ({
      ...atual,
      [produtoId]: {
        preco: texto,
        markup:
          preco != null && preco > 0 && custo > 0 ? textoDeMarkup(markupPorPreco(custo, preco)) : "",
      },
    }))
  }

  function aplicarMarkupATodos() {
    if (interpretarValor(markupTodosTexto) == null) return
    for (const linha of linhasDaComparacao) {
      if (custoUnitarioDe(linha.produtoId) > 0) mudarMarkup(linha.produtoId, markupTodosTexto)
    }
  }

  /** O que vai mudar de fato: preço válido, diferente do de hoje, e não desmarcado. */
  const precosAAtualizar = linhasDaComparacao.flatMap((linha) => {
    if (manterPreco.has(linha.produtoId)) return []
    const novo = interpretarValor(precoDaLinha(linha.produtoId).preco)
    const hoje = catalogoPorId.get(linha.produtoId)?.preco ?? 0
    if (novo == null || !(novo > 0) || centavos(novo) === centavos(hoje)) return []
    return [{ produtoId: linha.produtoId, preco: centavos(novo) }]
  })

  function atualizarPrecos() {
    precoFetcher.submit(
      { intencao: "atualizarPrecos", itens: JSON.stringify(precosAAtualizar) },
      { method: "post" }
    )
  }

  function receber() {
    const itens: ItemReconciliado[] = aLancar.map((linha) => ({
      produtoId: linha.produtoId,
      quantidade: quantidadeAReceber(linha.produtoId),
      custoUnitario: custoUnitarioDe(linha.produtoId),
    }))

    fetcher.submit(
      {
        intencao: "receber",
        notaId,
        pedidoId: pedidoEscolhido?.id ?? "",
        loja,
        itens: JSON.stringify(itens),
      },
      { method: "post" }
    )
  }

  const recebimento =
    jaLancados.length > 0 ? (
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border p-3 text-sm",
          tudoLancado
            ? "border-emerald-600/30 bg-emerald-600/5"
            : "border-amber-500/40 bg-amber-500/5"
        )}
      >
        <CircleCheck
          className={cn(
            "mt-0.5 size-4 shrink-0",
            tudoLancado ? "text-emerald-600" : "text-amber-600 dark:text-amber-500"
          )}
          aria-hidden
        />
        <div>
          <p className="font-medium">
            {tudoLancado
              ? "Todos os itens desta nota já entraram no estoque"
              : `Entrada parcial: ${lancadosPorProduto.size} de ${itensDaNota.length} ${itensDaNota.length === 1 ? "item lançado" : "itens lançados"}`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {recebidoEm ? `Última entrada em ${new Date(recebidoEm).toLocaleString("pt-BR")}` : ""}
            {recebidoPor ? ` por ${recebidoPor}` : ""}.
            {tudoLancado
              ? ""
              : " Ligue os itens que faltam a um produto do catálogo e dê entrada — o que já entrou não é lançado de novo."}
          </p>
        </div>
      </div>
    ) : null

  if (tudoLancado) return recebimento

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Entrada no estoque</h3>
          <p className="text-xs text-muted-foreground">
            Três passos: ligar os itens da nota aos produtos, conferir o que entra e dar entrada.
          </p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Pedido de compra</span>
          <select
            value={pedidoEscolhido?.id ?? ""}
            onChange={(e) => onEscolherPedido(e.target.value)}
            className={cn(ESTILO_CAMPO, "w-64")}
          >
            <option value="">Sem pedido</option>
            {pedidos.map((p) => (
              <option key={p.id} value={p.id}>
                #{p.numero} — {p.situacao}
              </option>
            ))}
          </select>
        </label>
      </div>

      {recebimento}

      <section>
        <TituloDoPasso numero={1} titulo="Ligue cada item da nota a um produto do catálogo">
          Clique em <strong className="font-medium text-foreground">Procurar produto</strong> e
          digite o código ou parte do nome. Se o produto ainda não existe, use{" "}
          <strong className="font-medium text-foreground">Cadastrar novo</strong>. Não precisa
          ligar tudo agora: o que ficar sem produto pode ser lançado depois.
          {pedidos.length === 0
            ? " Não há pedido em aberto deste fornecedor — a mercadoria entra pelo custo da nota."
            : ""}
        </TituloDoPasso>

        <div className="mt-2 flex items-center gap-2 text-sm">
          <Badge variant={linhasPareadas === itensDaNota.length ? "outline" : "secondary"}>
            {linhasPareadas} de {itensDaNota.length} ligados
          </Badge>
          {linhasJaLancadas > 0 ? (
            <span className="text-xs text-muted-foreground">
              {linhasJaLancadas} já {linhasJaLancadas === 1 ? "lançado" : "lançados"} no estoque
            </span>
          ) : null}
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Item da nota</th>
                <th className="px-3 py-2">Produto no catálogo</th>
                <th className="px-3 py-2 text-right">Qtd na nota</th>
                <th
                  className="px-3 py-2 text-right"
                  title="A quantidade da nota convertida para a unidade do catálogo (caixa, pacote, unidade)"
                >
                  Qtd na unidade do catálogo
                </th>
                <th className="px-3 py-2 text-right">Custo unitário real</th>
              </tr>
            </thead>
            <tbody>
              {itensDaNota.map((item, i) => (
                <LinhaItemDaNota
                  key={i}
                  item={item}
                  destacados={idsDoPedido}
                  indice={indiceDoCatalogo}
                  catalogoPorId={catalogoPorId}
                  produtoIdEscolhido={pareamento[i] ?? ""}
                  jaLancado={lancadosPorProduto.get(pareamento[i] ?? "") ?? null}
                  quantidadeTexto={quantidades[i] ?? ""}
                  custoUnitarioEfetivo={linhasEfetivas[i].custoUnitarioEfetivo}
                  cadastrando={cadastrando === i}
                  cadastroFetcher={cadastroFetcher}
                  onEscolherProduto={(produtoId) =>
                    setPareamento((atual) => ({ ...atual, [i]: produtoId }))
                  }
                  onMudarQuantidade={(texto) =>
                    setQuantidades((atual) => ({ ...atual, [i]: texto.replace(/\D/g, "") }))
                  }
                  onAbrirCadastro={() => setCadastrando(cadastrando === i ? null : i)}
                  onCadastrar={(dados) =>
                    cadastroFetcher.submit(
                      { intencao: "cadastrarProduto", linha: i, ...dados },
                      { method: "post" }
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <TituloDoPasso numero={2} titulo="Confira o que entra e, se quiser, os preços de venda">
            "Recebendo agora" é o que entra no estoque: corrija para o que você contou na porta.
            {pedidoEscolhido
              ? " O que faltar deixa o pedido parcial, e você lança de novo quando o resto chegar."
              : ""}{" "}
            Os preços de venda são opcionais e têm botão próprio — não dão entrada no estoque.
          </TituloDoPasso>

          {/*
            O markup para todas as linhas de uma vez — o atalho de quem trabalha
            com um percentual só. Cada linha continua editável depois.
          */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Markup para todos</span>
              <Input
                value={markupTodosTexto}
                onChange={(e) => setMarkupTodosTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    aplicarMarkupATodos()
                  }
                }}
                inputMode="decimal"
                placeholder="ex. 40"
                className="h-9 w-20 text-right font-mono text-sm"
              />
              <span className="text-muted-foreground">%</span>
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={interpretarValor(markupTodosTexto) == null}
              onClick={aplicarMarkupATodos}
              className="rounded-lg"
            >
              Aplicar a todos
            </Button>
          </div>
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Produto</th>
                {/* Sem pedido não há o que comparar: as colunas do pedido seriam só traços. */}
                {pedidoEscolhido ? (
                  <>
                    <th className="px-3 py-2 text-right">Qtd esperada</th>
                    <th className="px-3 py-2 text-right">Já recebido do pedido</th>
                  </>
                ) : null}
                <th className="px-3 py-2 text-right">Recebendo agora</th>
                {pedidoEscolhido ? <th className="px-3 py-2 text-right">Custo esperado</th> : null}
                <th className="px-3 py-2 text-right">Custo real</th>
                {pedidoEscolhido ? <th className="px-3 py-2 text-right">Diferença</th> : null}
                <th className="px-3 py-2 text-right">Preço hoje</th>
                <th className="px-3 py-2 text-right">Markup</th>
                <th className="px-3 py-2 text-right">Novo preço</th>
              </tr>
            </thead>
            <tbody>
              {linhasDaComparacao.length === 0 ? (
                <tr>
                  <td colSpan={pedidoEscolhido ? 10 : 6} className="px-3 py-6 text-center text-muted-foreground">
                    Ligue os itens da nota no passo 1 para ver o que vai entrar.
                  </td>
                </tr>
              ) : (
                linhasDaComparacao.map((linha) => (
                  <LinhaResumoProduto
                    key={linha.produtoId}
                    linha={linha}
                    temPedido={pedidoEscolhido != null}
                    jaRecebido={recebidoAntes[linha.produtoId] ?? 0}
                    jaLancadoPelaNota={lancadosPorProduto.get(linha.produtoId) ?? null}
                    grupo={gruposPorProduto.get(linha.produtoId)}
                    quantidadeTexto={
                      quantidadeRecebida[linha.produtoId] ??
                      formatarQuantidade(gruposPorProduto.get(linha.produtoId)?.quantidade ?? 0)
                    }
                    custoUnitario={custoUnitarioDe(linha.produtoId)}
                    percentuais={percentuais}
                    precoAtual={catalogoPorId.get(linha.produtoId)?.preco ?? null}
                    markupTexto={precoDaLinha(linha.produtoId).markup}
                    precoTexto={precoDaLinha(linha.produtoId).preco}
                    manter={manterPreco.has(linha.produtoId)}
                    onMudarMarkup={(texto) => mudarMarkup(linha.produtoId, texto)}
                    onMudarPreco={(texto) => mudarPreco(linha.produtoId, texto)}
                    onManter={(manter) =>
                      setManterPreco((atual) => {
                        const novo = new Set(atual)
                        if (manter) novo.add(linha.produtoId)
                        else novo.delete(linha.produtoId)
                        return novo
                      })
                    }
                    quantidade={quantidadeAReceber(linha.produtoId)}
                    onMudarQuantidade={(texto) =>
                      setQuantidadeRecebida((atual) => ({ ...atual, [linha.produtoId]: texto }))
                    }
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={precosAAtualizar.length === 0 || precoFetcher.state !== "idle"}
            onClick={atualizarPrecos}
            className="rounded-lg"
          >
            {precoFetcher.state !== "idle"
              ? "Salvando preços…"
              : precosAAtualizar.length === 0
                ? "Nenhum preço de venda a mudar"
                : `Salvar ${precosAAtualizar.length} ${precosAAtualizar.length === 1 ? "novo preço" : "novos preços"} de venda no catálogo`}
          </Button>
          {precoFetcher.data?.intencao === "atualizarPrecos" ? (
            precoFetcher.data.ok ? (
              <span className="text-sm text-emerald-700 dark:text-emerald-500">
                {precoFetcher.data.alterados}{" "}
                {precoFetcher.data.alterados === 1 ? "preço atualizado" : "preços atualizados"} no catálogo
              </span>
            ) : (
              <span className="text-sm text-destructive">{precoFetcher.data.erro}</span>
            )
          ) : null}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Novo preço = custo real × (1 + markup). Começa no markup que o produto já tinha, para a
          margem se manter com o custo novo. Desmarque a caixinha ao lado do preço para não mexer
          nele.
        </p>
      </section>

      <section className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4">
        <TituloDoPasso numero={3} titulo="Dê entrada no estoque">
          Grava a quantidade de "Recebendo agora" no estoque da loja escolhida, com o custo real
          desta nota. Aparece na ficha do produto na hora.
        </TituloDoPasso>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Loja que recebeu a mercadoria</span>
            <select
              value={loja}
              onChange={(e) => setLoja(e.target.value)}
              className={cn(ESTILO_CAMPO, "w-40", !loja && "border-destructive/50")}
            >
              <option value="">Escolha a loja…</option>
              {lojas.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="lg"
            disabled={recebendo || nadaPareado || !loja}
            onClick={receber}
            className="rounded-lg"
          >
            <PackageCheck className="size-5" />
            {recebendo
              ? "Gravando entrada…"
              : nadaPareado
                ? "Nada para lançar ainda"
                : `Dar entrada de ${aLancar.length} ${aLancar.length === 1 ? "produto" : "produtos"}${loja ? ` na ${loja}` : ""}`}
          </Button>
        </div>

        {nadaPareado ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">
            {linhasJaLancadas > 0 && linhasPareadas === linhasJaLancadas
              ? "Os itens ligados já foram lançados. Ligue os que faltam no passo 1."
              : "Ligue ao menos um item da nota a um produto no passo 1 — não precisa ser tudo."}
          </p>
        ) : !loja ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">
            Escolha a loja que recebeu a mercadoria.
          </p>
        ) : null}

        {fetcher.data?.intencao === "receber" && !fetcher.data.ok ? (
          <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive">
            Não gravou: {fetcher.data.erro}
          </p>
        ) : null}
        {fetcher.data?.intencao === "receber" && fetcher.data.ok ? (
          <p className="mt-3 rounded-lg border border-emerald-600/30 bg-emerald-600/10 p-3 text-sm font-medium text-emerald-800 dark:text-emerald-400">
            Entrada gravada no estoque —{" "}
            {fetcher.data.situacao === "recebido"
              ? "pedido totalmente recebido."
              : fetcher.data.situacao === "parcial"
                ? "pedido fica parcial; lance de novo quando o resto chegar."
                : "confira na ficha do produto."}
          </p>
        ) : null}
      </section>
    </div>
  )
}

function TituloDoPasso({
  numero,
  titulo,
  children,
}: {
  numero: number
  titulo: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {numero}
      </span>
      <div>
        <h4 className="text-sm font-semibold">{titulo}</h4>
        <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

function LinhaItemDaNota({
  item,
  destacados,
  indice,
  catalogoPorId,
  produtoIdEscolhido,
  jaLancado,
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
  destacados: string[]
  indice: EntradaIndice<ProdutoDoCatalogo>[]
  catalogoPorId: Map<string, ProdutoDoCatalogo>
  produtoIdEscolhido: string
  /** O produto ligado a esta linha já entrou no estoque por esta nota. */
  jaLancado: { quantidade: number; lojas: string[] } | null
  quantidadeTexto: string
  custoUnitarioEfetivo: number
  cadastrando: boolean
  cadastroFetcher: ReturnType<typeof useFetcher<RespostaEntrada>>
  onEscolherProduto: (produtoId: string) => void
  onMudarQuantidade: (texto: string) => void
  onAbrirCadastro: () => void
  onCadastrar: (dados: {
    codigo: string
    descricao: string
    unidade: string
    preco: string
    ncm: string
  }) => void
}) {
  return (
    <tr className={cn("border-b last:border-0", jaLancado && "bg-emerald-600/5")}>
      <td className="px-3 py-2 align-top">
        <div className="font-medium">{item.descricao}</div>
        <div className="text-xs text-muted-foreground">cód. fornecedor {item.codigo}</div>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap items-center gap-2">
          <EscolhaDeProduto
            escolhido={catalogoPorId.get(produtoIdEscolhido) ?? null}
            destacados={destacados}
            indice={indice}
            onEscolher={onEscolherProduto}
            grande
          />
          {jaLancado ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAbrirCadastro}
              className="rounded-lg"
              title="Produto que ainda não existe no catálogo: cadastre agora, sem sair daqui"
            >
              <Plus className="size-4" />
              Cadastrar novo
            </Button>
          )}
        </div>
        {jaLancado ? (
          <div className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-500">
            <CircleCheck className="size-3.5" aria-hidden />
            Já lançado: {formatarQuantidade(jaLancado.quantidade)} na {jaLancado.lojas.join(", ")}
          </div>
        ) : null}

        {cadastrando ? (
          <CadastroRapido
            item={item}
            fetcher={cadastroFetcher}
            onCadastrar={onCadastrar}
            onCancelar={onAbrirCadastro}
          />
        ) : null}
      </td>
      <td className="px-3 py-2 text-right align-top text-muted-foreground">
        {formatarQuantidade(item.quantidade)}
      </td>
      <td className="px-3 py-2 text-right align-top">
        <Input
          value={quantidadeTexto}
          onChange={(e) => onMudarQuantidade(e.target.value)}
          disabled={Boolean(jaLancado)}
          inputMode="numeric"
          className="ml-auto h-9 w-24 text-right font-mono text-sm"
        />
      </td>
      <td className="px-3 py-2 text-right align-top font-medium">
        {moeda(custoUnitarioEfetivo)}
      </td>
    </tr>
  )
}

/**
 * Cadastro de produto sem sair da entrada da nota.
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
  fetcher: ReturnType<typeof useFetcher<RespostaEntrada>>
  onCadastrar: (dados: {
    codigo: string
    descricao: string
    unidade: string
    preco: string
    ncm: string
  }) => void
  onCancelar: () => void
}) {
  const [codigo, setCodigo] = useState(item.codigo ?? "")
  const [descricao, setDescricao] = useState(item.descricao ?? "")
  const [unidade, setUnidade] = useState("")
  const [preco, setPreco] = useState("0")
  // O NCM vem da nota do fabricante — melhor fonte que existe para isto, e sem
  // ele a NF-e que a rede emitir depois seria rejeitada.
  const [ncm, setNcm] = useState(item.ncm ?? "")

  const resposta = fetcher.data
  const erro = resposta?.intencao === "cadastrarProduto" && !resposta.ok ? resposta.erro : null

  return (
    <div className="mt-2 w-80 space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">Cadastrar no catálogo</div>
      <div className="flex gap-1.5">
        <Input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          placeholder="Código"
          className="h-9 w-24 text-sm"
        />
        <Input
          value={unidade}
          onChange={(e) => setUnidade(e.target.value)}
          placeholder="UN"
          className="h-9 w-16 text-sm"
        />
        <Input
          value={preco}
          onChange={(e) => setPreco(e.target.value)}
          placeholder="Preço"
          className="h-9 flex-1 text-right font-mono text-sm"
        />
      </div>
      <Input
        value={ncm}
        onChange={(e) => setNcm(e.target.value.replace(/\D/g, "").slice(0, 8))}
        placeholder="NCM (8 dígitos)"
        className="h-9 font-mono text-sm"
      />
      <Input
        value={descricao}
        onChange={(e) => setDescricao(e.target.value)}
        placeholder="Descrição"
        className="h-9 text-sm"
      />
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={fetcher.state !== "idle"}
          onClick={() => onCadastrar({ codigo, descricao, unidade, preco, ncm })}
          className="rounded-lg"
        >
          {fetcher.state !== "idle" ? "Cadastrando…" : "Cadastrar e ligar a este item"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancelar} className="rounded-lg">
          Cancelar
        </Button>
      </div>
      {erro ? <p className="text-xs text-destructive">{erro}</p> : null}
      <p className="text-xs text-muted-foreground">
        O preço de venda pode ficar zerado agora e ser definido depois, com o custo real desta
        nota.
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
  temPedido,
  jaRecebido,
  jaLancadoPelaNota,
  grupo,
  quantidadeTexto,
  quantidade,
  custoUnitario,
  percentuais,
  precoAtual,
  markupTexto,
  precoTexto,
  manter,
  onMudarQuantidade,
  onMudarMarkup,
  onMudarPreco,
  onManter,
}: {
  linha: LinhaDaComparacao
  temPedido: boolean
  jaRecebido: number
  /** Já entrou no estoque por esta nota: a linha fica só para consulta e preço. */
  jaLancadoPelaNota: { quantidade: number; lojas: string[] } | null
  grupo: { quantidade: number; custoTotal: number } | undefined
  quantidadeTexto: string
  quantidade: number
  custoUnitario: number
  percentuais: PercentuaisDaOperacao | null
  /** Null quando o produto acabou de ser cadastrado e ainda não tem preço. */
  precoAtual: number | null
  markupTexto: string
  precoTexto: string
  /** Desmarcado: o preço deste produto fica como está. */
  manter: boolean
  onMudarQuantidade: (texto: string) => void
  onMudarMarkup: (texto: string) => void
  onMudarPreco: (texto: string) => void
  onManter: (manter: boolean) => void
}) {
  const custoEsperadoTotal = linha.quantidadeEsperada * linha.custoEsperado
  // Sem nada pedido não há o que comparar — o extra é mercadoria a mais, não um
  // desvio de preço.
  const comparavel = grupo && !linha.foraDoPedido
  const diferenca = comparavel ? custoUnitario - linha.custoEsperado : null
  const diferencaPct =
    diferenca != null && linha.custoEsperado > 0 ? (diferenca / linha.custoEsperado) * 100 : null
  const completoSemEsta = !linha.foraDoPedido && jaRecebido >= linha.quantidadeEsperada - 0.001
  // Depois desta entrada, ainda falta algo? É o que decide se o pedido fica
  // parcial — mostrado por linha para o gerente ver de onde vem a pendência.
  const faltaDepois = linha.quantidadeEsperada - jaRecebido - quantidade

  const novoPreco = interpretarValor(precoTexto)
  const muda =
    !manter && novoPreco != null && novoPreco > 0 && Math.round(novoPreco * 100) !== Math.round((precoAtual ?? 0) * 100)
  // O markup que o preço de HOJE dá sobre o custo novo — para ver se a nota
  // comeu a margem antes de decidir.
  const markupHoje =
    precoAtual != null && precoAtual > 0 && custoUnitario > 0 ? (precoAtual / custoUnitario - 1) * 100 : null

  /*
   * O preço novo conferido contra os custos da operação, quando há dados: um
   * markup "bonito" sobre o custo ainda pode não pagar fixas e variáveis.
   */
  const conferencia =
    percentuais?.temDados && novoPreco != null && novoPreco > 0 && custoUnitario > 0
      ? conferirPrecoVenda({
          custo: custoUnitario,
          preco: novoPreco,
          pctFixos: percentuais.pctFixas,
          pctVariaveis: percentuais.pctVariaveis,
        })
      : null

  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2">
        <div className="font-medium">{linha.descricao}</div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {linha.codigo}
          {/* Sem pedido, tudo estaria "fora do pedido" — o aviso viraria ruído. */}
          {linha.foraDoPedido && temPedido ? (
            <Badge variant="secondary" className="text-xs">
              fora do pedido
            </Badge>
          ) : null}
        </div>
      </td>
      {temPedido ? (
        <>
      <td className="px-3 py-2 text-right">
        {linha.foraDoPedido ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${formatarQuantidade(linha.quantidadeEsperada)} ${linha.unidade}`
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <span className={completoSemEsta ? "text-muted-foreground" : ""}>
          {formatarQuantidade(jaRecebido)} {linha.unidade}
        </span>
      </td>
        </>
      ) : null}
      <td className="px-3 py-2 text-right">
        {jaLancadoPelaNota ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-500">
            <CircleCheck className="size-3.5" aria-hidden />
            já lançado ({formatarQuantidade(jaLancadoPelaNota.quantidade)} {linha.unidade})
          </span>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <Input
              value={quantidadeTexto}
              onChange={(e) => onMudarQuantidade(e.target.value)}
              inputMode="numeric"
              className="h-9 w-24 text-right font-mono text-sm"
            />
            <span className="text-muted-foreground">{linha.unidade}</span>
          </div>
        )}
        {!jaLancadoPelaNota && faltaDepois > 0.001 ? (
          <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-500">
            faltam {formatarQuantidade(faltaDepois)}
          </div>
        ) : null}
      </td>
      {temPedido ? (
        <td className="px-3 py-2 text-right text-muted-foreground">
          {linha.foraDoPedido ? "—" : moeda(custoEsperadoTotal)}
        </td>
      ) : null}
      <td className="px-3 py-2 text-right font-medium">
        {grupo ? moeda(custoUnitario * quantidade) : "—"}
      </td>
      {temPedido ? (
      <td className="px-3 py-2 text-right">
        {diferenca == null ? (
          <span className="text-muted-foreground">
            {linha.foraDoPedido
              ? temPedido
                ? "não pedido"
                : "—"
              : completoSemEsta
                ? "completo"
                : "sem nota pareada"}
          </span>
        ) : (
          <Badge
            variant={
              Math.abs(diferencaPct ?? 0) < 1 ? "outline" : diferenca > 0 ? "destructive" : "secondary"
            }
          >
            {diferenca > 0 ? "+" : ""}
            {moeda(diferenca)}/un ({diferencaPct?.toFixed(0)}%)
          </Badge>
        )}
      </td>

      ) : null}
      <td className="px-3 py-2 text-right">
        {precoAtual != null && precoAtual > 0 ? (
          <>
            <div>{moeda(precoAtual)}</div>
            {markupHoje != null ? (
              <div
                className={cn(
                  "text-xs",
                  markupHoje <= 0 ? "font-medium text-destructive" : "text-muted-foreground"
                )}
                title="O markup que o preço de hoje dá sobre o custo desta nota"
              >
                {markupHoje.toFixed(0)}% s/ custo
              </div>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">sem preço</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <Input
            value={markupTexto}
            onChange={(e) => onMudarMarkup(e.target.value)}
            disabled={!(custoUnitario > 0)}
            inputMode="decimal"
            className="h-9 w-20 text-right font-mono text-sm"
          />
          <span className="text-muted-foreground">%</span>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {/*
            Marcado = este preço vai para o catálogo no "Atualizar preços".
            Desmarcar segura a linha sem perder o que foi digitado.
          */}
          <input
            type="checkbox"
            checked={!manter}
            onChange={(e) => onManter(!e.target.checked)}
            title="Atualizar o preço de venda deste produto"
            className="size-4"
          />
          <Input
            value={precoTexto}
            onChange={(e) => onMudarPreco(e.target.value)}
            disabled={!(custoUnitario > 0)}
            inputMode="decimal"
            className={cn(
              "h-9 w-24 text-right font-mono text-sm",
              muda && "border-primary font-semibold"
            )}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {/* A unidade junto: o custo vem na embalagem da nota até a "Qtd no
              catálogo" lá em cima converter — dizer "/PC" deixa isso à vista. */}
          /{linha.unidade}
          {novoPreco != null && novoPreco > 0 && novoPreco < custoUnitario ? (
            <span className="ml-1 font-medium text-destructive">· abaixo do custo</span>
          ) : conferencia?.status === "prejuizo" ? (
            <span className="ml-1 font-medium text-destructive" title="Não paga custos fixos e variáveis">
              · dá prejuízo
            </span>
          ) : conferencia?.status === "empate" ? (
            <span className="ml-1 text-amber-600 dark:text-amber-500">· empata</span>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
