import type { Prisma } from "@prisma/client"

import {
  avaliarVenda,
  conferirAutorizacao,
  marcarAutorizacaoUsada,
} from "~/lib/autorizacao.server"
import { caixaAberto } from "~/lib/caixa.server"
import { validarCpf } from "~/lib/documento"
import { db } from "~/lib/db.server"
import { depoisDoDia, diaAtras, diaDeHoje, inicioDoDia } from "~/lib/dia"
import { movimentosDeVenda, saldosDosProdutos } from "~/lib/estoque.server"
import { ultimoCustoPorProduto } from "~/lib/compras.server"
import { gastarCredito, saldoDeCredito } from "~/lib/creditos.server"
import { lojaPeloDocumento } from "~/lib/lojas.server"
import {
  arredondar,
  interpretarValor,
  moeda,
  quantidade as formatarQuantidade,
} from "~/lib/moeda"
import { vendedorPorCodigo, type VendedorDoBalcao } from "~/lib/vendedores.server"
import {
  condicaoCabeNoTotal,
  condicaoPorId,
  dividirParcelas,
  ehTransferenciaEntreLojas,
  FORMA_TRANSFERENCIA,
  FORMAS_PAGAMENTO,
  parcelasDaCondicao,
  precoAplicado,
  VALOR_MINIMO_BOLETO,
} from "~/lib/pdv"

export type ItemRecebido = { produtoId: string; quantidade: number }

/**
 * O que o navegador manda. Note que loja, caixa e operador NÃO estão aqui: eles
 * vêm da sessão, na rota. Se estivessem no payload, daria para escolher em que
 * loja gravar a venda — e a separação entre lojas viraria sugestão.
 */
export type PedidoRecebido = {
  itens: ItemRecebido[]
  desconto: number
  forma: string
  recebido: number | null
  /**
   * Quanto do total o cliente quer abater com o crédito que tem a favor.
   *
   * Vem da tela porque é escolha dele — às vezes ele prefere guardar o saldo.
   * Quanto ele TEM é conferido aqui no servidor, contra o livro: aceitar o
   * saldo do navegador seria deixar o valor a pagar ser escolhido no console.
   */
  creditoUsado: number
  clienteId: string | null
  /** CPF pedido na nota, sem cadastro. Só dígitos, ou null. */
  cpfNaNota: string | null
  /**
   * Id de uma condição de CONDICOES_PAGAMENTO; só usado na venda a prazo.
   *
   * A tela manda a condição escolhida, não as datas: os vencimentos são
   * calculados aqui. Aceitar datas do navegador deixaria o prazo combinado com o
   * cliente fora da política da empresa sem deixar rastro.
   */
  condicao: string | null
  /**
   * Código do vendedor que atendeu, para a comissão. Vai o CÓDIGO, e não o id
   * com o nome: quem diz a quem ele pertence é o banco, na gravação. Aceitar
   * id e nome do navegador deixaria creditar comissão a qualquer um.
   */
  vendedorCodigo: string
  /** Pix imediato: comprovante do pagamento já confirmado. */
  pixTxid?: string | null
  pixPagoEm?: Date | null
  /**
   * Liberação do gerente, quando a venda precisa de uma (cliente com boleto
   * vencido, desconto acima do teto). Vai o ID, e não um "autorizado: true": um
   * booleano vindo do navegador seria a autorização em si.
   */
  autorizacaoId?: string | null
}

/** O pedido completo: o que veio da tela mais o que só o servidor sabe. */
export type PedidoVenda = PedidoRecebido & {
  loja: string
  caixa: string
  operador: string
}

/** Espelha `type VendaItem` do schema: o item como fica gravado na venda. */
type ItemGravado = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  preco: number
  quantidade: number
  subtotal: number
}

export type ResultadoVenda =
  | { ok: true; numero: number; vendaId: string; total: number; troco: number }
  | { ok: false; erro: string }
  /**
   * Recusa que TEM saída: a venda não está errada, só precisa do gerente. Um
   * tipo à parte porque a tela reage de outro jeito — em vez de mostrar o erro
   * e parar, ela abre o pedido de autorização com a dívida na mão.
   */
  | {
      ok: false
      erro: string
      precisaAutorizacao: true
      motivos: string[]
      divida: { valor: number; parcelas: number; diasAtraso: number }
      descontoPercentual: number
    }

