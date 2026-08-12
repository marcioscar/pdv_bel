import { chamarInter } from "~/lib/inter.server"

/** Campos do `pagador` como a API de Cobrança espera. */
export type PagadorInter = {
  nome: string
  cpfCnpj: string
  tipoPessoa: string
  endereco: string
  bairro: string
  cidade: string
  uf: string
  cep: string
  numero?: string | null
  complemento?: string | null
  email?: string | null
  ddd?: string | null
  telefone?: string | null
}

export type CobrancaEmitida = { codigoSolicitacao: string }

export type CobrancaConsultada = {
  cobranca: {
    codigoSolicitacao: string
    situacao: string
    seuNumero: string
    valorNominal: number
    dataVencimento: string
  }
  boleto?: { codigoBarras: string; linhaDigitavel: string; nossoNumero: string }
  pix?: { txid: string; pixCopiaECola: string }
}

function limpo(valor: string | null | undefined) {
  return valor ? valor.replace(/\D/g, "") : undefined
}

/**
 * Emite o "bolepix": um boleto com QR Code Pix embutido.
 *
 * A emissão é **assíncrona** — a resposta traz só o `codigoSolicitacao`. O código
 * de barras e o copia-e-cola aparecem depois, na consulta ou pelo callback.
 */
export function emitirCobranca(entrada: {
  seuNumero: string
  valor: number
  vencimento: Date
  pagador: PagadorInter
  /** Dias corridos após o vencimento até o cancelamento automático (0–60). */
  diasAgenda?: number
  mensagem?: string
}) {
  const { seuNumero, valor, vencimento, pagador } = entrada

  return chamarInter<CobrancaEmitida>("/cobranca/v3/cobrancas", {
    metodo: "POST",
    escopos: ["boleto-cobranca.write"],
    corpo: {
      // O campo aceita no máximo 15 caracteres.
      seuNumero: seuNumero.slice(0, 15),
      valorNominal: Number(valor.toFixed(2)),
      dataVencimento: vencimento.toISOString().slice(0, 10),
      numDiasAgenda: entrada.diasAgenda ?? 30,
      pagador: {
        nome: pagador.nome,
        cpfCnpj: pagador.cpfCnpj,
        tipoPessoa: pagador.tipoPessoa,
        endereco: pagador.endereco,
        bairro: pagador.bairro,
        cidade: pagador.cidade,
        uf: pagador.uf,
        cep: limpo(pagador.cep),
        numero: pagador.numero ?? undefined,
        complemento: pagador.complemento ?? undefined,
        email: pagador.email ?? undefined,
        ddd: limpo(pagador.ddd),
        telefone: limpo(pagador.telefone),
      },
      ...(entrada.mensagem ? { mensagem: { linha1: entrada.mensagem } } : {}),
      formasRecebimento: ["BOLETO", "PIX"],
    },
  })
}

export function consultarCobranca(codigoSolicitacao: string) {
  return chamarInter<CobrancaConsultada>(`/cobranca/v3/cobrancas/${codigoSolicitacao}`, {
    escopos: ["boleto-cobranca.read"],
  })
}

/**
 * Devolve o PDF já decodificado.
 *
 * O endpoint não responde com o binário: responde `{"pdf": "<base64>"}`. Tratar
 * a resposta como arquivo direto gera um PDF corrompido.
 */
export async function pdfDaCobranca(codigoSolicitacao: string): Promise<Buffer> {
  const resposta = await chamarInter<{ pdf: string }>(
    `/cobranca/v3/cobrancas/${codigoSolicitacao}/pdf`,
    { escopos: ["boleto-cobranca.read"] }
  )

  if (!resposta?.pdf) throw new Error("Resposta do PDF sem o campo pdf")
  return Buffer.from(resposta.pdf, "base64")
}

export function cancelarCobranca(codigoSolicitacao: string, motivo: string) {
  return chamarInter(`/cobranca/v3/cobrancas/${codigoSolicitacao}/cancelar`, {
    metodo: "POST",
    escopos: ["boleto-cobranca.write"],
    corpo: { motivoCancelamento: motivo },
  })
}

/**
 * Espera a emissão assíncrona terminar. A cobrança nasce "EM_PROCESSAMENTO" e só
 * depois ganha código de barras e copia-e-cola.
 *
 * Sai na linha digitável, sem esperar pelo Pix: medido, o copia-e-cola chega na
 * MESMA consulta que a linha. Quando ele não vem, é porque o Inter não emitiu Pix
 * para aquela cobrança (visto em valores baixos) — e aí esperar mais só atrasa o
 * caixa. A tela de Vendas mostra o Pix se ele aparecer depois.
 */
