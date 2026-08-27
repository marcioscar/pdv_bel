import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { data, redirect, useFetcher } from "react-router"

import type { Route } from "./+types/pdv"
import { AjudaAtalhos } from "~/components/pdv/ajuda-atalhos"
import { ClienteDialogo, type ClienteResumo } from "~/components/pdv/cliente-dialogo"
import { CobrancaDialogo } from "~/components/pdv/cobranca-dialogo"
import { CondicaoDialogo } from "~/components/pdv/condicao-dialogo"
import { BarraAtalhos, type Atalho } from "~/components/pdv/barra-atalhos"
import { BarraComando, type ModoComando } from "~/components/pdv/barra-comando"
import { ListaItens } from "~/components/pdv/lista-itens"
import { PixDialogo, type PixNoBalcao } from "~/components/pdv/pix-dialogo"
import { AutorizacaoDialogo, type Bloqueio } from "~/components/pdv/autorizacao-dialogo"
import { FinalizarDialogo } from "~/components/pdv/finalizar-dialogo"
import { PainelPagamento } from "~/components/pdv/painel-pagamento"
import { Topo } from "~/components/pdv/topo"
import { Kbd } from "~/components/ui/kbd"
import { caixaAberto } from "~/lib/caixa.server"
import { diaDeHoje } from "~/lib/dia"
import {
  avaliarVenda,
  avisarPedidoPendente,
  decidirAutorizacao,
  dividaDoCliente,
  pedirAutorizacao,
  recusaPorFaltaDeLiberacao,
} from "~/lib/autorizacao.server"
import { db } from "~/lib/db.server"
import { enderecoDoApp } from "~/lib/env.server"
import { criarCliente, lerCliente, listarClientes } from "~/lib/clientes.server"
import { emitirParaVenda, type CobrancaDaVenda } from "~/lib/cobranca.server"
import { saldosPorProduto } from "~/lib/estoque.server"
import { contaDaLoja } from "~/lib/lojas.server"
import { SOMENTE_ATIVOS } from "~/lib/produtos.server"
import { autenticar, exigirUsuario } from "~/lib/sessao.server"
import { lerPedido, precificar, registrarVenda } from "~/lib/vendas.server"
import { vendedoresDaLoja } from "~/lib/vendedores.server"
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
import {
  aprovacaoValida,
  formaEstendeCredito,
} from "~/lib/autorizacao"
import { imprimirDocumento } from "~/lib/impressao"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { ACOES_DE_GERENTE, ehGerente } from "~/lib/permissoes"
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

/** Espera entre um documento e o outro na impressão em sequência. */
const ENTRE_IMPRESSOES = 1500

/**
 * Imprime vários documentos um após o outro.
 *
 * `imprimirDocumento` resolve assim que o iframe é montado, não quando a caixa
 * de impressão fecha — então dois disparos seguidos abrem dois diálogos ao mesmo
 * tempo e um se perde. O intervalo dá tempo de o primeiro assumir o foco.
 *
 * Com o Chrome do caixa em `--kiosk-printing` não há diálogo nenhum, e a espera
 * só separa os dois trabalhos na fila da impressora.
 */