/** Um ObjectId malformado faria o Prisma lançar, virando 500 em vez de 400. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/** Só aceita o que o formato do payload garante; o resto é rejeitado. */
export function lerPedido(bruto: unknown): PedidoRecebido | null {
  if (typeof bruto !== "object" || bruto === null) return null
  const corpo = bruto as Record<string, unknown>

  if (!Array.isArray(corpo.itens)) return null

  const itens: ItemRecebido[] = []
  for (const item of corpo.itens) {
    if (typeof item !== "object" || item === null) return null
    const { produtoId, quantidade } = item as Record<string, unknown>
    if (typeof produtoId !== "string" || !OBJECT_ID.test(produtoId)) return null
    if (typeof quantidade !== "number" || !Number.isFinite(quantidade) || quantidade <= 0) {
      return null
    }
    itens.push({ produtoId, quantidade })
  }

  const desconto = typeof corpo.desconto === "number" ? corpo.desconto : 0
  if (!Number.isFinite(desconto) || desconto < 0) return null

  const recebido =
    corpo.recebido === null || corpo.recebido === undefined
      ? null
      : typeof corpo.recebido === "number" && Number.isFinite(corpo.recebido)
        ? corpo.recebido
        : NaN
  if (recebido !== null && Number.isNaN(recebido)) return null

  const creditoUsado = typeof corpo.creditoUsado === "number" ? corpo.creditoUsado : 0
  if (!Number.isFinite(creditoUsado) || creditoUsado < 0) return null

  const autorizacaoId =
    typeof corpo.autorizacaoId === "string" && OBJECT_ID.test(corpo.autorizacaoId)
      ? corpo.autorizacaoId
      : null

  /*
   * O CPF da nota é conferido AQUI, e não só na tela: um CPF com dígito errado
   * derruba a nota inteira na SEFAZ, e o erro apareceria depois da venda
   * fechada. Vazio é o caso comum e não é erro.
   */
  const cpfBruto =
    typeof corpo.cpfNaNota === "string" ? corpo.cpfNaNota.replace(/\D/g, "") : ""
  if (cpfBruto && !validarCpf(cpfBruto)) return null
  const cpfNaNota = cpfBruto || null

  const clienteId =
    typeof corpo.clienteId === "string" && OBJECT_ID.test(corpo.clienteId)
      ? corpo.clienteId
      : null
  // Um clienteId presente mas malformado é recusado, não silenciosamente ignorado.
  if (corpo.clienteId != null && clienteId === null) return null

  return {
    itens,
    desconto,
    forma: typeof corpo.forma === "string" ? corpo.forma : "",
    recebido,
    creditoUsado,
    clienteId,
    cpfNaNota,
    condicao: typeof corpo.condicao === "string" ? corpo.condicao : null,
    // Aceito como texto e conferido contra o banco na gravação: aqui só se
    // garante o formato, não de quem é o código.
    vendedorCodigo:
      typeof corpo.vendedorCodigo === "string" ? corpo.vendedorCodigo.trim().slice(0, 10) : "",
    autorizacaoId,
  }
}

export type Precificacao =
  | { ok: true; itens: ItemGravado[]; subtotal: number; total: number }
  | { ok: false; erro: string }

/**
 * Monta os itens com os preços do BANCO e calcula o total.
 *
 * O cliente só informa o que e quanto; preço e total nunca vêm dele. Extraído
 * para o fluxo do Pix usar o mesmo cálculo na criação da cobrança e na
 * confirmação — se fossem cálculos diferentes, dava para pagar um valor e
 * registrar outro.
 */