export async function aguardarEmissao(
  codigoSolicitacao: string,
  { tentativas = 8, intervaloMs = 1500 } = {}
): Promise<CobrancaConsultada> {
  let ultima: CobrancaConsultada | null = null

  for (let i = 0; i < tentativas; i++) {
    ultima = await consultarCobranca(codigoSolicitacao)
    if (ultima.boleto?.linhaDigitavel) return ultima
    await new Promise((r) => setTimeout(r, intervaloMs))
  }

  if (!ultima) throw new Error("Cobrança não encontrada")
  return ultima
}

// ---------------------------------------------------------------------------
// Emissão ligada à venda
// ---------------------------------------------------------------------------

import QRCode from "qrcode"

import { db } from "~/lib/db.server"
import { ErroInter } from "~/lib/inter.server"
import { condicaoPorId, parcelasDaCondicao, type Parcela } from "~/lib/pdv"

export type CobrancaDaVenda = {
  codigoSolicitacao: string
  situacao: string
  parcela: number
  parcelas: number
  valor: number
  vencimento: string
  linhaDigitavel: string | null
  codigoBarras: string | null
  nossoNumero: string | null
  txid: string | null
  pixCopiaECola: string | null
  /** PNG em data URI, gerado a partir do copia-e-cola. */
  pixQrCode: string | null
}

/** O Inter devolve o código da cobrança existente quando recusa uma duplicata. */
function codigoDaDuplicata(erro: unknown): string | null {
  if (!(erro instanceof ErroInter)) return null
  const detalhe = (erro.corpo as { detail?: string })?.detail ?? ""
  return /código de solicitação:\s*([0-9a-f-]{36})/i.exec(detalhe)?.[1] ?? null
}

async function comQrCode(dados: Omit<CobrancaDaVenda, "pixQrCode">): Promise<CobrancaDaVenda> {
  if (!dados.pixCopiaECola) return { ...dados, pixQrCode: null }

  const pixQrCode = await QRCode.toDataURL(dados.pixCopiaECola, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  })
  return { ...dados, pixQrCode }
}

type VendaParaCobrar = {
  id: string
  numero: number
  total: number
  criadaEm: Date
  vencimento: Date | null
  condicao: string | null
}

/**
 * As parcelas de uma venda: quanto e para quando, recalculado da condição.
 *
 * Derivar em vez de guardar mantém uma fonte da verdade só — o id da condição na
 * venda. `criadaEm` é a base, não a data de hoje: reemitir um boleto na semana
 * seguinte não pode empurrar o vencimento que o cliente combinou.
 */
function planoDaVenda(venda: VendaParaCobrar): Parcela[] {
  const condicao = condicaoPorId(venda.condicao ?? "")
  if (condicao) return parcelasDaCondicao(condicao, venda.total, venda.criadaEm)

  // Vendas gravadas antes das condições fixas só têm o vencimento avulso.
  if (!venda.vencimento) throw new Error("Venda sem condição nem vencimento")
  return [{ parcela: 1, valor: venda.total, vencimento: venda.vencimento }]
}

/** Identificador da parcela para o Inter — no máximo 15 caracteres. */
function seuNumeroDaParcela(numeroDaVenda: number, parcela: number, parcelas: number) {
  const base = `PDV${String(numeroDaVenda).padStart(6, "0")}`
  return parcelas === 1 ? base : `${base}-${parcela}`
}

/**
 * Emite (ou recupera) as cobranças de uma venda a prazo e guarda o resultado.
 *
 * Uma venda em 3× são três boletos, com valores e vencimentos próprios. Três
 * proteções contra emissão duplicada: o registro local por (vendaId, parcela), o
 * `seuNumero` distinto por parcela, e o próprio Inter, que recusa cobranças
 * iguais em sequência e informa o código da que já existe — nesse caso adotamos
 * aquela em vez de falhar.
 */
