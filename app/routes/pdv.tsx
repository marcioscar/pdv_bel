import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { data, useFetcher } from "react-router"

import type { Route } from "./+types/pdv"
import { AjudaAtalhos } from "~/components/pdv/ajuda-atalhos"
import { ClienteDialogo, type ClienteResumo } from "~/components/pdv/cliente-dialogo"
import { CobrancaDialogo } from "~/components/pdv/cobranca-dialogo"
import { CondicaoDialogo } from "~/components/pdv/condicao-dialogo"
import { BarraAtalhos, type Atalho } from "~/components/pdv/barra-atalhos"
import { BarraComando, type ModoComando } from "~/components/pdv/barra-comando"
import { ListaItens } from "~/components/pdv/lista-itens"
import { PixDialogo, type PixNoBalcao } from "~/components/pdv/pix-dialogo"
import { PainelPagamento } from "~/components/pdv/painel-pagamento"
import { Topo } from "~/components/pdv/topo"
import { Kbd } from "~/components/ui/kbd"
import { db } from "~/lib/db.server"
import { criarCliente, lerCliente, listarClientes } from "~/lib/clientes.server"
import { emitirParaVenda, type CobrancaDaVenda } from "~/lib/cobranca.server"
import { saldosPorProduto } from "~/lib/estoque.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { lerPedido, precificar, registrarVenda } from "~/lib/vendas.server"
import {
  confirmarPagamento,
  consultarPixImediato,
  criarPixImediato,
  novoTxid,
  type PixImediato,
} from "~/lib/pix.server"
import {
  interpretarValor,
  moeda,
  quantidade as formatarQuantidade,
} from "~/lib/moeda"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"
import {
  buscarProdutos,
  condicaoCabeNoTotal,
  CONDICOES_PAGAMENTO,
  criarIndice,
  FORMAS_PAGAMENTO,
  VALOR_MINIMO_BOLETO,
  interpretarComando,
  produtosPorCodigo,
  reduzirVenda,
  totaisDaVenda,
  vendaVazia,
  type CondicaoPagamento,
  type FormaPagamento,
  type ProdutoCatalogo,
} from "~/lib/pdv"

export function meta(_: Route.MetaArgs) {
  return [
    { title: "PDV — Vendas" },
    { name: "description", content: "Frente de caixa operada pelo teclado." },
  ]
}