export async function precificar(
  itensRecebidos: ItemRecebido[],
  desconto: number
): Promise<Precificacao> {
  if (itensRecebidos.length === 0) return { ok: false, erro: "Venda sem itens" }

  const produtos = await db.produto.findMany({
    where: { id: { in: itensRecebidos.map((i) => i.produtoId) } },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const itens: ItemGravado[] = []
  for (const recebido of itensRecebidos) {
    const produto = porId.get(recebido.produtoId)
    if (!produto) return { ok: false, erro: "Produto não encontrado no catálogo" }

    // Mesma função do carrinho: a tela mostra o preço de combo quando a
    // quantidade alcança o degrau, e aqui ele é reaplicado sobre o preço do
    // banco. Recalcular com outra regra cobraria diferente do que foi mostrado.
    const { preco } = precoAplicado(produto, recebido.quantidade)

    itens.push({
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      preco,
      quantidade: recebido.quantidade,
      subtotal: arredondar(preco * recebido.quantidade),
    })
  }

  const subtotal = arredondar(itens.reduce((acc, item) => acc + item.subtotal, 0))
  if (desconto > subtotal) return { ok: false, erro: "Desconto maior que o subtotal" }

  return { ok: true, itens, subtotal, total: arredondar(subtotal - desconto) }
}

/**
 * Os mesmos itens, valorados pelo CUSTO — a nota que acompanha a mercadoria a
 * caminho de outra loja da rede.
 *
 * Não é venda, então não sai pelo preço de balcão: entre estabelecimentos não
 * há margem a realizar, e uma nota de transferência pelo preço de venda
 * declararia um lucro que não aconteceu. O custo vem da última compra conhecida
 * — nota conciliada, AF ou o histórico importado, o que for mais recente.
 *
 * Produto sem custo nenhum recusa a operação inteira, e não cai no preço de
 * venda calado: a nota é documento fiscal, e um valor inventado nela é pior que
 * não emitir. O erro nomeia os produtos, como o que falta NCM, porque a saída é
 * a mesma — ir ao cadastro e resolver.
 *
 * Não aceita desconto: desconto sobre custo em transferência não significa nada.
 */
export async function precificarAoCusto(
  itensRecebidos: ItemRecebido[]
): Promise<Precificacao> {
  if (itensRecebidos.length === 0) return { ok: false, erro: "Nada para transferir" }

  const produtos = await db.produto.findMany({
    where: { id: { in: itensRecebidos.map((i) => i.produtoId) } },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))
  const custos = await ultimoCustoPorProduto(produtos.map((p) => p.id))

  const semCusto = produtos.filter((p) => !custos.has(p.id))
  if (semCusto.length > 0) {
    return {
      ok: false,
      erro:
        `Sem custo de compra: ${semCusto.map((p) => p.codigo).join(", ")} — ` +
        "a nota de transferência sai pelo custo, e ele nunca foi registrado",
    }
  }

  const itens: ItemGravado[] = []
  for (const recebido of itensRecebidos) {
    const produto = porId.get(recebido.produtoId)
    if (!produto) return { ok: false, erro: "Produto não encontrado no catálogo" }

    const preco = arredondar(custos.get(produto.id)!)
    itens.push({
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      preco,
      quantidade: recebido.quantidade,
      subtotal: arredondar(preco * recebido.quantidade),
    })
  }

  const subtotal = arredondar(itens.reduce((acc, item) => acc + item.subtotal, 0))
  return { ok: true, itens, subtotal, total: subtotal }
}

/**
 * A recusa por estoque, ou `null` quando a loja cobre o carrinho inteiro.
 *
 * Não se vende o que não existe: o saldo da loja é o teto de cada item. A tela
 * do caixa já impede de passar disso, mas o saldo pode ter mudado entre a
 * montagem do carrinho e o fechamento — outro caixa vendendo a mesma última
 * caixa, uma transferência despachada — e a tela é do outro lado da rede.
 *
 * Fica ANTES da liberação do gerente de propósito: falta de estoque não é coisa
 * que se libere, então não faz sentido mandar o vendedor buscar o gerente para
 * uma venda que não vai fechar de jeito nenhum.
 *
 * A janela entre esta consulta e a gravação é pequena mas existe. Fechá-la de
 * vez pediria reservar o saldo dentro da transação; enquanto o balcão tiver dois
 * caixas por loja, o custo disso não se paga.
 */
export async function recusaPorFaltaDeEstoque(
  itens: { produtoId: string; descricao: string; unidade: string; quantidade: number }[],
  loja: string
): Promise<string | null> {
  const saldos = await saldosDosProdutos(
    itens.map((item) => item.produtoId),
    loja
  )

  const faltando = itens.filter((item) => item.quantidade > (saldos.get(item.produtoId) ?? 0))
  if (faltando.length === 0) return null

  return faltando
    .map((item) => {
      const saldo = saldos.get(item.produtoId) ?? 0
      return saldo <= 0
        ? `${item.descricao} — sem estoque em ${loja}`
        : `${item.descricao} — só há ${formatarQuantidade(saldo)} ${item.unidade} em ${loja}`
    })
    .join("; ")
}

/**
 * Os preços vêm do banco, nunca do cliente: o payload só diz *o que* e *quanto*.
 * Assim um total adulterado no navegador não chega a ser gravado.
 */
/** O que `avaliarVenda` devolveria para quem não pode precisar de liberação. */
const SEM_MOTIVOS = {
  motivos: [] as never[],
  divida: { valor: 0, parcelas: 0, diasAtraso: 0 },
  descontoPercentual: 0,
}

export async function registrarVenda(
  recebidoDaTela: PedidoVenda
): Promise<ResultadoVenda> {
  let pedido = recebidoDaTela
  if (!FORMAS_PAGAMENTO.some((f) => f.id === pedido.forma)) {
    return { ok: false, erro: "Forma de pagamento inválida" }
  }
  if (!pedido.loja) return { ok: false, erro: "Venda sem loja" }

  /**
   * Pix só existe com o txid que o Inter confirmou — e cada txid paga UMA venda.
   *
   * O caminho da tela passa sempre pela conferência no Inter, mas o payload da
   * venda comum aceitava "pix" como forma: quem o montasse no console gravava
   * uma venda recebida em dinheiro como Pix, e o valor sumia da conta da gaveta.
   * E um txid já pago, reapresentado numa segunda venda de mesmo total, passava
   * na conferência — o Inter diz que ele foi pago, e foi, uma vez.
   */
  if (pedido.forma === "pix") {
    if (!pedido.pixTxid) {
      return { ok: false, erro: "Pix só fecha pela cobrança conferida no Inter" }
    }
    const jaUsado = await db.venda.findFirst({
      where: { pixTxid: pedido.pixTxid },
      select: { numero: true, loja: true },
    })
    if (jaUsado) {
      return {
        ok: false,
        erro: `Este Pix já pagou a venda #${jaUsado.numero} de ${jaUsado.loja}`,
      }
    }
  }

  /**
   * A saída para outra loja da rede, decidida AQUI e pelo CNPJ.
   *
   * A forma sozinha não podia mandar: quem montasse o payload escolheria
   * "transferência" para um cliente de verdade e a venda sumiria do
   * faturamento, do estoque e da comissão de uma vez. E o cliente sozinho
   * também não: sem exigir a forma, a mesma loja-cliente passaria como venda
   * comum pelo caminho antigo. Por isso as duas coisas têm que concordar, e a
   * verdade é o documento — CNPJ de loja da rede é loja da rede.
   */
  const cliente = pedido.clienteId
    ? await db.cliente.findUnique({ where: { id: pedido.clienteId } })
    : null
  if (pedido.clienteId && !cliente) return { ok: false, erro: "Cliente não encontrado" }

  const lojaCliente = await lojaPeloDocumento(cliente?.cpfCnpj)
  const paraARede = lojaCliente !== null

  if (pedido.forma === FORMA_TRANSFERENCIA && !paraARede) {
    return {
      ok: false,
      erro: "Transferência entre lojas exige o cadastro da loja de destino como cliente",
    }
  }
  if (paraARede && pedido.forma !== FORMA_TRANSFERENCIA) {
    return {
      ok: false,
      erro: `${lojaCliente.nome} é loja da rede — a saída sai como transferência, não como venda`,
    }
  }
  if (paraARede && lojaCliente.codigo === pedido.loja) {
    return { ok: false, erro: "Origem e destino são a mesma loja" }
  }

  // O custo, e não o preço de balcão: entre estabelecimentos não há margem a
  // realizar. O desconto não entra na conta por não significar nada aqui.
  const preco = paraARede
    ? await precificarAoCusto(pedido.itens)
    : await precificar(pedido.itens, pedido.desconto)
  if (!preco.ok) return { ok: false, erro: preco.erro }
  const { itens, subtotal, total } = preco

  /*
   * Daqui para baixo a transferência segue sem desconto e sem valor recebido.
   * `precificarAoCusto` já ignorou o desconto no cálculo; sem zerá-lo aqui
   * também, a venda seria gravada com um desconto que não entrou em conta
   * nenhuma, e o documento diria `subtotal − desconto ≠ total`. O recebido cai
   * junto porque ninguém entregou dinheiro: a carga só mudou de prateleira.
   */
  if (paraARede) pedido = { ...pedido, desconto: 0, recebido: null }

  /**
   * O crédito abatido, conferido contra o LIVRO — nunca contra o que a tela diz.
   *
   * Não é desconto: a mercadoria saiu pelo preço cheio e o faturamento continua
   * `total`. O que muda é quanto entra na gaveta, que passa a ser
   * `total − creditoUsado`. É por isso que o valor recebido em dinheiro é
   * comparado com `aPagar`, e não com o total.
   *
   * Transferência entre lojas não abate crédito: a loja da rede não tem conta a
   * favor, e a nota sai pelo custo — não há o que pagar.
   */
  const creditoPedido = paraARede ? 0 : arredondar(pedido.creditoUsado)
  let creditoUsado = 0

  if (creditoPedido > 0) {
    if (!cliente) {
      return { ok: false, erro: "Crédito é do cliente — vincule o cadastro (F6) para usar" }
    }
    const saldo = await saldoDeCredito(cliente.id)
    if (creditoPedido > saldo) {
      return {
        ok: false,
        erro:
          saldo <= 0
            ? `${cliente.nome} não tem crédito a favor`
            : `${cliente.nome} tem ${moeda(saldo)} de crédito — não dá para abater ${moeda(creditoPedido)}`,
      }
    }
    if (creditoPedido > total) {
      return {
        ok: false,
        erro: `O crédito abatido não pode passar do total da venda (${moeda(total)})`,
      }
    }
    creditoUsado = creditoPedido
  }

  const aPagar = arredondar(total - creditoUsado)

  if (pedido.forma === "dinheiro") {
    if (pedido.recebido === null) return { ok: false, erro: "Informe o valor recebido" }
    if (pedido.recebido < aPagar) return { ok: false, erro: "Valor recebido menor que o total" }
  }

  /**
   * O vendedor é resolvido AQUI, pelo código, como toda regra deste arquivo:
   * a tela é do outro lado da rede. Sem isto, comissão seria um campo de texto
   * que o navegador escolhe.
   */
  const vendedor = paraARede
    ? null
    : await vendedorPorCodigo(pedido.vendedorCodigo ?? "", pedido.loja)
  if (!paraARede && !vendedor) {
    return {
      ok: false,
      erro: pedido.vendedorCodigo
        ? `Nenhum vendedor com o código ${pedido.vendedorCodigo} nesta loja`
        : "Informe o código do vendedor",
    }
  }

  /**
   * Caixa aberto é condição para gravar venda — cobrada AQUI, não só na tela.
   *
   * A trava vivia apenas no carregamento da tela do caixa, e isso deixava dois
   * furos: quem já estava com a aba aberta continuava vendendo depois de o caixa
   * ser fechado ou a abertura cancelada, e qualquer requisição montada fora da
   * tela passava direto. Foi assim que uma venda entrou dois minutos depois de a
   * abertura ter sido cancelada.
   *
   * É o mesmo princípio das outras regras deste arquivo: a guarda mora onde a
   * gravação acontece, porque a tela é do outro lado da rede.
   */
  if (!(await caixaAberto(pedido.loja, diaDeHoje()))) {
    return {
      ok: false,
      erro: `O caixa de ${pedido.loja} não foi aberto hoje — lance o troco da gaveta antes de vender`,
    }
  }

  /*
   * A falta de estoque não se cobra aqui quando o destino é a rede: quem moveu
   * a mercadoria foi a transferência, que já baixou o saldo da origem no
   * despacho. Cobrar de novo recusaria a nota justamente por causa da baixa que
   * a própria carga fez — e a nota é o papel que acompanha essa carga.
   */
  if (!paraARede) {
    const semEstoque = await recusaPorFaltaDeEstoque(itens, pedido.loja)
    if (semEstoque) return { ok: false, erro: semEstoque }
  }

  /**
   * A trava do gerente, cobrada AQUI.
   *
   * Aqui e não na tela porque a tela é do outro lado da rede: o payload da venda
   * é montado no navegador, e uma trava que só existisse lá seria contornada por
   * qualquer um que abrisse o console. Este é o único ponto por onde toda venda
   * passa — balcão, Pix e prazo —, então é onde a regra vale para as três.
   */
  /*
   * A liberação do gerente é sobre dívida do cliente e teto de desconto. A rede
   * não deve a si mesma e não há desconto numa nota ao custo — avaliar aqui
   * mandaria buscar o gerente para autorizar uma coisa que não existe.
   */
  const avaliacao = paraARede
    ? SEM_MOTIVOS
    : await avaliarVenda({
        clienteId: pedido.clienteId,
        subtotal,
        desconto: pedido.desconto,
        forma: pedido.forma,
      })

  if (avaliacao.motivos.length > 0) {
    if (!pedido.autorizacaoId) {
      return {
        ok: false,
        erro: "Esta venda precisa da liberação do gerente",
        precisaAutorizacao: true,
        motivos: avaliacao.motivos,
        divida: {
          valor: avaliacao.divida.valor,
          parcelas: avaliacao.divida.parcelas,
          diasAtraso: avaliacao.divida.diasAtraso,
        },
        descontoPercentual: avaliacao.descontoPercentual,
      }
    }

    const conferida = await conferirAutorizacao({
      id: pedido.autorizacaoId,
      loja: pedido.loja,
      clienteId: pedido.clienteId,
      subtotal,
      desconto: pedido.desconto,
      motivos: avaliacao.motivos,
    })
    if (!conferida.ok) return { ok: false, erro: conferida.erro }
  }

  // Autorização que sobrou de um carrinho que deixou de precisar dela não é
  // consumida: seria queimar a liberação do gerente por engano.
  const autorizacaoAUsar = avaliacao.motivos.length > 0 ? pedido.autorizacaoId ?? null : null

  // A prazo vira boleto, e o boleto do Inter exige pagador com endereço e um
  // valor nominal mínimo. Recusar aqui evita gravar venda que não pode ser cobrada.
  // O cliente em si já veio buscado lá em cima, onde se decidiu se é da rede.
  let vencimento: Date | null = null
  let condicaoId: string | null = null

  if (pedido.forma === "prazo") {
    if (!cliente) {
      return { ok: false, erro: "Venda a prazo exige cliente (F6 para vincular)" }
    }

    const condicao = condicaoPorId(pedido.condicao ?? "")
    if (!condicao) return { ok: false, erro: "Escolha a condição de pagamento" }

    // O mínimo do Inter vale por boleto, então o que decide é a menor parcela,
    // não o total: R$ 6,00 em 3× daria três boletos de R$ 2,00, todos recusados.
    if (!condicaoCabeNoTotal(condicao, total)) {
      const menor = Math.min(...dividirParcelas(total, condicao.dias.length))
      return {
        ok: false,
        erro: `${condicao.rotulo} daria parcela de ${moeda(menor)} — o boleto exige no mínimo ${moeda(VALOR_MINIMO_BOLETO)}`,
      }
    }

    condicaoId = condicao.id
    vencimento = parcelasDaCondicao(condicao, total)[0].vencimento
  }

  // Sobre o que falta pagar, não sobre o total: com R$ 37 de crédito numa venda
  // de R$ 50, quem entrega R$ 20 leva R$ 7 de troco, não teria troco nenhum.
  const troco =
    pedido.recebido === null ? 0 : arredondar(Math.max(0, pedido.recebido - aPagar))

  try {
    return {
      ok: true,
      ...(await gravar(
        pedido, itens, subtotal, total, troco, cliente, vencimento, condicaoId, autorizacaoAUsar,
        vendedor, creditoUsado
      )),
      total,
      troco,
    }
  } catch (erro) {
    if (erro instanceof Error && erro.message.includes(SEQUENCIA_ESGOTADA)) {
      return { ok: false, erro: "Sequência de numeração fora de sincronia" }
    }
    throw erro
  }
}

const SEQUENCIA_ESGOTADA = "sequencia-de-venda-esgotada"

/**
 * Só a colisão do `numero` justifica tentar de novo. Antes isto aceitava qualquer
 * P2002, então uma violação em outro índice único era reprocessada 25 vezes —
 * queimando 25 números de venda e mascarando a causa real com uma mensagem de
 * "sequência fora de sincronia".
 */
function ehColisaoDeNumero(erro: unknown) {
  if (typeof erro !== "object" || erro === null) return false
  const falha = erro as { code?: string; meta?: { target?: unknown } }
  if (falha.code !== "P2002") return false

  const alvo = falha.meta?.target
  const texto = Array.isArray(alvo) ? alvo.join(",") : String(alvo ?? "")
  return texto.includes("numero")
}

/**
 * Se o contador ficar atrás das vendas existentes (restore de backup, ajuste
 * manual), o `numero` colide no índice único. Em vez de derrubar o caixa com um
 * 500 a cada venda, tentamos de novo até a sequência passar das vendas gravadas.
 */
async function gravar(
  pedido: PedidoVenda,
  itens: ItemGravado[],
  subtotal: number,
  total: number,
  troco: number,
  cliente: { id: string; nome: string; cpfCnpj: string } | null,
  vencimento: Date | null,
  condicao: string | null,
  autorizacaoId: string | null,
  /** Null na transferência entre lojas: não há comissão a creditar. */
  vendedor: VendedorDoBalcao | null,
  creditoUsado: number
): Promise<{ numero: number; vendaId: string }> {
  for (let tentativa = 0; tentativa < 25; tentativa++) {
    // O $inc fica FORA da transação de propósito: dentro dela, o rollback de uma
    // colisão devolveria o contador e a tentativa seguinte repetiria o mesmo
    // número para sempre. O custo é um número queimado quando a gravação falha.
    // Um contador por loja: "venda:QI". Com um contador global, as quatro lojas
    // disputariam a mesma sequência e o número deixaria de significar algo para
    // quem confere o caixa de uma loja.
    const contador = await db.contador.upsert({
      where: { nome: `venda:${pedido.loja}` },
      update: { valor: { increment: 1 } },
      create: { nome: `venda:${pedido.loja}`, valor: 1 },
    })

    try {
      return await gravarUmaVez(
        contador.valor, pedido, itens, subtotal, total, troco, cliente, vencimento, condicao,
        autorizacaoId, vendedor, creditoUsado
      )
    } catch (erro) {
      if (!ehColisaoDeNumero(erro)) throw erro
    }
  }
  throw new Error(SEQUENCIA_ESGOTADA)
}

async function gravarUmaVez(
  numero: number,
  pedido: PedidoVenda,
  itens: ItemGravado[],
  subtotal: number,
  total: number,
  troco: number,
  cliente: { id: string; nome: string; cpfCnpj: string } | null,
  vencimento: Date | null,
  condicao: string | null,
  autorizacaoId: string | null,
  /** Null na transferência entre lojas: não há comissão a creditar. */
  vendedor: VendedorDoBalcao | null,
  creditoUsado: number
): Promise<{ numero: number; vendaId: string }> {
  // A venda e as baixas de estoque caem juntas ou não caem: uma venda gravada
  // sem seus movimentos deixaria o saldo derivado errado para sempre.
  return db.$transaction(async (tx) => {
    const venda = await tx.venda.create({
      data: {
        numero,
        loja: pedido.loja,
        caixa: pedido.caixa,
        operador: pedido.operador,
        vendedorId: vendedor?.id ?? null,
        vendedorNome: vendedor?.nome ?? null,
        itens,
        subtotal,
        desconto: pedido.desconto,
        total,
        forma: pedido.forma,
        creditoUsado,
        recebido: pedido.recebido,
        troco: pedido.recebido === null ? null : troco,
        clienteId: cliente?.id ?? null,
        clienteNome: cliente?.nome ?? null,
        clienteCpfCnpj: cliente?.cpfCnpj ?? null,
        cpfNaNota: pedido.cpfNaNota,
        vencimento,
        condicao,
        pixTxid: pedido.pixTxid ?? null,
        pixPagoEm: pedido.pixPagoEm ?? null,
      },
    })

    /*
     * A transferência entre lojas NÃO baixa estoque, e é o ponto inteiro dela.
     *
     * A mercadoria já saiu da prateleira quando a carga foi despachada, pelo
     * `transferencia_saida` do documento de transferência. Baixar de novo aqui
     * tiraria duas vezes o que saiu uma, e o saldo — que é a soma do livro —
     * ficaria errado para sempre, sem nada apontando por quê.
     *
     * A leitura vale ao contrário também: se um dia a nota passar a nascer da
     * própria transferência, é esta linha que sai, não a outra.
     */
    if (!ehTransferenciaEntreLojas(pedido.forma)) {
      await tx.movimentoEstoque.createMany({
        data: movimentosDeVenda(
          itens.map((item) => ({ produtoId: item.produtoId, quantidade: item.quantidade })),
          venda,
          pedido.operador
        ),
      })
    }

    /*
     * O consumo do crédito cai com a venda, ou não cai. Fora da transação, uma
     * falha depois de gastar deixaria o saldo do cliente menor sem venda que o
     * explicasse — dinheiro dele que some sem contrapartida.
     */
    if (creditoUsado > 0 && cliente) {
      await gastarCredito(tx, {
        clienteId: cliente.id,
        loja: pedido.loja,
        valor: creditoUsado,
        vendaId: venda.id,
        vendaNumero: venda.numero,
        operador: pedido.operador,
      })
    }

    // Dentro da MESMA transação da venda: fora dela, uma falha na gravação
    // deixaria a autorização queimada sem venda nenhuma — e, pior, a ordem
    // inversa deixaria a venda gravada com a liberação ainda "aprovada", pronta
    // para fechar uma segunda venda com a mesma permissão.
    if (autorizacaoId) {
      await marcarAutorizacaoUsada(tx, autorizacaoId, {
        id: venda.id,
        numero: venda.numero,
      })
    }

    return { numero: venda.numero, vendaId: venda.id }
  })
}

/**
 * Venda cancelada não conta em faturamento nenhum.
 *
 * O OR existe porque no Mongo o campo de uma venda nunca cancelada está AUSENTE
 * do documento, e ausente não casa com `null` no Prisma. Sem isto o filtro
 * devolvia zero vendas.
 */
export const NAO_CANCELADA: Prisma.VendaWhereInput = {
  OR: [{ canceladaEm: null }, { canceladaEm: { isSet: false } }],
}

/**
 * A saída para outra loja da rede não é faturamento.
 *
 * Anda junto de `NAO_CANCELADA` em toda soma pela mesma razão: são documentos
 * que existem no livro e não contam como venda. A diferença é que a cancelada
 * não conta porque o dinheiro voltou, e esta porque nunca houve dinheiro — a
 * mercadoria só mudou de prateleira, e a nota foi acompanhá-la.
 *
 * Filtra pela FORMA, e não por um campo próprio na venda, porque a forma só
 * chega a valer "transferência" depois de o servidor conferir que o cliente é
 * mesmo uma loja da rede, pelo CNPJ. Dois campos dizendo a mesma coisa é um
 * campo a mais para discordar.
 */
export const NAO_E_TRANSFERENCIA: Prisma.VendaWhereInput = {
  forma: { not: FORMA_TRANSFERENCIA },
}

/** Venda de verdade: nem cancelada, nem saída para a própria rede. */
export const VENDA_QUE_CONTA: Prisma.VendaWhereInput = {
  AND: [NAO_CANCELADA, NAO_E_TRANSFERENCIA],
}

export const VENDAS_POR_PAGINA = 50

export type SituacaoFiltrada = "todas" | "validas" | "canceladas"

export type FiltroDeNota = "" | "sem" | "com"

/** Os status que contam como "esta venda tem documento fiscal". */
const NOTA_VALE: string[] = ["autorizado", "processando_autorizacao"]

/**
 * O filtro da consulta de vendas, do jeito que a tela o mostra.
 *
 * Guarda texto, não `Date` nem `number`: é o mesmo objeto que volta para
 * preencher o formulário, e converter duas vezes (para consultar e de volta para
 * exibir) é onde nasce a divergência entre o que a tela diz filtrar e o que
 * filtrou de fato.
 */
export type FiltroVendas = {
  /** Lojas efetivamente consultadas — sempre um subconjunto das permitidas. */
  lojas: string[]
  /** O que o seletor mostra: um código de loja ou "todas". */
  loja: string
  /** Dias inclusivos, no formato YYYY-MM-DD do `<input type="date">`. */
  de: string
  ate: string
  numero: string
  cliente: string
  forma: string
  /** Id do vendedor; vazio é "todos". */
  vendedor: string
  /**
   * Total exato da venda, como se digita ("127,50"). Serve para ACHAR uma venda
   * de que só se lembra o valor — por isso é igualdade ao centavo, e não faixa:
   * uma faixa devolveria dezenas de vendas parecidas e não responderia nada.
   */
  valor: string
  /**
   * "sem" = vendas que não têm nota válida; "com" = as que têm; vazio = todas.
   *
   * "Válida" é autorizada ou ainda processando. Nota RECUSADA conta como sem
   * nota, e é o ponto do filtro: a venda saiu, a SEFAZ negou, e o documento
   * continua faltando — esconder essas atrás de "tem nota" deixaria de fora
   * justamente as que precisam de alguém.
   */
  nota: FiltroDeNota
  situacao: SituacaoFiltrada
  pagina: number
}

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * Lê o filtro da URL, recusando o que não é do usuário.
 *
 * `lojas` sai daqui já cruzado com as permitidas: é este cruzamento, e não o
 * seletor da tela, que impede alguém de ver o faturamento de uma loja onde não
 * opera trocando `?loja=` na barra de endereço.
 */
export function lerFiltroVendas(url: URL, lojasPermitidas: string[]): FiltroVendas {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const temDe = DIA.test(texto("de"))
  const temAte = DIA.test(texto("ate"))

  // Com uma ponta só, o período é aquele dia: quem digita uma data quer um dia.
  // Sem nenhuma, os últimos sete — a tela abre respondendo "o que andou
  // vendendo", e um padrão de um dia devolveria tela vazia toda manhã.
  const de = temDe ? texto("de") : temAte ? texto("ate") : diaAtras(6)
  const ateBruto = temAte ? texto("ate") : temDe ? texto("de") : diaDeHoje()
  // Datas invertidas viriam de digitação, não de má-fé: vale mais devolver o
  // período que a pessoa quis do que uma lista vazia sem explicação.
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const loja = lojasPermitidas.includes(texto("loja")) ? texto("loja") : "todas"
  const situacao = texto("situacao")

  return {
    lojas: loja === "todas" ? lojasPermitidas : [loja],
    loja,
    de: inicio,
    ate: fim,
    numero: texto("numero").replace(/\D/g, "").slice(0, 9),
    cliente: texto("cliente").slice(0, 60),
    forma: FORMAS_PAGAMENTO.some((f) => f.id === texto("forma")) ? texto("forma") : "",
    // ObjectId malformado faria o Prisma lançar; aqui vira "todos".
    vendedor: OBJECT_ID.test(texto("vendedor")) ? texto("vendedor") : "",
    valor: texto("valor").slice(0, 15),
    nota: texto("nota") === "sem" || texto("nota") === "com" ? (texto("nota") as FiltroDeNota) : "",
    situacao:
      situacao === "validas" || situacao === "canceladas" ? situacao : "todas",
    pagina: Math.max(1, Math.trunc(Number(params.get("pagina"))) || 1),
  }
}

/**
 * O faturamento de cada vendedor no conjunto já filtrado.
 *
 * Do maior para o menor: a pergunta é "quem vendeu quanto", e ela se responde
 * de cima para baixo. As vendas anteriores ao campo caem num "sem vendedor"
 * explícito — escondê-las faria a soma das linhas não bater com o total.
 */
function agruparPorVendedor(
  vendas: { vendedorId: string | null; vendedorNome: string | null; total: number }[]
) {
  const mapa = new Map<string, { vendedorId: string | null; nome: string; vendas: number; faturamento: number }>()

  for (const venda of vendas) {
    const chave = venda.vendedorId ?? ""
    const atual = mapa.get(chave) ?? {
      vendedorId: venda.vendedorId,
      nome: venda.vendedorNome ?? "sem vendedor",
      vendas: 0,
      faturamento: 0,
    }
    atual.vendas += 1
    atual.faturamento += venda.total
    mapa.set(chave, atual)
  }

  return [...mapa.values()]
    .map((linha) => ({ ...linha, faturamento: arredondar(linha.faturamento) }))
    .sort((a, b) => b.faturamento - a.faturamento)
}

export type VendaConsultada = Awaited<
  ReturnType<typeof consultarVendas>
>["vendas"][number]

/**
 * As vendas que casam com o filtro, uma página de cada vez.
 *
 * O resumo é do filtro INTEIRO, não da página: quem confere o dia quer o total
 * do dia, e um rodapé que só somasse as 50 primeiras seria pior que nenhum.
 */
export async function consultarVendas(filtro: FiltroVendas) {
  // Separado do período de propósito: é este conjunto que responde "existe em
  // algum lugar?" quando a busca não acha nada no período pedido.
  const conteudo: Prisma.VendaWhereInput[] = [{ loja: { in: filtro.lojas } }]

  if (filtro.numero) conteudo.push({ numero: Number(filtro.numero) })
  if (filtro.forma) conteudo.push({ forma: filtro.forma })
  if (filtro.vendedor) conteudo.push({ vendedorId: filtro.vendedor })

  if (filtro.valor) {
    // Comparar float com igualdade erraria por arredondamento; a janela de meio
    // centavo pega o valor gravado sem alargar a busca para vendas vizinhas.
    const alvo = interpretarValor(filtro.valor)
    if (alvo !== null) {
      conteudo.push({ total: { gte: alvo - 0.005, lte: alvo + 0.005 } })
    }
  }

  if (filtro.cliente) {
    // Nome ou documento, no mesmo campo: quem procura "Maria" e quem procura
    // "123.456" está fazendo a mesma pergunta, e são dois campos a menos na barra.
    const digitos = filtro.cliente.replace(/\D/g, "")
    conteudo.push({
      OR: [
        { clienteNome: { contains: filtro.cliente, mode: "insensitive" } },
        ...(digitos.length >= 3 ? [{ clienteCpfCnpj: { contains: digitos } }] : []),
      ],
    })
  }

  /*
   * "Tem nota?" é uma pergunta de OUTRA coleção, e o Mongo não junta as duas
   * numa consulta só. A volta é buscar de quem HÁ nota válida e usar a lista
   * como filtro — para incluir ou para excluir, conforme o que se pediu.
   *
   * Sem recorte de data de propósito: a nota pode ter sido emitida meses depois
   * da venda, que é exatamente o caso que este filtro existe para achar. O
   * recorte é por LOJA, que é o que limita o tamanho da lista.
   */
  if (filtro.nota) {
    const comNota = await db.notaFiscalEmitida.findMany({
      where: { loja: { in: filtro.lojas }, status: { in: NOTA_VALE }, vendaId: { not: null } },
      select: { vendaId: true },
    })
    const ids = [...new Set(comNota.map((n) => n.vendaId!))]
    conteudo.push(filtro.nota === "com" ? { id: { in: ids } } : { id: { notIn: ids } })
  }

  if (filtro.situacao === "validas") conteudo.push(NAO_CANCELADA)
  if (filtro.situacao === "canceladas") conteudo.push({ NOT: NAO_CANCELADA })

  const condicoes: Prisma.VendaWhereInput[] = [
    { criadaEm: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) } },
    ...conteudo,
  ]
  const where: Prisma.VendaWhereInput = { AND: condicoes }

  const [pagina, total, validas, canceladas, porVendedor] = await Promise.all([
    db.venda.findMany({
      where,
      // Por data, e não por número: a numeração é POR LOJA, então ordenar por
      // número misturaria as lojas numa sequência que não significa nada.
      orderBy: { criadaEm: "desc" },
      skip: (filtro.pagina - 1) * VENDAS_POR_PAGINA,
      take: VENDAS_POR_PAGINA,
    }),
    db.venda.count({ where }),
    /*
     * O resumo soma só o que é venda. A transferência para outra loja da rede
     * CONTINUA na lista — quem procura "a nota que mandei para a NRT" a procura
     * aqui —, mas fora do total e fora do faturamento por vendedor: ela não é
     * faturamento de ninguém.
     */
    db.venda.aggregate({
      where: { AND: [...condicoes, NAO_CANCELADA, NAO_E_TRANSFERENCIA] },
      _sum: { total: true },
      _count: { _all: true },
    }),
    db.venda.count({ where: { AND: [...condicoes, { NOT: NAO_CANCELADA }] } }),
    /**
     * Quanto cada um vendeu no período — é o que torna a comissão conferível
     * sem exportar nada. Só as válidas: venda cancelada não gera comissão.
     *
     * Somado em JS, e não com `groupBy`: o conector do Mongo derruba o query
     * engine (panic de Rust, não exceção) quando um campo do `by` é nulo, e
     * `vendedorId` é nulo em toda venda anterior a este campo. São três campos
     * por venda de uma loja num período — cabe na memória com folga.
     */
    db.venda.findMany({
      where: { AND: [...condicoes, NAO_CANCELADA, NAO_E_TRANSFERENCIA] },
      select: { vendedorId: true, vendedorNome: true, total: true },
    }),
  ])

  /**
   * Quantas casariam se o período não estivesse no caminho.
   *
   * Achar nada por causa da data é a frustração clássica de tela com filtro:
   * quem procura a venda #1234 ou uma compra da Maria não sabe de que dia ela é,
   * e "nenhuma venda" é uma resposta que parece defeito. Custa uma contagem, e só
   * quando a busca já voltou vazia.
   */
  const foraDoPeriodo =
    total === 0 && (filtro.numero || filtro.cliente || filtro.forma || filtro.valor || filtro.vendedor)
      ? await db.venda.count({ where: { AND: conteudo } })
      : 0

  // Uma venda parcelada tem uma cobrança por parcela, então é lista, não par.
  const cobrancas = await db.cobranca.findMany({
    where: { vendaId: { in: pagina.map((venda) => venda.id) } },
    orderBy: { parcela: "asc" },
    select: {
      vendaId: true,
      parcela: true,
      parcelas: true,
      situacao: true,
      valor: true,
      vencimento: true,
    },
  })
  const porVenda = new Map<string, typeof cobrancas>()
  for (const cobranca of cobrancas) {
    const lista = porVenda.get(cobranca.vendaId) ?? []
    lista.push(cobranca)
    porVenda.set(cobranca.vendaId, lista)
  }

  return {
    vendas: pagina.map((venda) => ({
      ...venda,
      cobrancas: porVenda.get(venda.id) ?? [],
    })),
    total,
    foraDoPeriodo,
    paginas: Math.max(1, Math.ceil(total / VENDAS_POR_PAGINA)),
    resumo: {
      vendas: validas._count._all,
      faturamento: validas._sum.total ?? 0,
      canceladas,
      porVendedor: agruparPorVendedor(porVendedor),
    },
  }
}