async function imprimirEmSequencia(urls: string[]): Promise<string | null> {
  let problema: string | null = null

  for (const [indice, url] of urls.entries()) {
    if (indice > 0) {
      await new Promise((pronto) => setTimeout(pronto, ENTRE_IMPRESSOES))
    }
    const erro = await imprimirDocumento(url)
    // Guarda o primeiro erro e segue: falhar o comprovante não pode impedir o
    // cupom, que é o papel que o cliente leva.
    if (erro && !problema) problema = erro
  }

  return problema
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  /**
   * Abrir o caixa é a primeira coisa do dia, antes de qualquer venda.
   *
   * O redirecionamento é a única forma que funciona: um aviso na tela seria
   * fechado sem ser lido, e o dia inteiro correria com a gaveta sem ponto de
   * partida — a conferência da noite acusaria falta do valor do troco, e depois
   * de algumas noites assim ninguém mais confere.
   *
   * Custa uma consulta por carregamento do caixa, e é uma busca por índice que
   * para no primeiro documento. A tela de abertura volta para cá sozinha.
   */
  if (!(await caixaAberto(eu.loja, diaDeHoje()))) {
    throw redirect("/fechamento?abrir=caixa")
  }

  // O catálogo inteiro vai para o cliente para a busca responder sem latência
  // por tecla. Acima de ~5 mil produtos, trocar por busca no servidor.
  const [cadastro, saldos, clientes, vendedores] = await Promise.all([
    db.produto.findMany({ where: SOMENTE_ATIVOS, orderBy: { descricao: "asc" } }),
    saldosPorProduto(eu.loja),
    listarClientes(),
    // Poucos nomes, e vão inteiros para a tela pelo mesmo motivo do catálogo: o
    // caixa não pode esperar a rede para ver de quem é a comissão que digitou.
    vendedoresDaLoja(eu.loja),
  ])

  // O estoque não é um campo do produto: é a soma dos movimentos.
  const produtos = cadastro.map((produto) => ({
    ...produto,
    estoque: saldos.get(produto.id) ?? 0,
  }))

  /**
   * `?retomar=<id>` traz de volta o carrinho de uma venda que o gerente liberou.
   *
   * Só as do PRÓPRIO operador e só as aprovadas e no prazo: com o id de outro na
   * URL, qualquer um herdaria a liberação alheia. As quantidades voltam, os
   * preços não — quem precifica é o catálogo, na hora de gravar, como em toda
   * venda deste sistema.
   */
  const idParaRetomar = new URL(request.url).searchParams.get("retomar")
  const retomada = idParaRetomar
    ? await db.autorizacao
        .findFirst({ where: { id: idParaRetomar, solicitanteId: eu.id } })
        .then((a) => (a && aprovacaoValida(a) ? a : null))
        .catch(() => null)
    : null

  return {
    eu,
    produtos,
    vendedores,
    clientes: clientes.map((c) => ({
      id: c.id,
      nome: c.nome,
      cpfCnpj: c.cpfCnpj,
      cidade: c.cidade,
      uf: c.uf,
    })),
    retomada: retomada
      ? {
          id: retomada.id,
          desconto: retomada.desconto,
          clienteId: retomada.clienteId,
          itens: retomada.itens.map((item) => ({
            produtoId: item.produtoId,
            quantidade: item.quantidade,
          })),
        }
      : null,
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

  // --- Situação do cliente: alimenta o aviso mostrado ao vincular no carrinho ---
  if ((bruto as { intencao?: string })?.intencao === "situacaoCliente") {
    const clienteId = String((bruto as { clienteId?: string }).clienteId ?? "")
    const divida = await dividaDoCliente(clienteId || null)
    return {
      ok: true as const,
      tipo: "situacaoCliente" as const,
      clienteId,
      divida: {
        valor: divida.valor,
        parcelas: divida.parcelas,
        diasAtraso: divida.diasAtraso,
      },
    }
  }

  // --- Abre o pedido de liberação e guarda o carrinho para o vendedor retomar ---
  if ((bruto as { intencao?: string })?.intencao === "pedirAutorizacao") {
    const pedido = lerPedido(bruto)
    if (!pedido) {
      return data(
        { ok: false as const, tipo: "autorizacao" as const, erro: "Dados inválidos" },
        { status: 400 }
      )
    }

    // Os preços vêm do catálogo, como na venda: o gerente precisa decidir sobre
    // os mesmos números que serão cobrados, não sobre os que a tela mandou.
    const preco = await precificar(pedido.itens, pedido.desconto)
    if (!preco.ok) {
      return data(
        { ok: false as const, tipo: "autorizacao" as const, erro: preco.erro },
        { status: 400 }
      )
    }

    const avaliacao = await avaliarVenda({
      clienteId: pedido.clienteId,
      subtotal: preco.subtotal,
      desconto: pedido.desconto,
      forma: pedido.forma,
    })
    if (avaliacao.motivos.length === 0) {
      return data(
        {
          ok: false as const,
          tipo: "autorizacao" as const,
          erro: "Esta venda não precisa de liberação",
        },
        { status: 400 }
      )
    }

    const cliente = pedido.clienteId
      ? await db.cliente.findUnique({ where: { id: pedido.clienteId } })
      : null

    const criada = await pedirAutorizacao({
      loja: eu.loja,
      caixa: CAIXA,
      solicitanteId: eu.id,
      solicitante: eu.nome,
      motivos: avaliacao.motivos,
      itens: preco.itens,
      subtotal: preco.subtotal,
      desconto: pedido.desconto,
      total: preco.total,
      descontoPercentual: avaliacao.descontoPercentual,
      cliente: cliente
        ? { id: cliente.id, nome: cliente.nome, cpfCnpj: cliente.cpfCnpj }
        : null,
      divida: avaliacao.divida,
    })

    /**
     * Só ESTE caminho avisa. A liberação com a senha no caixa também cria um
     * pedido, mas nasce decidida: mandar o aviso ali faria o celular do gerente
     * apitar sobre uma venda que ele mesmo acabou de liberar de pé no balcão.
     *
     * Em segundo plano, e não `await`: o vendedor recebe a confirmação no tempo
     * do banco, não no da rede do Telegram. Se o aviso falhar, o pedido continua
     * na fila — o gerente o vê ao abrir a tela.
     */
    avisarPedidoPendente(criada, new URL("/admin/autorizacoes", enderecoDoApp(request)).href)

    return { ok: true as const, tipo: "autorizacao" as const, autorizacaoId: criada.id }
  }

  /**
   * --- O gerente presente libera na hora, com a senha dele no próprio caixa ---
   *
   * Atalho para quando não há tempo de esperar o celular, e a saída para quando
   * ninguém responde. Vale o mesmo rastro do outro caminho: o pedido é criado e
   * decidido no mesmo instante, com `decididaOnde: "caixa"` — é o que permite
   * depois distinguir quem decide olhando a venda de quem libera tudo de longe.
   *
   * A senha do gerente NÃO troca a sessão: quem está logado continua sendo o
   * vendedor, e a venda sai no nome dele. Trocar a sessão faria o histórico
   * dizer que foi o gerente quem vendeu.
   */
  if ((bruto as { intencao?: string })?.intencao === "autorizarNoCaixa") {
    const corpo = bruto as { email?: string; senha?: string }
    const pedido = lerPedido(bruto)
    if (!pedido || typeof corpo.email !== "string" || typeof corpo.senha !== "string") {
      return data(
        { ok: false as const, tipo: "autorizacao" as const, erro: "Dados inválidos" },
        { status: 400 }
      )
    }

    const login = await autenticar(corpo.email, corpo.senha)
    if (!login.ok) {
      return data(
        { ok: false as const, tipo: "autorizacao" as const, erro: login.erro },
        { status: 401 }
      )
    }

    const gerente = await db.usuario.findUnique({ where: { id: login.usuarioId } })
    if (!gerente || !ehGerente(gerente.papel)) {
      return data(
        {
          ok: false as const,
          tipo: "autorizacao" as const,
          erro: ACOES_DE_GERENTE.decidirAutorizacoes,
        },
        { status: 403 }
      )
    }

    const preco = await precificar(pedido.itens, pedido.desconto)
    if (!preco.ok) {
      return data(
        { ok: false as const, tipo: "autorizacao" as const, erro: preco.erro },
        { status: 400 }
      )
    }

    const avaliacao = await avaliarVenda({
      clienteId: pedido.clienteId,
      subtotal: preco.subtotal,
      desconto: pedido.desconto,
      forma: pedido.forma,
    })
    if (avaliacao.motivos.length === 0) {
      return data(
        {
          ok: false as const,
          tipo: "autorizacao" as const,
          erro: "Esta venda não precisa de liberação",
        },
        { status: 400 }
      )
    }

    const cliente = pedido.clienteId
      ? await db.cliente.findUnique({ where: { id: pedido.clienteId } })
      : null

    const criada = await pedirAutorizacao({
      loja: eu.loja,
      caixa: CAIXA,
      solicitanteId: eu.id,
      solicitante: eu.nome,
      motivos: avaliacao.motivos,
      itens: preco.itens,
      subtotal: preco.subtotal,
      desconto: pedido.desconto,
      total: preco.total,
      descontoPercentual: avaliacao.descontoPercentual,
      cliente: cliente
        ? { id: cliente.id, nome: cliente.nome, cpfCnpj: cliente.cpfCnpj }
        : null,
      divida: avaliacao.divida,
    })

    await decidirAutorizacao({
      id: criada.id,
      decisao: "aprovada",
      quem: { id: gerente.id, nome: gerente.nome },
      onde: "caixa",
      observacao: null,
    })

    return {
      ok: true as const,
      tipo: "autorizadaNoCaixa" as const,
      autorizacaoId: criada.id,
      gerente: gerente.nome,
    }
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

    /**
     * A trava do gerente entra AQUI, antes de existir um QR na tela.
     *
     * No Pix a venda só é gravada depois de o banco confirmar o pagamento. Se a
     * regra fosse cobrada lá, o cliente pagaria e a venda seria recusada em
     * seguida — dinheiro recebido sem venda, que é o pior desfecho possível no
     * balcão. Recusar antes do QR custa uma consulta; recusar depois custa um
     * estorno.
     */
    /**
     * Caixa fechado barra ANTES de existir QR na tela, pelo mesmo motivo da
     * liberação do gerente: a venda em Pix só é gravada depois de o banco
     * confirmar, e recusar lá deixaria o cliente pagando uma venda que não
     * entra.
     */
    if (!(await caixaAberto(eu.loja, diaDeHoje()))) {
      return data(
        {
          ok: false as const,
          tipo: "pix" as const,
          erro: `O caixa de ${eu.loja} não foi aberto hoje — lance o troco da gaveta antes de vender`,
        },
        { status: 400 }
      )
    }

    const recusa = await recusaPorFaltaDeLiberacao({
      clienteId: pedido.clienteId,
      desconto: pedido.desconto,
      forma: pedido.forma,
      subtotal: preco.subtotal,
    })
    if (recusa) return data(recusa, { status: 400 })

    try {
      const cobranca = await criarPixImediato({
        // A chave Pix é da conta da loja: cobrar na conta errada põe o dinheiro
        // no CNPJ errado.
        conta: await contaDaLoja(eu.loja),
        txid: novoTxid(),
        valor: preco.total,
        expiracaoSegundos: 900,
        solicitacao: `${eu.loja} caixa ${CAIXA} - BrasSaco Embalagens`,
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

    const pix = await consultarPixImediato(txid, await contaDaLoja(eu.loja))
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
      loja: eu.loja,
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
      vendaId: resultado.vendaId,
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

  const resultado = await registrarVenda({
    ...pedido,
    loja: eu.loja,
    caixa: CAIXA,
    operador: eu.nome,
  })

  if (resultado.ok) return { ...resultado, tipo: "venda" as const }

  // A recusa por falta de liberação tem tipo próprio: a tela abre o diálogo com
  // a dívida em vez de piscar uma mensagem de erro na barra de status.
  if ("precisaAutorizacao" in resultado) {
    return data(
      {
        ok: false as const,
        tipo: "bloqueio" as const,
        erro: resultado.erro,
        motivos: resultado.motivos,
        divida: resultado.divida,
        descontoPercentual: resultado.descontoPercentual,
      },
      { status: 400 }
    )
  }

  return data(
    { ok: false as const, tipo: "venda" as const, erro: resultado.erro },
    { status: 400 }
  )
}

// O catálogo não muda durante o expediente; revalidar depois de cada venda
// reenviaria os mil e poucos produtos sem motivo. Recarregar a página atualiza.
export function shouldRevalidate() {
  return false
}

type Aviso = { texto: string; tipo: "erro" | "sucesso" } | null

export default function Pdv({ loaderData }: Route.ComponentProps) {
  const { eu, produtos, clientes, retomada, vendedores } = loaderData

  const [venda, despachar] = useReducer(reduzirVenda, vendaVazia)
  const [entrada, setEntrada] = useState("")
  const [modo, setModo] = useState<ModoComando>("busca")
  const [indiceResultado, setIndiceResultado] = useState(0)
  /**
   * Pix é o padrão do balcão hoje — é a forma que mais sai, então é ela que abre
   * marcada. Volta a Pix a cada venda nova, não a cada abertura da conferência:
   * assim quem pré-escolhe com ⇧F3 enquanto passa os produtos não perde a escolha
   * ao apertar F10.
   */
  const [forma, setForma] = useState<FormaPagamento>("pix")
  // A finalização virou uma tela de conferência: abre com tudo decidido, e o
  // Enter grava. O valor recebido passou a ser digitado nela, não na barra de
  // comando — assim a barra volta a ser só busca de produto.
  const [finalizando, setFinalizando] = useState(false)
  const [recebidoTexto, setRecebidoTexto] = useState("")
  // Nasce vazio a cada venda, de propósito: ver `faltaVendedor` no diálogo.
  const [vendedorCodigo, setVendedorCodigo] = useState("")
  const [imprimirCupom, setImprimirCupom] = useState(true)
  const [erroFinalizacao, setErroFinalizacao] = useState<string | null>(null)
  const [ajudaAberta, setAjudaAberta] = useState(false)
  const [aviso, setAviso] = useState<Aviso>(null)
  const [cliente, setCliente] = useState<ClienteResumo | null>(null)
  const [clienteAberto, setClienteAberto] = useState(false)
  // Vindo da conferência, o cadastro abre direto no formulário: a busca já foi
  // feita no combobox de lá.
  const [cadastroDireto, setCadastroDireto] = useState(false)
  const [clienteErro, setClienteErro] = useState<string | null>(null)
  // Clientes criados nesta sessão: o loader não revalida (shouldRevalidate=false)
  // para não reenviar o catálogo inteiro, então mantemos os novos aqui.
  const [novosClientes, setNovosClientes] = useState<ClienteResumo[]>([])
  // Condição escolhida na venda a prazo. Fica guardada para o painel mostrar o
  // prazo enquanto a venda é fechada; o servidor recalcula as datas na gravação.
  /**
   * A liberação do gerente que acompanha esta venda.
   *
   * Vem de dois lugares: de `?retomar=`, quando o vendedor volta a uma venda que
   * o gerente aprovou pelo app, ou da senha digitada no caixa. Vai junto no
   * payload da venda — o servidor confere de novo, porque um id vindo do
   * navegador não prova nada sozinho.
   */
  const [autorizacaoId, setAutorizacaoId] = useState<string | null>(null)
  /**
   * A situação do cliente, num fetcher só dela.
   *
   * Separado do principal porque a pergunta é feita ao vincular o cliente, no
   * meio da montagem do carrinho — e ela não pode disputar o mesmo fetcher com
   * a gravação da venda, que é o que aquele carrega.
   */
  const fetcherSituacao = useFetcher<typeof action>()

  /**
   * Dá baixa na liberação que acompanhava o carrinho.
   *
   * Chamada às cegas sempre que o carrinho esvazia — por venda gravada ou por
   * cancelamento —, porque a tela não tem como saber se a autorização foi
   * consumida: quem decide isso é a gravação, no servidor. A baixa filtra por
   * situação, então numa já "usada" ela não faz nada. Sem isto, a liberação de
   * uma venda abandonada ficava viva por doze horas, com o aviso no topo
   * oferecendo retomar uma venda que ninguém ia fechar.
   */
  const fetcherBaixa = useFetcher()
  const darBaixaNaLiberacao = useCallback(
    (id: string | null) => {
      if (!id) return
      fetcherBaixa.submit({ id }, { method: "post", action: "/autorizacoes" })
    },
    [fetcherBaixa]
  )

  const [bloqueio, setBloqueio] = useState<Bloqueio | null>(null)
  const [autorizacaoErro, setAutorizacaoErro] = useState<string | null>(null)

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
    if (
      !ajudaAberta &&
      !clienteAberto &&
      !comprovante &&
      !pix &&
      !condicaoAberta &&
      !finalizando
    ) {
      focar()
    }
  }, [ajudaAberta, clienteAberto, comprovante, pix, condicaoAberta, finalizando, modo, focar])

  // Clicar num botão de atalho tira o foco do campo; devolvemos no frame seguinte
  // para que a próxima tecla continue caindo na barra de comando.
  const devolverFoco = useCallback(() => {
    if (ajudaAberta || clienteAberto || condicaoAberta || finalizando) return
    requestAnimationFrame(focar)
  }, [ajudaAberta, clienteAberto, condicaoAberta, finalizando, focar])

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
      tentativa.current = { recebido: valorRecebido, condicao: condicaoEscolhida }

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
          vendedorCodigo,
          autorizacaoId,
        },
        { method: "post", encType: "application/json" }
      )
    },
    [
      autorizacaoId, cliente, fetcher, forma, gravando, totais.desconto, venda.itens,
      vendedorCodigo,
    ]
  )

  /**
   * O carrinho como o servidor precisa ver para decidir sobre a liberação — os
   * mesmos campos da venda, porque é a mesma venda que ele vai avaliar.
   */
  /**
   * Como o fechamento foi tentado antes de esbarrar na trava.
   *
   * Guardado para o vendedor não ter de digitar tudo de novo depois de o gerente
   * liberar: o valor recebido em dinheiro e a condição do prazo já foram
   * informados uma vez, com o cliente esperando.
   */
  const tentativa = useRef<{
    recebido: number | null
    condicao: CondicaoPagamento | null
  } | null>(null)
  const refazerAposLiberar = useRef(false)

  const pedidoDaAutorizacao = useCallback(
    () => ({
      itens: venda.itens.map((item) => ({
        produtoId: item.produtoId,
        quantidade: item.quantidade,
      })),
      desconto: totais.desconto,
      forma,
      recebido: null,
      clienteId: cliente?.id ?? null,
    }),
    [cliente, forma, totais.desconto, venda.itens]
  )

  const pedirLiberacao = useCallback(() => {
    fetcher.submit(
      { intencao: "pedirAutorizacao", ...pedidoDaAutorizacao() },
      { method: "post", encType: "application/json" }
    )
  }, [fetcher, pedidoDaAutorizacao])

  const liberarNoCaixa = useCallback(
    (email: string, senha: string) => {
      fetcher.submit(
        { intencao: "autorizarNoCaixa", email, senha, ...pedidoDaAutorizacao() },
        { method: "post", encType: "application/json" }
      )
    },
    [fetcher, pedidoDaAutorizacao]
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
      setCadastroDireto(false)
      setErroFinalizacao(null)
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

    // O pedido foi para a fila: o caixa é liberado para o próximo cliente, e o
    // carrinho fica guardado no servidor até o gerente responder.
    if (resposta.tipo === "autorizacao") {
      if (!resposta.ok) {
        setAutorizacaoErro(resposta.erro)
        return
      }
      setBloqueio(null)
      setAutorizacaoErro(null)
      setAutorizacaoId(null)
      despachar({ tipo: "limpar" })
      setModo("busca")
      setEntrada("")
      setCliente(null)
      setCondicao(null)
      setFinalizando(false)
      setRecebidoTexto("")
      avisar(
        "Pedido enviado ao gerente — o carrinho está guardado em Minhas autorizações",
        "sucesso"
      )
      return
    }

    // O gerente liberou ali mesmo: guarda a permissão e fecha a venda na hora,
    // sem obrigar o vendedor a apertar "finalizar" de novo com o cliente esperando.
    if (resposta.tipo === "autorizadaNoCaixa") {
      setAutorizacaoId(resposta.autorizacaoId)
      setBloqueio(null)
      setAutorizacaoErro(null)
      // O fechamento é refeito sozinho no efeito abaixo: obrigar o vendedor a
      // apertar Enter de novo, com o gerente ainda de pé ao lado dele, seria
      // teatro. Ele já disse o que queria fazer antes de a trava aparecer.
      refazerAposLiberar.current = true
      avisar(`Liberado por ${resposta.gerente}`, "sucesso")
      return
    }

    // Recusa com saída: não é erro do vendedor, é a regra da casa batendo. Abre
    // o diálogo com a dívida na mão em vez de piscar uma mensagem na barra.
    if (resposta.tipo === "bloqueio") {
      setBloqueio({
        motivos: resposta.motivos,
        divida: resposta.divida,
        descontoPercentual: resposta.descontoPercentual,
      })
      setAutorizacaoErro(null)
      setPix(null)
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
    setModo("busca")
    setEntrada("")
    setCliente(null)
    setCondicao(null)
    setForma("pix")
    setFinalizando(false)
    setRecebidoTexto("")
    // A liberação vale para uma venda só; deixá-la no estado faria a próxima
    // venda nascer com a permissão da anterior. A baixa cobre o caso em que a
    // venda fechou SEM precisar dela (o vendedor tirou o desconto, ou trocou o
    // prazo por Pix): aí ela não foi consumida e sobraria válida.
    darBaixaNaLiberacao(autorizacaoId)
    setAutorizacaoId(null)
    setBloqueio(null)

    // O cupom sai depois de a venda existir: imprimir antes de gravar entregaria
    // ao cliente um documento de uma venda que pode ter falhado.
    if (imprimirCupom) {
      imprimirDocumento(`/vendas/${resposta.vendaId}/cupom`).then((erro) => {
        if (erro) avisar(erro, "erro")
      })
    }

    avisar(
      troco > 0
        ? `Venda #${numero} registrada · troco ${moeda(troco)}`
        : `Venda #${numero} registrada`,
      "sucesso"
    )
    // `autorizacaoId` entra nas dependências para a baixa usar o id do render
    // corrente; a guarda de `ultimaResposta` torna re-execuções inócuas.
  }, [fetcher.state, fetcher.data, avisar, fetcher, forma, autorizacaoId, darBaixaNaLiberacao])

  /**
   * Refaz o fechamento assim que a liberação entra no estado.
   *
   * Num efeito, e não logo depois do `setAutorizacaoId`: o estado do React só
   * chega no próximo render, e `concluir` chamado ali ainda mandaria
   * `autorizacaoId: null` — a venda seria recusada de novo, com o gerente
   * olhando. Aqui `concluir` já foi recriado com o id novo.
   */
  useEffect(() => {
    if (!autorizacaoId || !refazerAposLiberar.current) return
    refazerAposLiberar.current = false

    // O Pix não tem o que refazer: o QR nem chegou a ser criado, porque a trava
    // é cobrada antes disso. Recomeça o fluxo do zero.
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

    concluir(tentativa.current?.recebido ?? null, tentativa.current?.condicao ?? null)
  }, [autorizacaoId, concluir, fetcher, forma, totais.desconto, venda.itens])

  /**
   * Pergunta a situação do cliente assim que ele entra na venda.
   *
   * Aqui, e não no fechamento: com o aviso na tela desde o começo, o vendedor
   * conversa sobre o atrasado enquanto monta o carrinho. Descobrir a trava
   * depois de bipar trinta itens é descobrir tarde.
   */
  const clienteId = cliente?.id ?? null
  useEffect(() => {
    if (!clienteId) return
    fetcherSituacao.submit(
      { intencao: "situacaoCliente", clienteId },
      { method: "post", encType: "application/json" }
    )
    // `fetcherSituacao` muda de identidade a cada render; o que dispara a
    // pergunta é o cliente ter mudado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteId])

  /**
   * A dívida do cliente que está NA venda agora.
   *
   * A conferência do id importa: a resposta é assíncrona, e sem ela a dívida do
   * cliente anterior apareceria por um instante sob o nome do novo — no balcão,
   * acusar o cliente errado de caloteiro é o pior defeito possível desta tela.
   */
  const dividaDoClienteNaVenda =
    fetcherSituacao.data?.tipo === "situacaoCliente" &&
    fetcherSituacao.data.clienteId === clienteId &&
    fetcherSituacao.data.divida.parcelas > 0
      ? fetcherSituacao.data.divida
      : null

  /**
   * Traz de volta o carrinho da venda que o gerente liberou.
   *
   * Roda uma vez, no primeiro render em que os produtos existem: o `ref` impede
   * que uma revalidação recarregue os itens por cima de um carrinho que o
   * vendedor já começou a mexer.
   */
  const jaRetomou = useRef(false)
  useEffect(() => {
    if (!retomada || jaRetomou.current) return
    jaRetomou.current = true

    for (const item of retomada.itens) {
      const produto = produtos.find((p) => p.id === item.produtoId)
      // Produto desativado desde o pedido simplesmente não volta: vendê-lo agora
      // seria ressuscitar do carrinho o que saiu do catálogo.
      if (produto) despachar({ tipo: "adicionar", produto, quantidade: item.quantidade })
    }
    if (retomada.desconto > 0) {
      despachar({ tipo: "definirDesconto", valor: retomada.desconto })
    }
    if (retomada.clienteId) {
      const escolhido = clientes.find((c) => c.id === retomada.clienteId)
      if (escolhido) setCliente(escolhido)
    }
    setAutorizacaoId(retomada.id)
    avisar("Venda liberada pelo gerente — carrinho retomado", "sucesso")
  }, [avisar, clientes, produtos, retomada])

  /**
   * Consulta o pagamento enquanto o QR está na tela.
   *
   * `setInterval` com ref, e não um `setTimeout` reagendado pelo próprio efeito:
   * o reagendamento dependia de a identidade do objeto do fetcher mudar a cada
   * resposta. Quando ela não muda, o efeito não re-executa e o polling morre
   * depois da primeira consulta — foi o que aconteceu, e a venda paga nunca era
   * registrada. O intervalo dispara independente de re-render.
   */
  const dadosDaConsulta = useRef({
    fetcher: fetcherPix,
    itens: venda.itens,
    desconto: 0,
    vendedorCodigo: "",
  })
  dadosDaConsulta.current = {
    fetcher: fetcherPix,
    itens: venda.itens,
    desconto: totais.desconto,
    vendedorCodigo,
  }

  const conferirPix = useCallback((txid: string) => {
    const { fetcher: f, itens, desconto, vendedorCodigo } = dadosDaConsulta.current
    if (f.state !== "idle") return

    f.submit(
      {
        intencao: "pixConferir",
        txid,
        itens: itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade })),
        desconto,
        forma: "pix",
        recebido: null,
        vendedorCodigo,
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
    setModo("busca")
    setEntrada("")
    setFinalizando(false)
    setRecebidoTexto("")
    // O cliente sai junto, como nas outras formas: cada venda começa em
    // Consumidor Final. Só este caminho não limpava, e o cliente da venda
    // anterior seguia grudado na próxima sem ninguém notar.
    setCliente(null)
    setForma("pix")

    /**
     * Pix pago sai com DOIS papéis: o comprovante do recebimento e o cupom.
     *
     * São coisas diferentes — um diz que o dinheiro entrou, o outro o que o
     * cliente levou — e quem paga por Pix costuma querer os dois, principalmente
     * quem paga por outra pessoa.
     *
     * Em sequência, e não ao mesmo tempo: `imprimirDocumento` devolve o controle
     * antes de a caixa de impressão abrir, então disparar os dois juntos põe dois
     * diálogos brigando pelo foco, e um deles se perde. O comprovante vem
     * primeiro porque é o que o cliente confere ali, com o celular na mão.
     */
    imprimirEmSequencia([
      `/vendas/${r.vendaId}/comprovante-pix`,
      ...(imprimirCupom ? [`/vendas/${r.vendaId}/cupom`] : []),
    ]).then((erro) => {
      if (erro) avisar(erro, "erro")
    })

    setPix((atual) =>
      atual ? { ...atual, concluida: { numero: r.numero, pagoEm: r.pagoEm }, motivoPendente: null } : atual
    )
  }, [fetcherPix.state, fetcherPix.data, imprimirCupom, avisar])

  /**
   * A prazo o comprovante é o boleto, que o próprio comprovante manda imprimir —
   * ligar o cupom junto empilharia duas caixas de impressão a cada venda. Nas
   * outras formas o cupom é o único documento, então vem ligado.
   *
   * Trocar a forma redefine este padrão: é previsível, e quem quiser os dois
   * documentos liga com F7 depois de escolher a forma.
   */
  const cupomPadrao = (f: FormaPagamento) => f !== "prazo"

  /** F10: abre a conferência. Nada é gravado aqui. */
  const abrirFinalizacao = useCallback(() => {
    if (venda.itens.length === 0) {
      avisar("Nenhum item na venda", "erro")
      return
    }
    setErroFinalizacao(null)
    setRecebidoTexto("")
    // Sempre em branco: é aqui que se garante que a comissão nunca herda o
    // vendedor da venda anterior. Quem fecha é um caixa fixo, e quem vendeu
    // muda de cliente para cliente.
    setVendedorCodigo("")
    setImprimirCupom(cupomPadrao(forma))
    setFinalizando(true)
  }, [avisar, forma, venda.itens.length])

  /** Enter na conferência: daqui em diante grava (ou abre Pix/prazo). */
  const confirmarFinalizacao = useCallback(() => {
    if (gravando) return
    setErroFinalizacao(null)

    if (forma === "dinheiro") {
      const valor = interpretarValor(recebidoTexto)
      if (valor === null) {
        setErroFinalizacao("Informe o valor recebido")
        return
      }
      if (valor < totais.total) {
        setErroFinalizacao(`Faltam ${moeda(totais.total - valor)}`)
        return
      }
      concluir(valor)
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
        setErroFinalizacao("Venda a prazo exige cliente — F6 escolhe aqui mesmo")
        setClienteAberto(true)
        return
      }
      // Nenhuma condição serve: nem o boleto de uma parcela chega ao mínimo.
      if (!CONDICOES_PAGAMENTO.some((c) => condicaoCabeNoTotal(c, totais.total))) {
        setErroFinalizacao(`Venda a prazo exige no mínimo ${moeda(VALOR_MINIMO_BOLETO)}`)
        return
      }
      setCondicaoAberta(true)
      return
    }
    concluir(null)
  }, [
    cliente,
    concluir,
    fetcher,
    forma,
    gravando,
    recebidoTexto,
    totais.desconto,
    totais.total,
    venda.itens,
  ])

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

    // modo === "desconto"
    if (valor > totais.subtotal) {
      avisar("Desconto maior que o subtotal", "erro")
      return
    }
    despachar({ tipo: "definirDesconto", valor })
    voltarParaBusca()
  }, [
    adicionar,
    avisar,
    comando,
    entrada,
    indiceResultado,
    modo,
    produtos,
    resultados,
    totais.subtotal,
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

  /**
   * O orçamento sai do carrinho como ele está, sem gravar nada.
   *
   * Só os ids e as quantidades vão na URL — quem precifica é o servidor, com o
   * mesmo `precificar` do fechamento. Mandar o preço da tela imprimiria para o
   * cliente um valor que o caixa não vai cobrar.
   */
  const imprimirOrcamento = useCallback(() => {
    if (venda.itens.length === 0) {
      avisar("Nenhum item para orçar", "erro")
      return
    }

    const params = new URLSearchParams()
    for (const item of venda.itens) params.append("i", `${item.produtoId}:${item.quantidade}`)
    if (totais.desconto > 0) params.set("desconto", String(totais.desconto))

    imprimirDocumento(`/orcamento/impressao?${params}`).then((erro) => {
      avisar(erro ?? "Orçamento enviado para a impressora", erro ? "erro" : "sucesso")
    })
  }, [avisar, totais.desconto, venda.itens])

  const cancelarVenda = useCallback(() => {
    if (venda.itens.length === 0) return
    // A liberação morre com a venda que ela liberava.
    darBaixaNaLiberacao(autorizacaoId)
    setAutorizacaoId(null)
    despachar({ tipo: "limpar" })
    setFinalizando(false)
    voltarParaBusca()
    avisar("Venda cancelada", "erro")
  }, [autorizacaoId, avisar, darBaixaNaLiberacao, venda.itens.length, voltarParaBusca])

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

      // Cliente, condição e finalização têm handler próprio em captura.
      if (clienteAberto || condicaoAberta || finalizando) return

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
        case "F7":
          evento.preventDefault()
          imprimirOrcamento()
          return
        case "F9":
          evento.preventDefault()
          cancelarVenda()
          return
        case "F10":
          evento.preventDefault()
          abrirFinalizacao()
          return
        case "Enter":
          evento.preventDefault()
          confirmar()
          return
        case "Escape":
          evento.preventDefault()
          if (modo !== "busca") {
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
    finalizando,
    pix,
    abrirFinalizacao,
    alternarTema,
    cancelarVenda,
    confirmar,
    entrada,
    imprimirOrcamento,
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
      tecla: "F7",
      rotulo: "Orçamento",
      acao: imprimirOrcamento,
      desabilitado: venda.itens.length === 0,
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
        operador={eu.nome}
        papel={eu.papel}
        loja={eu.loja}
        lojasPermitidas={eu.lojasPermitidas.length}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternarTema}
      />

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
          cliente={cliente}
          divida={dividaDoClienteNaVenda}
          aPrazo={formaEstendeCredito(forma)}
          gravando={gravando}
          onFinalizar={abrirFinalizacao}
          desabilitado={venda.itens.length === 0}
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
          onFechar={() => {
            setClienteAberto(false)
            setCadastroDireto(false)
          }}
          direto={cadastroDireto}
        />
      ) : null}

      {finalizando ? (
        <FinalizarDialogo
          total={totais.total}
          volumes={totais.volumes}
          itens={venda.itens.length}
          forma={forma}
          onFormaChange={(nova) => {
            setForma(nova)
            setImprimirCupom(cupomPadrao(nova))
            setErroFinalizacao(null)
          }}
          recebido={recebidoTexto}
          onRecebidoChange={(v) => {
            setRecebidoTexto(v)
            setErroFinalizacao(null)
          }}
          vendedorCodigo={vendedorCodigo}
          onVendedorCodigoChange={(codigo) => {
            setVendedorCodigo(codigo)
            setErroFinalizacao(null)
          }}
          vendedores={vendedores}
          cliente={cliente}
          clientes={todosClientes}
          onClienteChange={(escolhido) => {
            setCliente(escolhido)
            setErroFinalizacao(null)
          }}
          onCadastrarCliente={() => {
            setClienteErro(null)
            setCadastroDireto(true)
            setClienteAberto(true)
          }}
          imprimir={imprimirCupom}
          onImprimirChange={setImprimirCupom}
          gravando={gravando}
          erro={erroFinalizacao}
          onConfirmar={confirmarFinalizacao}
          onFechar={() => setFinalizando(false)}
          // Enquanto cliente, condição ou Pix estão por cima, ele não escuta.
          pausado={clienteAberto || condicaoAberta || Boolean(pix) || Boolean(comprovante)}
        />
      ) : null}

      {bloqueio ? (
        <AutorizacaoDialogo
          bloqueio={bloqueio}
          cliente={cliente}
          total={totais.total}
          enviando={gravando}
          erro={autorizacaoErro}
          onPedir={pedirLiberacao}
          onLiberarNoCaixa={liberarNoCaixa}
          onFechar={() => {
            setBloqueio(null)
            setAutorizacaoErro(null)
          }}
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