export async function emitirParaVenda(vendaId: string): Promise<CobrancaDaVenda[]> {
  const venda = await db.venda.findUnique({ where: { id: vendaId } })
  if (!venda) throw new Error("Venda não encontrada")
  if (venda.forma !== "prazo") throw new Error("Só venda a prazo gera boleto")
  if (venda.canceladaEm) throw new Error("Venda cancelada não gera boleto")
  if (!venda.clienteId) throw new Error("Venda sem cliente")

  const plano = planoDaVenda(venda)
  const existentes = await db.cobranca.findMany({ where: { vendaId } })
  const porParcela = new Map(existentes.map((c) => [c.parcela, c]))

  // Tudo já emitido: devolve sem tocar no Inter.
  if (plano.every((p) => porParcela.get(p.parcela)?.linhaDigitavel)) {
    return Promise.all(
      plano.map((p) => comQrCode(paraSaida(porParcela.get(p.parcela)!, plano.length)))
    )
  }

  const cliente = await db.cliente.findUnique({ where: { id: venda.clienteId } })
  if (!cliente) throw new Error("Cliente não encontrado")

  // Duas voltas de propósito. A emissão é assíncrona: mandar os três POSTs antes
  // de esperar o primeiro ficar pronto poupa a espera de uma parcela na outra —
  // com espera em série, três boletos passariam do tempo da requisição.
  const codigos = new Map<number, string>()
  for (const p of plano) {
    const existente = porParcela.get(p.parcela)
    if (existente?.linhaDigitavel) continue
    if (existente?.codigoSolicitacao) {
      codigos.set(p.parcela, existente.codigoSolicitacao)
      continue
    }
    codigos.set(
      p.parcela,
      await emitirUmaParcela(venda, cliente, p, plano.length)
    )
  }

  const saida: CobrancaDaVenda[] = []
  for (const p of plano) {
    const codigoSolicitacao = codigos.get(p.parcela)
    if (!codigoSolicitacao) {
      saida.push(await comQrCode(paraSaida(porParcela.get(p.parcela)!, plano.length)))
      continue
    }

    const detalhe = await aguardarEmissao(codigoSolicitacao)
    const dados = {
      situacao: detalhe.cobranca?.situacao ?? "EM_PROCESSAMENTO",
      linhaDigitavel: detalhe.boleto?.linhaDigitavel ?? null,
      codigoBarras: detalhe.boleto?.codigoBarras ?? null,
      nossoNumero: detalhe.boleto?.nossoNumero ?? null,
      txid: detalhe.pix?.txid ?? null,
      pixCopiaECola: detalhe.pix?.pixCopiaECola ?? null,
    }

    const gravada = await db.cobranca.upsert({
      where: { vendaId_parcela: { vendaId, parcela: p.parcela } },
      create: {
        vendaId,
        vendaNumero: venda.numero,
        parcela: p.parcela,
        parcelas: plano.length,
        codigoSolicitacao,
        valor: p.valor,
        vencimento: p.vencimento,
        ...dados,
      },
      update: dados,
    })

    saida.push(await comQrCode(paraSaida(gravada, plano.length)))
  }

  return saida
}

async function emitirUmaParcela(
  venda: VendaParaCobrar,
  cliente: PagadorInter,
  p: Parcela,
  parcelas: number
): Promise<string> {
  const sufixo = parcelas === 1 ? "" : ` - parcela ${p.parcela}/${parcelas}`

  try {
    const emitida = await emitirCobranca({
      seuNumero: seuNumeroDaParcela(venda.numero, p.parcela, parcelas),
      valor: p.valor,
      vencimento: p.vencimento,
      pagador: cliente,
      mensagem: `Venda ${venda.numero}${sufixo} - BrasSaco Embalagens`,
    })
    return emitida.codigoSolicitacao
  } catch (erro) {
    const duplicada = codigoDaDuplicata(erro)
    if (!duplicada) throw erro
    return duplicada
  }
}

function paraSaida(
  c: {
    codigoSolicitacao: string
    situacao: string
    parcela: number
    parcelas: number
    valor: number
    vencimento: Date
    linhaDigitavel: string | null
    codigoBarras: string | null
    nossoNumero: string | null
    txid: string | null
    pixCopiaECola: string | null
  },
  /** O total de parcelas do plano vence o gravado: a venda é quem manda. */
  parcelas = c.parcelas
): Omit<CobrancaDaVenda, "pixQrCode"> {
  return {
    codigoSolicitacao: c.codigoSolicitacao,
    situacao: c.situacao,
    parcela: c.parcela,
    parcelas,
    valor: c.valor,
    vencimento: c.vencimento.toISOString(),
    linhaDigitavel: c.linhaDigitavel,
    codigoBarras: c.codigoBarras,
    nossoNumero: c.nossoNumero,
    txid: c.txid,
    pixCopiaECola: c.pixCopiaECola,
  }
}

export type ResultadoCancelamentoCobrancas =
  | { ok: true; canceladas: number; jaEstavam: number }
  | { ok: false; erro: string }

/** Situações em que ainda há o que cancelar no Inter. */
const CANCELAVEIS = ["A_RECEBER", "EM_PROCESSAMENTO", "ATRASADO"]

