import { useEffect, useMemo, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { Plus, Search } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { ESTILO_CAMPO } from "~/components/pdv/filtros"
import {
  EscolhaDeProduto,
  type ProdutoDoCatalogo,
} from "~/components/pdv/escolha-de-produto"
import { ReceberPedido } from "~/components/pdv/pedido-compra"
import type { ItemDaNotaParaConciliar, ItemReconciliado } from "~/lib/conciliacao.server"
import { interpretarValor, moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import {
  calcularPrecoVenda,
  conferirPrecoVenda,
  LUCRO_PADRAO,
} from "~/lib/precificacao"
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
  jaRecebida,
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
  jaRecebida: boolean
  recebidoEm: string | null
  recebidoPor: string | null
}) {
  const fetcher = useFetcher<RespostaEntrada>()
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

  /*
   * O lucro é escolha de quem confere a nota, não constante do sistema: muda
   * por linha de produto, por concorrência, por o que a mercadoria custou desta
   * vez. Começa em 10% porque é preciso começar em algum lugar, e é onde a
   * calculadora da rede começa.
   */
  const [lucroTexto, setLucroTexto] = useState(String(LUCRO_PADRAO))
  const pctLucro = interpretarValor(lucroTexto) ?? 0

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

  const nadaPareado = linhasDaComparacao.every((l) => quantidadeAReceber(l.produtoId) <= 0)

  function receber(loja: string) {
    const itens: ItemReconciliado[] = linhasDaComparacao.map((linha) => ({
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

  if (jaRecebida) {
    return (
      <div className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3 text-xs">
        Mercadoria já lançada no estoque
        {recebidoEm ? ` em ${new Date(recebidoEm).toLocaleString("pt-BR")}` : ""}
        {recebidoPor ? ` por ${recebidoPor}` : ""}.
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-sm font-medium">Entrada no estoque</h3>
        <label className="flex items-center gap-2">
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

      {pedidos.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Nenhum pedido em aberto deste fornecedor — a mercadoria entra pelo custo da nota,
          sem comparação com o que tinha sido combinado.
        </p>
      ) : null}

      <div className="mt-3 overflow-x-auto rounded-lg border">
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
                destacados={idsDoPedido}
                indice={indiceDoCatalogo}
                catalogoPorId={catalogoPorId}
                produtoIdEscolhido={pareamento[i] ?? ""}
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

      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <h4 className="text-sm font-medium">O que entra no estoque</h4>

        {/*
          A régua do preço, ao lado da tabela que ela precifica. Fica aqui, e
          não numa tela de configuração, porque é decisão desta nota: o gerente
          vê o custo que chegou e escolhe a margem olhando para ele.
        */}
        {percentuais?.temDados ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Lucro</span>
              <Input
                value={lucroTexto}
                onChange={(e) => setLucroTexto(e.target.value)}
                inputMode="decimal"
                className="h-7 w-16 text-right font-mono text-xs"
              />
              <span className="text-muted-foreground">%</span>
            </label>
            <span
              className="text-muted-foreground"
              title={
                `Receita de ${moeda(percentuais.receitas)} no período · ` +
                `fixas ${moeda(percentuais.fixas)} · variáveis ${moeda(percentuais.variaveis)}`
              }
            >
              + {percentuais.pctFixas.toFixed(1)}% fixas e{" "}
              {percentuais.pctVariaveis.toFixed(1)}% variáveis, medidos de{" "}
              {percentuais.de} a {percentuais.ate}
            </span>
          </div>
        ) : null}
      </div>
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
              {percentuais?.temDados ? (
                <th className="px-2 py-1.5 text-right">Preço sugerido</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {linhasDaComparacao.length === 0 ? (
              <tr>
                <td
                  colSpan={percentuais?.temDados ? 8 : 7}
                  className="px-2 py-4 text-center text-muted-foreground"
                >
                  Pareie os itens da nota acima para ver o que vai entrar.
                </td>
              </tr>
            ) : (
              linhasDaComparacao.map((linha) => (
                <LinhaResumoProduto
                  key={linha.produtoId}
                  linha={linha}
                  temPedido={pedidoEscolhido != null}
                  jaRecebido={recebidoAntes[linha.produtoId] ?? 0}
                  grupo={gruposPorProduto.get(linha.produtoId)}
                  quantidadeTexto={
                    quantidadeRecebida[linha.produtoId] ??
                    formatarQuantidade(gruposPorProduto.get(linha.produtoId)?.quantidade ?? 0)
                  }
                  custoUnitario={custoUnitarioDe(linha.produtoId)}
                  percentuais={percentuais}
                  pctLucro={pctLucro}
                  precoAtual={catalogoPorId.get(linha.produtoId)?.preco ?? null}
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

      <p className="mt-2 text-xs text-muted-foreground">
        Na tabela de cima, "Qtd no catálogo" converte a embalagem do fornecedor para a unidade
        do catálogo (caixa, pacote, fracionado) — é o que define o custo unitário. Aqui embaixo,
        "Recebendo agora" é o que de fato entra no estoque: corrija para o que você contou na
        porta.
        {pedidoEscolhido
          ? " O que faltar deixa o pedido parcial, e você lança de novo quando o resto chegar."
          : ""}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {nadaPareado ? (
          <span className="text-xs text-amber-600 dark:text-amber-500">
            Pareie ao menos um item da nota para dar entrada — não precisa ser tudo.
          </span>
        ) : (
          <ReceberPedido lojas={lojas} gravando={recebendo} onReceber={receber} />
        )}

        {fetcher.data?.intencao === "receber" && !fetcher.data.ok ? (
          <span className="text-xs text-destructive">{fetcher.data.erro}</span>
        ) : null}
        {fetcher.data?.intencao === "receber" && fetcher.data.ok ? (
          <span className="text-xs text-muted-foreground">
            Entrada gravada —{" "}
            {fetcher.data.situacao === "recebido"
              ? "pedido totalmente recebido."
              : fetcher.data.situacao === "parcial"
                ? "pedido fica parcial; lance de novo quando o resto chegar."
                : "sem pedido para fechar."}
          </span>
        ) : null}
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
    <tr className="border-b last:border-0">
      <td className="px-2 py-1.5 align-top">
        <div className="font-medium">{item.descricao}</div>
        <div className="text-muted-foreground">cód. fornecedor {item.codigo}</div>
      </td>
      <td className="px-2 py-1.5 align-top">
        <div className="flex items-center gap-1">
          <EscolhaDeProduto
            escolhido={catalogoPorId.get(produtoIdEscolhido) ?? null}
            destacados={destacados}
            indice={indice}
            onEscolher={onEscolherProduto}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onAbrirCadastro}
            title="Produto que ainda não existe no catálogo: cadastre agora, sem sair daqui"
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
      <td className="px-2 py-1.5 text-right align-top font-medium">
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
  grupo,
  quantidadeTexto,
  quantidade,
  custoUnitario,
  percentuais,
  pctLucro,
  precoAtual,
  onMudarQuantidade,
}: {
  linha: LinhaDaComparacao
  temPedido: boolean
  jaRecebido: number
  grupo: { quantidade: number; custoTotal: number } | undefined
  quantidadeTexto: string
  quantidade: number
  custoUnitario: number
  percentuais: PercentuaisDaOperacao | null
  pctLucro: number
  /** Null quando o produto acabou de ser cadastrado e ainda não tem preço. */
  precoAtual: number | null
  onMudarQuantidade: (texto: string) => void
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

  /*
   * A sugestão sai do custo REAL desta nota — produto mais impostos por fora
   * mais o rateio do frete —, e não do custo esperado do pedido. É o número que
   * a mercadoria custou de verdade ao entrar, e é sobre ele que a margem tem
   * que ser tirada.
   */
  const preco =
    percentuais?.temDados && custoUnitario > 0
      ? calcularPrecoVenda({
          custo: custoUnitario,
          pctFixos: percentuais.pctFixas,
          pctVariaveis: percentuais.pctVariaveis,
          pctLucro,
        })
      : null

  const hoje =
    percentuais?.temDados && precoAtual != null && precoAtual > 0 && custoUnitario > 0
      ? conferirPrecoVenda({
          custo: custoUnitario,
          preco: precoAtual,
          pctFixos: percentuais.pctFixas,
          pctVariaveis: percentuais.pctVariaveis,
        })
      : null

  return (
    <tr className="border-b last:border-0">
      <td className="px-2 py-1.5">
        <div className="font-medium">{linha.descricao}</div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {linha.codigo}
          {/* Sem pedido, tudo estaria "fora do pedido" — o aviso viraria ruído. */}
          {linha.foraDoPedido && temPedido ? (
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

      {/*
        A sugestão e o preço de hoje lado a lado. Um número sozinho —
        "sugerido R$ 16,67" — não diz o que fazer; com o preço atual embaixo,
        a linha responde se está barato, caro ou já certo.
      */}
      {percentuais?.temDados ? (
        <td className="px-2 py-1.5 text-right">
          {preco ? (
            <>
              {/*
                A unidade fica escrita junto. O custo vem da nota, que fatura na
                embalagem do FORNECEDOR (quilo, rolo, fardo), e o preço é do
                catálogo, que vende na sua. Enquanto a "Qtd no catálogo" não for
                convertida lá em cima, este número está na unidade da nota — e
                dizer "por PC" é o que deixa a divergência visível em vez de
                virar um preço plausível e errado.
              */}
              <div className="font-medium">
                {moeda(preco.precoSugerido)}
                <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
                  /{linha.unidade}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {precoAtual != null && precoAtual > 0 ? (
                  <>
                    hoje {moeda(precoAtual)}
                    {hoje ? (
                      <span
                        className={cn(
                          "ml-1",
                          hoje.status === "prejuizo" && "font-medium text-destructive",
                          hoje.status === "empate" && "text-amber-600 dark:text-amber-500"
                        )}
                        title={
                          `Neste preço sobra ${moeda(hoje.sobraReal)} por unidade depois de ` +
                          `cobrir custo, fixas e variáveis. Mínimo para empatar: ` +
                          `${preco.precoMinimo != null ? moeda(preco.precoMinimo) : "—"}`
                        }
                      >
                        {hoje.status === "prejuizo"
                          ? "· dá prejuízo"
                          : hoje.status === "empate"
                            ? "· empata"
                            : `· ${hoje.margemBruta.toFixed(0)}% bruto`}
                      </span>
                    ) : null}
                  </>
                ) : (
                  "sem preço no catálogo"
                )}
              </div>
            </>
          ) : (
            <span
              className="text-muted-foreground"
              title={
                custoUnitario > 0
                  ? "Fixas + variáveis + lucro passam de 100% — nesse ponto não existe preço que feche"
                  : "Sem custo nesta linha"
              }
            >
              —
            </span>
          )}
        </td>
      ) : null}
    </tr>
  )
}