const CAIXA = "01"

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  // O catálogo inteiro vai para o cliente para a busca responder sem latência
  // por tecla. Acima de ~5 mil produtos, trocar por busca no servidor.
  const [cadastro, saldos, clientes] = await Promise.all([
    db.produto.findMany({ orderBy: { descricao: "asc" } }),
    saldosPorProduto(),
    listarClientes(),
  ])

  // O estoque não é um campo do produto: é a soma dos movimentos.
  const produtos = cadastro.map((produto) => ({
    ...produto,
    estoque: saldos.get(produto.id) ?? 0,
  }))

  return {
    eu,
    produtos,
    clientes: clientes.map((c) => ({
      id: c.id,
      nome: c.nome,
      cpfCnpj: c.cpfCnpj,
      cidade: c.cidade,
      uf: c.uf,
    })),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)

  // Cadastro de cliente vem como formulário; a venda vem como JSON.
  if (request.headers.get("content-type")?.includes("form")) {
    const resultado = await criarCliente(lerCliente(await request.formData()))
    if (!resultado.ok) {
      return data({ ok: false as const, tipo: "cliente" as const, erro: resultado.erro }, { status: 400 })
    }
    const { id, nome, cpfCnpj, cidade, uf } = resultado.cliente
    return {
      ok: true as const,
      tipo: "cliente" as const,
      cliente: { id, nome, cpfCnpj, cidade, uf },
    }
  }

  let bruto: unknown
  try {
    bruto = await request.json()
  } catch {
    return data(
      { ok: false as const, tipo: "venda" as const, erro: "Requisição inválida" },
      { status: 400 }
    )
  }

  // Emissão do boleto da venda a prazo, disparada logo após a venda gravar.
  if ((bruto as { intencao?: string })?.intencao === "cobranca") {
    const vendaId = String((bruto as { vendaId?: string }).vendaId ?? "")
    try {
      return {
        ok: true as const,
        tipo: "cobranca" as const,
        cobrancas: await emitirParaVenda(vendaId),
        vendaId,
      }
    } catch (erro) {
      return data(
        {
          ok: false as const,
          tipo: "cobranca" as const,
          erro: erro instanceof Error ? erro.message : "Falha ao emitir a cobrança",
        },
        { status: 400 }
      )
    }
  }

  // --- Pix no balcão: cria a cobrança pelo total recalculado do banco ---
  if ((bruto as { intencao?: string })?.intencao === "pixCriar") {
    const pedido = lerPedido(bruto)
    if (!pedido) {
      return data({ ok: false as const, tipo: "pix" as const, erro: "Dados inválidos" }, { status: 400 })
    }

    const preco = await precificar(pedido.itens, pedido.desconto)
    if (!preco.ok) {
      return data({ ok: false as const, tipo: "pix" as const, erro: preco.erro }, { status: 400 })
    }

    try {
      const cobranca = await criarPixImediato({
        txid: novoTxid(),
        valor: preco.total,
        expiracaoSegundos: 900,
        solicitacao: `Caixa ${CAIXA} - BrasSaco Embalagens`,
      })
      return { ok: true as const, tipo: "pix" as const, cobranca, total: preco.total }
    } catch (erro) {
      return data(
        {
          ok: false as const,
          tipo: "pix" as const,
          erro: erro instanceof Error ? erro.message : "Falha ao criar a cobrança Pix",
        },
        { status: 400 }
      )
    }
  }

  // --- Pix no balcão: confere e, se pago, grava a venda ---
  if ((bruto as { intencao?: string })?.intencao === "pixConferir") {
    const pedido = lerPedido(bruto)
    const txid = String((bruto as { txid?: string }).txid ?? "")
    if (!pedido || !/^[a-zA-Z0-9]{26,35}$/.test(txid)) {
      return data({ ok: false as const, tipo: "pixStatus" as const, erro: "Dados inválidos" }, { status: 400 })
    }

    // O total é recalculado agora, e não o que foi criado antes: se o carrinho
    // mudou no meio, o valor pago não bate e a venda não é liberada.
    const preco = await precificar(pedido.itens, pedido.desconto)
    if (!preco.ok) {
      return data({ ok: false as const, tipo: "pixStatus" as const, erro: preco.erro }, { status: 400 })
    }

    const pix = await consultarPixImediato(txid)
    const confirmacao = confirmarPagamento(pix, preco.total)

    if (!confirmacao.pago) {
      return {
        ok: true as const,
        tipo: "pixStatus" as const,
        pago: false as const,
        status: pix.status,
        motivo: confirmacao.motivo,
      }
    }

    const resultado = await registrarVenda({
      ...pedido,
      forma: "pix",
      recebido: preco.total,
      pixTxid: txid,
      pixPagoEm: pix.pagoEm ? new Date(pix.pagoEm) : new Date(),
      caixa: CAIXA,
      operador: eu.nome,
    })

    if (!resultado.ok) {
      return data(
        { ok: false as const, tipo: "pixStatus" as const, erro: resultado.erro },
        { status: 400 }
      )
    }

    return {
      ok: true as const,
      tipo: "pixStatus" as const,
      pago: true as const,
      numero: resultado.numero,
      pagoEm: pix.pagoEm,
      endToEndId: pix.endToEndId,
    }
  }

  const pedido = lerPedido(bruto)
  if (!pedido) {
    return data(
      { ok: false as const, tipo: "venda" as const, erro: "Dados da venda inválidos" },
      { status: 400 }
    )
  }

  const resultado = await registrarVenda({ ...pedido, caixa: CAIXA, operador: eu.nome })
  return resultado.ok
    ? { ...resultado, tipo: "venda" as const }
    : data({ ...resultado, tipo: "venda" as const }, { status: 400 })
}

// O catálogo não muda durante o expediente; revalidar depois de cada venda
// reenviaria os mil e poucos produtos sem motivo. Recarregar a página atualiza.
export function shouldRevalidate() {
  return false
}

type Aviso = { texto: string; tipo: "erro" | "sucesso" } | null