/**
 * Cancela no Inter as cobranças de uma venda.
 *
 * Existe porque cancelar a venda só marcava o documento e estornava o estoque: o
 * boleto seguia vivo no banco, e o cliente podia pagar uma venda desfeita. Foi o
 * que aconteceu de verdade com a venda #1 — cancelada aqui, R$ 100 em aberto lá.
 *
 * A situação é reconsultada no Inter antes de decidir, porque a nossa cópia só se
 * atualiza pelo webhook: agir sobre um "A_RECEBER" velho poderia cancelar uma
 * cobrança já paga. E se alguma estiver PAGA, recusa tudo — dinheiro que entrou
 * exige devolução, não um estorno silencioso de estoque.
 */
export async function cancelarCobrancasDaVenda(
  vendaId: string,
  motivo = "APEDIDODOBENEFICIARIO"
): Promise<ResultadoCancelamentoCobrancas> {
  const cobrancas = await db.cobranca.findMany({
    where: { vendaId },
    orderBy: { parcela: "asc" },
  })
  if (cobrancas.length === 0) return { ok: true, canceladas: 0, jaEstavam: 0 }

  const atuais: { id: string; codigoSolicitacao: string; situacao: string; parcela: number }[] = []

  for (const c of cobrancas) {
    let situacao = c.situacao
    try {
      const detalhe = await consultarCobranca(c.codigoSolicitacao)
      situacao = detalhe.cobranca?.situacao ?? situacao
      if (situacao !== c.situacao) {
        await db.cobranca.update({ where: { id: c.id }, data: { situacao } })
      }
    } catch {
      // Sem resposta do Inter, seguimos com a situação conhecida: melhor tentar
      // cancelar e falhar do que deixar o boleto vivo por causa da consulta.
    }
    atuais.push({ id: c.id, codigoSolicitacao: c.codigoSolicitacao, situacao, parcela: c.parcela })
  }

  const pagas = atuais.filter((c) => c.situacao === "RECEBIDO" || c.situacao === "PAGO")
  if (pagas.length > 0) {
    const quais = pagas.map((c) => `${c.parcela}ª`).join(", ")
    return {
      ok: false,
      erro:
        pagas.length === atuais.length
          ? "O boleto desta venda já foi pago — faça a devolução antes de cancelar"
          : `A parcela ${quais} já foi paga — faça a devolução antes de cancelar`,
    }
  }

  let canceladas = 0
  let jaEstavam = 0

  for (const c of atuais) {
    if (!CANCELAVEIS.includes(c.situacao)) {
      jaEstavam++
      continue
    }
    try {
      await cancelarCobranca(c.codigoSolicitacao, motivo)
      await db.cobranca.update({ where: { id: c.id }, data: { situacao: "CANCELADO" } })
      canceladas++
    } catch (erro) {
      // Falha aqui é o caso perigoso: um boleto vivo numa venda desfeita. A venda
      // NÃO é cancelada, e o gerente recebe o motivo para resolver no banco.
      return {
        ok: false,
        erro: `Não foi possível cancelar o boleto da ${c.parcela}ª parcela no Inter: ${
          erro instanceof Error ? erro.message : "erro desconhecido"
        }`,
      }
    }
  }

  return { ok: true, canceladas, jaEstavam }
}

/** As cobranças já emitidas, sem chamar o Inter. Vazio quando não há nenhuma. */
export async function cobrancasDaVenda(vendaId: string): Promise<CobrancaDaVenda[]> {
  const cobrancas = await db.cobranca.findMany({
    where: { vendaId },
    orderBy: { parcela: "asc" },
  })
  return Promise.all(cobrancas.map((c) => comQrCode(paraSaida(c))))
}

/**
 * Simulador do sandbox: paga a cobrança. Depois disso o Inter dispara o callback
 * com os dados atualizados para o webhook cadastrado — é o jeito de exercitar o
 * webhook de verdade. Não existe em produção.
 */
export async function simularPagamentoCobranca(
  codigoSolicitacao: string,
  pagarCom: "BOLETO" | "PIX" = "BOLETO"
) {
  if (!process.env.INTER_BASE_URL?.includes("sandbox")) {
    throw new Error("Pagamento simulado só existe no sandbox")
  }
  return chamarInter(`/cobranca/v3/cobrancas/${codigoSolicitacao}/pagar`, {
    metodo: "POST",
    escopos: ["boleto-cobranca.write"],
    corpo: { pagarCom },
  })
}

/** Callbacks que o Inter tentou entregar — serve para ver o payload real. */
export function callbacksEnviados(dataHoraInicio: string, dataHoraFim: string) {
  const q = new URLSearchParams({ dataHoraInicio, dataHoraFim })
  return chamarInter<unknown>(`/cobranca/v3/cobrancas/webhook/callbacks?${q}`, {
    escopos: ["boleto-cobranca.read"],
  })
}
