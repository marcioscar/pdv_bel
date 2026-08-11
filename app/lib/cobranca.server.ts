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

export type CobrancaDaVenda = {
  codigoSolicitacao: string
  situacao: string
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

/**
 * Emite (ou recupera) a cobrança de uma venda a prazo e guarda o resultado.
 *
 * Duas proteções contra emissão duplicada: o registro local por `vendaId` e o
 * próprio Inter, que recusa cobranças iguais emitidas em sequência e informa o
 * código da que já existe — nesse caso adotamos aquela em vez de falhar.
 */
export async function emitirParaVenda(vendaId: string): Promise<CobrancaDaVenda> {
  const existente = await db.cobranca.findUnique({ where: { vendaId } })
  if (existente?.linhaDigitavel) return comQrCode(paraSaida(existente))

  const venda = await db.venda.findUnique({ where: { id: vendaId } })
  if (!venda) throw new Error("Venda não encontrada")
  if (venda.forma !== "prazo") throw new Error("Só venda a prazo gera boleto")
  if (!venda.clienteId || !venda.vencimento) throw new Error("Venda sem cliente ou vencimento")

  const cliente = await db.cliente.findUnique({ where: { id: venda.clienteId } })
  if (!cliente) throw new Error("Cliente não encontrado")

  let codigoSolicitacao = existente?.codigoSolicitacao ?? null

  if (!codigoSolicitacao) {
    try {
      const emitida = await emitirCobranca({
        seuNumero: `PDV${String(venda.numero).padStart(6, "0")}`,
        valor: venda.total,
        vencimento: venda.vencimento,
        pagador: cliente,
        mensagem: `Venda ${venda.numero} - BrasSaco Embalagens`,
      })
      codigoSolicitacao = emitida.codigoSolicitacao
    } catch (erro) {
      const duplicada = codigoDaDuplicata(erro)
      if (!duplicada) throw erro
      codigoSolicitacao = duplicada
    }
  }

  const detalhe = await aguardarEmissao(codigoSolicitacao)

  const gravada = await db.cobranca.upsert({
    where: { vendaId },
    create: {
      vendaId,
      vendaNumero: venda.numero,
      codigoSolicitacao,
      situacao: detalhe.cobranca?.situacao ?? "EM_PROCESSAMENTO",
      valor: venda.total,
      vencimento: venda.vencimento,
      linhaDigitavel: detalhe.boleto?.linhaDigitavel ?? null,
      codigoBarras: detalhe.boleto?.codigoBarras ?? null,
      nossoNumero: detalhe.boleto?.nossoNumero ?? null,
      txid: detalhe.pix?.txid ?? null,
      pixCopiaECola: detalhe.pix?.pixCopiaECola ?? null,
    },
    update: {
      situacao: detalhe.cobranca?.situacao ?? "EM_PROCESSAMENTO",
      linhaDigitavel: detalhe.boleto?.linhaDigitavel ?? null,
      codigoBarras: detalhe.boleto?.codigoBarras ?? null,
      nossoNumero: detalhe.boleto?.nossoNumero ?? null,
      txid: detalhe.pix?.txid ?? null,
      pixCopiaECola: detalhe.pix?.pixCopiaECola ?? null,
    },
  })

  return comQrCode(paraSaida(gravada))
}

function paraSaida(c: {
  codigoSolicitacao: string
  situacao: string
  valor: number
  vencimento: Date
  linhaDigitavel: string | null
  codigoBarras: string | null
  nossoNumero: string | null
  txid: string | null
  pixCopiaECola: string | null
}): Omit<CobrancaDaVenda, "pixQrCode"> {
  return {
    codigoSolicitacao: c.codigoSolicitacao,
    situacao: c.situacao,
    valor: c.valor,
    vencimento: c.vencimento.toISOString(),
    linhaDigitavel: c.linhaDigitavel,
    codigoBarras: c.codigoBarras,
    nossoNumero: c.nossoNumero,
    txid: c.txid,
    pixCopiaECola: c.pixCopiaECola,
  }
}

export async function cobrancaDaVenda(vendaId: string) {
  const c = await db.cobranca.findUnique({ where: { vendaId } })
  return c ? comQrCode(paraSaida(c)) : null
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