export default function Pdv({ loaderData }: Route.ComponentProps) {
  const { eu, produtos, clientes } = loaderData

  const [venda, despachar] = useReducer(reduzirVenda, vendaVazia)
  const [entrada, setEntrada] = useState("")
  const [modo, setModo] = useState<ModoComando>("busca")
  const [indiceResultado, setIndiceResultado] = useState(0)
  const [forma, setForma] = useState<FormaPagamento>("dinheiro")
  const [recebido, setRecebido] = useState<number | null>(null)
  const [ajudaAberta, setAjudaAberta] = useState(false)
  const [aviso, setAviso] = useState<Aviso>(null)
  const [cliente, setCliente] = useState<ClienteResumo | null>(null)
  const [clienteAberto, setClienteAberto] = useState(false)
  const [clienteErro, setClienteErro] = useState<string | null>(null)
  // Clientes criados nesta sessão: o loader não revalida (shouldRevalidate=false)
  // para não reenviar o catálogo inteiro, então mantemos os novos aqui.
  const [novosClientes, setNovosClientes] = useState<ClienteResumo[]>([])
  // Condição escolhida na venda a prazo. Fica guardada para o painel mostrar o
  // prazo enquanto a venda é fechada; o servidor recalcula as datas na gravação.
  const [condicao, setCondicao] = useState<CondicaoPagamento | null>(null)
  const [condicaoAberta, setCondicaoAberta] = useState(false)
  const [pix, setPix] = useState<{
    cobranca: PixNoBalcao | null
    criando: boolean
    erro: string | null
    concluida: { numero: number; pagoEm: string | null } | null
    motivoPendente: string | null
  } | null>(null)
  const [comprovante, setComprovante] = useState<{
    vendaNumero: number
    vendaId: string
    cobrancas: CobrancaDaVenda[]
    erro: string | null
    emitindo: boolean
  } | null>(null)
  const { escuro, alternar: alternarTema } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel, !ajudaAberta)

  const campo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"
  // Fetcher separado para o Pix: a consulta a cada 5s não pode interferir no
  // fetcher que grava venda e cadastra cliente.
  const fetcherPix = useFetcher<typeof action>()

  const todosClientes = useMemo(
    () => [...clientes, ...novosClientes].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
    [clientes, novosClientes]
  )

  const indice = useMemo(() => criarIndice(produtos), [produtos])
  const comando = useMemo(() => interpretarComando(entrada), [entrada])
  const totais = useMemo(() => totaisDaVenda(venda), [venda])

  const resultados = useMemo(() => {
    if (modo !== "busca") return []
    if (comando.tipo === "texto") return buscarProdutos(indice, comando.termo)
    if (comando.tipo === "codigo") {
      // 55 códigos do catálogo se repetem: quando o código é ambíguo o operador
      // escolhe na lista em vez de a venda receber o produto errado.
      const achados = produtosPorCodigo(produtos, comando.codigo)
      return achados.length > 1 ? achados : []
    }
    return []
  }, [modo, comando, indice, produtos])

  const avisar = useCallback((texto: string, tipo: "erro" | "sucesso") => {
    setAviso({ texto, tipo })
  }, [])

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 4000)
    return () => clearTimeout(id)
  }, [aviso])

  useEffect(() => setIndiceResultado(0), [entrada])

  // O campo de comando é o único ponto de foco da tela.
  const focar = useCallback(() => campo.current?.focus(), [])

  useEffect(() => {
    if (!ajudaAberta && !clienteAberto && !comprovante && !pix && !condicaoAberta) focar()
  }, [ajudaAberta, clienteAberto, comprovante, pix, condicaoAberta, modo, focar])

  // Clicar num botão de atalho tira o foco do campo; devolvemos no frame seguinte
  // para que a próxima tecla continue caindo na barra de comando.
  const devolverFoco = useCallback(() => {
    if (ajudaAberta || clienteAberto || condicaoAberta) return
    requestAnimationFrame(focar)
  }, [ajudaAberta, clienteAberto, condicaoAberta, focar])

  const voltarParaBusca = useCallback(() => {
    setModo("busca")
    setEntrada("")
  }, [])

  const adicionar = useCallback(
    (produto: ProdutoCatalogo, quantidade: number) => {
      despachar({ tipo: "adicionar", produto, quantidade })
      setEntrada("")

      // O item entra de qualquer jeito: com o catálogo todo em estoque 0, impedir
      // a venda travaria o caixa. O aviso e a marca na linha sinalizam a falta.
      const jaNoCarrinho =
        venda.itens.find((item) => item.produtoId === produto.id)?.quantidade ?? 0
      const resultante = jaNoCarrinho + quantidade
      const excede = resultante > produto.estoque

      avisar(
        excede
          ? `${produto.descricao} · ${formatarQuantidade(resultante)} ${produto.unidade} — acima do estoque (${formatarQuantidade(produto.estoque)})`
          : `${produto.descricao} · ${formatarQuantidade(quantidade)} ${produto.unidade}`,
        excede ? "erro" : "sucesso"
      )
    },
    [avisar, venda.itens]
  )

  const concluir = useCallback(
    (valorRecebido: number | null, condicaoEscolhida: CondicaoPagamento | null = null) => {
      if (gravando) return

      fetcher.submit(
        {
          // Só o que e quanto: o servidor busca os preços e recalcula os totais.
          itens: venda.itens.map((item) => ({
            produtoId: item.produtoId,
            quantidade: item.quantidade,
          })),
          desconto: totais.desconto,
          forma,
          recebido: valorRecebido,
          clienteId: cliente?.id ?? null,
          // Vai o id da condição, não as datas: os vencimentos são calculados no
          // servidor, para o prazo gravado ser sempre um dos que a empresa pratica.
          condicao: condicaoEscolhida?.id ?? null,
        },
        { method: "post", encType: "application/json" }
      )
    },
    [cliente, fetcher, forma, gravando, totais.desconto, venda.itens]
  )

  // O carrinho só é limpo depois de o servidor confirmar a gravação.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data
    const resposta = fetcher.data

    if (resposta.tipo === "cliente") {
      if (!resposta.ok) {
        setClienteErro(resposta.erro)
        return
      }
      setClienteErro(null)
      setNovosClientes((atuais) => [...atuais, resposta.cliente])
      setCliente(resposta.cliente)
      setClienteAberto(false)
      avisar(`${resposta.cliente.nome} cadastrado e vinculado à venda`, "sucesso")
      return
    }

    if (resposta.tipo === "pix") {
      if (!resposta.ok) {
        setPix({ cobranca: null, criando: false, erro: resposta.erro, concluida: null, motivoPendente: null })
        return
      }
      setPix({
        cobranca: { ...resposta.cobranca, valor: resposta.total },
        criando: false,
        erro: null,
        concluida: null,
        motivoPendente: null,
      })
      return
    }

    // Antes da checagem genérica: a falha da emissão pertence ao comprovante,
    // não à barra de status — a venda já está gravada.
    if (resposta.tipo === "cobranca") {
      const atualizacao = resposta.ok
        ? { cobrancas: resposta.cobrancas, erro: null, emitindo: false }
        : { cobrancas: [], erro: resposta.erro, emitindo: false }

      setComprovante((atual) => (atual === null ? null : { ...atual, ...atualizacao }))
      return
    }

    if (!resposta.ok) {
      avisar(resposta.erro, "erro")
      return
    }

    // As respostas de Pix são tratadas pelo fetcher próprio; aqui só a venda.
    if (resposta.tipo !== "venda") return

    const { numero, troco } = resposta

    // Venda a prazo: abre o comprovante e emite os boletos em seguida.
    if (forma === "prazo") {
      setComprovante({
        vendaNumero: numero,
        vendaId: resposta.vendaId,
        cobrancas: [],
        erro: null,
        emitindo: true,
      })
      fetcher.submit(
        { intencao: "cobranca", vendaId: resposta.vendaId },
        { method: "post", encType: "application/json" }
      )
    }

    despachar({ tipo: "limpar" })
    setRecebido(null)
    setModo("busca")
    setEntrada("")
    setCliente(null)
    setCondicao(null)
    avisar(
      troco > 0
        ? `Venda #${numero} registrada · troco ${moeda(troco)}`
        : `Venda #${numero} registrada`,
      "sucesso"
    )
  }, [fetcher.state, fetcher.data, avisar, fetcher, forma])

  /**
   * Consulta o pagamento enquanto o QR está na tela.
   *
   * `setInterval` com ref, e não um `setTimeout` reagendado pelo próprio efeito:
   * o reagendamento dependia de a identidade do objeto do fetcher mudar a cada
   * resposta. Quando ela não muda, o efeito não re-executa e o polling morre
   * depois da primeira consulta — foi o que aconteceu, e a venda paga nunca era
   * registrada. O intervalo dispara independente de re-render.
   */
  const dadosDaConsulta = useRef({ fetcher: fetcherPix, itens: venda.itens, desconto: 0 })
  dadosDaConsulta.current = {
    fetcher: fetcherPix,
    itens: venda.itens,
    desconto: totais.desconto,
  }

  const conferirPix = useCallback((txid: string) => {
    const { fetcher: f, itens, desconto } = dadosDaConsulta.current
    if (f.state !== "idle") return

    f.submit(
      {
        intencao: "pixConferir",
        txid,
        itens: itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade })),
        desconto,
        forma: "pix",
        recebido: null,
      },
      { method: "post", encType: "application/json" }
    )
  }, [])

  const txidEmCobranca = pix?.cobranca?.txid ?? null
  const pixConcluido = Boolean(pix?.concluida)

  useEffect(() => {
    if (!txidEmCobranca || pixConcluido) return

    const id = setInterval(() => conferirPix(txidEmCobranca), 5000)
    return () => clearInterval(id)
  }, [txidEmCobranca, pixConcluido, conferirPix])

  // Resposta da consulta: confirmou ou segue pendente.
  useEffect(() => {
    if (fetcherPix.state !== "idle" || !fetcherPix.data) return
    const r = fetcherPix.data
    if (r.tipo !== "pixStatus") return

    if (!r.ok) {
      setPix((atual) => (atual ? { ...atual, erro: r.erro, criando: false } : atual))
      return
    }
    if (!r.pago) {
      setPix((atual) => (atual ? { ...atual, motivoPendente: r.motivo } : atual))
      return
    }

    // Pago: a venda já foi gravada no servidor. Limpa o carrinho.
    despachar({ tipo: "limpar" })
    setRecebido(null)
    setModo("busca")
    setEntrada("")
    setPix((atual) =>
      atual ? { ...atual, concluida: { numero: r.numero, pagoEm: r.pagoEm }, motivoPendente: null } : atual
    )
  }, [fetcherPix.state, fetcherPix.data])

  const iniciarPagamento = useCallback(() => {
    if (venda.itens.length === 0) {
      avisar("Nenhum item na venda", "erro")
      return
    }
    // Dinheiro precisa do valor recebido para calcular troco; o resto fecha direto.
    if (forma === "dinheiro") {
      setModo("recebido")
      setEntrada("")
      return
    }
    // Pix no balcão: gera a cobrança e espera a confirmação do banco.
    if (forma === "pix") {
      setPix({ cobranca: null, criando: true, erro: null, concluida: null, motivoPendente: null })
      fetcher.submit(
        {
          intencao: "pixCriar",
          itens: venda.itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade })),
          desconto: totais.desconto,
          forma: "pix",
          recebido: null,
        },
        { method: "post", encType: "application/json" }
      )
      return
    }

    // A prazo vira boleto: precisa do pagador e de uma das condições fixas.
    if (forma === "prazo") {
      if (!cliente) {
        setClienteAberto(true)
        avisar("Venda a prazo exige cliente", "erro")
        return
      }
      // Nenhuma condição serve: nem o boleto de uma parcela chega ao mínimo.
      if (!CONDICOES_PAGAMENTO.some((c) => condicaoCabeNoTotal(c, totais.total))) {
        avisar(`Venda a prazo exige no mínimo ${moeda(VALOR_MINIMO_BOLETO)}`, "erro")
        return
      }
      setCondicaoAberta(true)
      setEntrada("")
      return
    }
    concluir(null)
  }, [avisar, cliente, concluir, fetcher, forma, totais.desconto, totais.total, venda.itens])

  const confirmar = useCallback(() => {
    if (modo === "busca") {
      if (comando.tipo === "vazio") return

      if (comando.tipo === "codigo") {
        const achados = produtosPorCodigo(produtos, comando.codigo)
        if (achados.length === 0) {
          // O leitor de código de barras termina com Enter: se o texto ficasse,
          // a próxima leitura concatenaria no código que falhou.
          setEntrada("")
          avisar(`Código ${comando.codigo} não encontrado`, "erro")
          return
        }
        const escolhido =
          achados.length === 1 ? achados[0] : achados[indiceResultado]
        if (escolhido) adicionar(escolhido, comando.quantidade)
        return
      }

      const escolhido = resultados[indiceResultado]
      if (!escolhido) {
        avisar(`Nada encontrado para “${comando.termo}”`, "erro")
        return
      }
      adicionar(escolhido, comando.quantidade)
      return
    }

    const valorTeste = interpretarValor(entrada)
    if (valorTeste === null) {
      avisar("Valor inválido", "erro")
      return
    }
    const valor = valorTeste

    if (modo === "quantidade") {
      despachar({ tipo: "definirQuantidade", indice: venda.indiceAtivo, quantidade: valor })
      voltarParaBusca()
      return
    }

    if (modo === "desconto") {
      if (valor > totais.subtotal) {
        avisar("Desconto maior que o subtotal", "erro")
        return
      }
      despachar({ tipo: "definirDesconto", valor })
      voltarParaBusca()
      return
    }

    // modo === "recebido"
    setRecebido(valor)
    if (valor < totais.total) {
      avisar(`Faltam ${moeda(totais.total - valor)}`, "erro")
      return
    }
    concluir(valor)
  }, [
    adicionar,
    avisar,
    comando,
    concluir,
    entrada,
    indiceResultado,
    modo,
    produtos,
    resultados,
    totais.subtotal,
    totais.total,
    venda.indiceAtivo,
    voltarParaBusca,
  ])

  const pedirQuantidade = useCallback(() => {
    if (venda.indiceAtivo < 0) {
      avisar("Selecione um item com ↑ ↓", "erro")
      return
    }
    setModo("quantidade")
    setEntrada("")
  }, [avisar, venda.indiceAtivo])

  const pedirDesconto = useCallback(() => {
    if (venda.itens.length === 0) {
      avisar("Nenhum item na venda", "erro")
      return
    }
    setModo("desconto")
    setEntrada("")
  }, [avisar, venda.itens.length])

  const cancelarVenda = useCallback(() => {
    if (venda.itens.length === 0) return
    despachar({ tipo: "limpar" })
    setRecebido(null)
    voltarParaBusca()
    avisar("Venda cancelada", "erro")
  }, [avisar, venda.itens.length, voltarParaBusca])

  // -------------------------------------------------------------------------
  // Teclado global — tudo passa por aqui para a lógica ficar num só lugar.
  // -------------------------------------------------------------------------
  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      const { key, altKey, ctrlKey, shiftKey } = evento

      if (pix) {
        if (key === "Escape" && !pix.concluida) {
          evento.preventDefault()
          setPix(null)
          avisar("Pagamento por Pix cancelado — nada foi gravado", "erro")
        } else if (key === "Enter" && pix.concluida) {
          evento.preventDefault()
          avisar(`Venda #${pix.concluida.numero} paga por Pix`, "sucesso")
          setPix(null)
        }
        return
      }

      if (comprovante) {
        if (key === "Escape" || key === "Enter") {
          evento.preventDefault()
          // Não deixa fechar no meio da emissão, para o operador não perder o código.
          if (!comprovante.emitindo) setComprovante(null)
        }
        return
      }

      // Cliente e condição têm handler próprio em captura; aqui só saímos.
      if (clienteAberto || condicaoAberta) return

      if (ajudaAberta) {
        if (key === "Escape" || key === "F1" || key === "?") {
          evento.preventDefault()
          setAjudaAberta(false)
        }
        return
      }

      // Shift+F<n> escolhe a forma de pagamento direto. A lista de teclas é
      // derivada de FORMAS_PAGAMENTO para não dessincronizar ao incluir formas.
      if (shiftKey && !ctrlKey && !altKey) {
        const posicao = FORMAS_PAGAMENTO.findIndex((_, i) => key === `F${i + 1}`)
        if (posicao >= 0) {
          evento.preventDefault()
          setForma(FORMAS_PAGAMENTO[posicao].id)
          return
        }
      }

      if (ctrlKey && !shiftKey && !altKey && key === "F6") {
        evento.preventDefault()
        alternarTema()
        return
      }

      // A operação da venda é toda sem modificador. Sair aqui evita que um
      // Ctrl+F10 do navegador finalize venda, ou que Ctrl+F1..F3 (navegação,
      // tratada em ~/lib/navegacao) também caia nos atalhos abaixo.
      if (ctrlKey || shiftKey || altKey || evento.metaKey) return

      switch (key) {
        case "F1":
          evento.preventDefault()
          setAjudaAberta(true)
          return
        case "F2":
          evento.preventDefault()
          voltarParaBusca()
          return
        case "F3":
          evento.preventDefault()
          pedirDesconto()
          return
        case "F4":
          evento.preventDefault()
          despachar({ tipo: "remover" })
          return
        case "F5":
          evento.preventDefault()
          pedirQuantidade()
          return
        case "F6":
          evento.preventDefault()
          setClienteErro(null)
          setClienteAberto(true)
          return
        case "F8":
          evento.preventDefault()
          setForma((atual) => {
            const i = FORMAS_PAGAMENTO.findIndex((f) => f.id === atual)
            return FORMAS_PAGAMENTO[(i + 1) % FORMAS_PAGAMENTO.length].id
          })
          return
        case "F9":
          evento.preventDefault()
          cancelarVenda()
          return
        case "F10":
          evento.preventDefault()
          if (modo === "recebido") confirmar()
          else iniciarPagamento()
          return
        case "Enter":
          evento.preventDefault()
          confirmar()
          return
        case "Escape":
          evento.preventDefault()
          if (modo !== "busca") {
            setRecebido(null)
            voltarParaBusca()
          } else {
            setEntrada("")
          }
          return
      }

      if (modo !== "busca") return

      if (key === "ArrowDown" || key === "ArrowUp") {
        evento.preventDefault()
        const delta = key === "ArrowDown" ? 1 : -1

        if (resultados.length > 0) {
          setIndiceResultado((atual) =>
            Math.min(Math.max(atual + delta, 0), resultados.length - 1)
          )
        } else if (entrada === "") {
          despachar({ tipo: "mover", delta })
        }
        return
      }

      // As teclas de edição rápida só valem com a busca vazia, senão atropelam
      // a digitação de uma descrição.
      if (entrada !== "") return

      if (key === "+" || key === "-") {
        evento.preventDefault()
        despachar({ tipo: "ajustarQuantidade", delta: key === "+" ? 1 : -1 })
        return
      }

      if (key === "Delete") {
        evento.preventDefault()
        despachar({ tipo: "remover" })
      }
    }

    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [
    ajudaAberta,
    clienteAberto,
    condicaoAberta,
    comprovante,
    pix,
    alternarTema,
    cancelarVenda,
    confirmar,
    entrada,
    iniciarPagamento,
    modo,
    pedirDesconto,
    pedirQuantidade,
    resultados.length,
    voltarParaBusca,
  ])

  const atalhos: Atalho[] = [
    { tecla: "F1", rotulo: "Ajuda", acao: () => setAjudaAberta(true) },
    {
      tecla: "F3",
      rotulo: "Desconto",
      acao: pedirDesconto,
      desabilitado: venda.itens.length === 0,
    },
    {
      tecla: "F4",
      rotulo: "Remover item",
      acao: () => despachar({ tipo: "remover" }),
      desabilitado: venda.indiceAtivo < 0,
    },
    {
      tecla: "F5",
      rotulo: "Alterar qtd",
      acao: pedirQuantidade,
      desabilitado: venda.indiceAtivo < 0,
    },
    {
      tecla: "F6",
      rotulo: cliente ? "Trocar cliente" : "Vincular cliente",
      acao: () => {
        setClienteErro(null)
        setClienteAberto(true)
      },
    },
    {
      tecla: "F9",
      rotulo: "Cancelar venda",
      acao: cancelarVenda,
      destrutivo: true,
      desabilitado: venda.itens.length === 0,
    },
  ]

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        caixa={CAIXA}
        operador={eu.nome}
        papel={eu.papel}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternarTema}
      >
        <span>{produtos.length.toLocaleString("pt-BR")} produtos</span>
      </Topo>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <BarraComando
            ref={campo}
            modo={modo}
            valor={entrada}
            onValorChange={setEntrada}
            onBlur={devolverFoco}
            resultados={resultados}
            indiceResultado={indiceResultado}
            onEscolherResultado={(i) => {
              setIndiceResultado(i)
              confirmar()
            }}
            multiplicador={comando.tipo === "vazio" ? 1 : comando.quantidade}
          />
          <ListaItens
            itens={venda.itens}
            indiceAtivo={venda.indiceAtivo}
            onSelecionar={(i) => despachar({ tipo: "selecionar", indice: i })}
          />

          <BarraAtalhos atalhos={atalhos} />

          <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs">
            <span className="text-muted-foreground">
              <b className="font-semibold text-foreground">{venda.itens.length}</b>{" "}
              {venda.itens.length === 1 ? "item" : "itens"} · use{" "}
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> para navegar e <Kbd>+</Kbd> <Kbd>−</Kbd> para a
              quantidade
            </span>
            {aviso ? (
              <span
                className={cn(
                  "font-medium",
                  aviso.tipo === "erro" ? "text-destructive" : "text-foreground"
                )}
                role="status"
              >
                {aviso.texto}
              </span>
            ) : null}
          </div>
        </section>

        <PainelPagamento
          subtotal={totais.subtotal}
          desconto={totais.desconto}
          total={totais.total}
          volumes={totais.volumes}
          forma={forma}
          onFormaChange={setForma}
          // No modo recebido o troco acompanha a digitação, sem esperar o Enter.
          recebido={modo === "recebido" ? interpretarValor(entrada) : recebido}
          onFinalizar={() => (modo === "recebido" ? confirmar() : iniciarPagamento())}
          finalizando={modo === "recebido"}
          gravando={gravando}
          cliente={cliente}
          condicao={condicao}
        />
      </div>

      {clienteAberto ? (
        <ClienteDialogo
          clientes={todosClientes}
          selecionado={cliente}
          gravando={gravando}
          erro={clienteErro}
          onEscolher={(escolhido) => {
            setCliente(escolhido)
            setClienteAberto(false)
            avisar(`Cliente ${escolhido.nome} vinculado`, "sucesso")
          }}
          onDesvincular={() => {
            setCliente(null)
            setClienteAberto(false)
            avisar("Cliente desvinculado", "erro")
          }}
          onCriar={(dados) => {
            setClienteErro(null)
            fetcher.submit(dados, { method: "post" })
          }}
          onFechar={() => setClienteAberto(false)}
        />
      ) : null}

      {condicaoAberta && cliente ? (
        <CondicaoDialogo
          total={totais.total}
          cliente={cliente}
          onEscolher={(escolhida) => {
            setCondicao(escolhida)
            setCondicaoAberta(false)
            concluir(null, escolhida)
          }}
          onFechar={() => {
            setCondicaoAberta(false)
            avisar("Venda a prazo cancelada — escolha a condição para fechar", "erro")
          }}
        />
      ) : null}

      {pix ? (
        <PixDialogo
          cobranca={pix.cobranca}
          criando={pix.criando}
          erro={pix.erro}
          concluida={pix.concluida}
          motivoPendente={pix.motivoPendente}
          onConferir={() => {
            if (pix.cobranca) conferirPix(pix.cobranca.txid)
          }}
          conferindo={fetcherPix.state !== "idle"}
          onCancelar={() => {
            setPix(null)
            avisar("Pagamento por Pix cancelado — nada foi gravado", "erro")
          }}
          onConcluir={() => {
            if (pix.concluida) avisar(`Venda #${pix.concluida.numero} paga por Pix`, "sucesso")
            setPix(null)
          }}
        />
      ) : null}

      {comprovante ? (
        <CobrancaDialogo
          vendaNumero={comprovante.vendaNumero}
          vendaId={comprovante.vendaId}
          cobrancas={comprovante.cobrancas}
          erro={comprovante.erro}
          emitindo={comprovante.emitindo}
          onFechar={() => setComprovante(null)}
        />
      ) : null}

      {ajudaAberta ? <AjudaAtalhos onFechar={() => setAjudaAberta(false)} /> : null}
    </main>
  )
}
