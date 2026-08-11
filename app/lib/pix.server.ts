import { randomBytes } from "node:crypto"
import QRCode from "qrcode"

import { chamarInter, chavePix } from "~/lib/inter.server"

/** O txid é criado por nós: 26–35 caracteres alfanuméricos, único por CNPJ. */
export function novoTxid() {
  const agora = Date.now().toString(36)
  const aleatorio = randomBytes(12).toString("hex")
  return `PDV${agora}${aleatorio}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 35)
}

type CobRespostaInter = {
  txid: string
  status: string
  valor?: { original?: string }
  pixCopiaECola?: string
  calendario?: { expiracao?: number; criacao?: string }
  pix?: { endToEndId: string; valor: string; horario: string }[]
}

export type PixImediato = {
  txid: string
  status: string
  valor: number
  pixCopiaECola: string | null
  pixQrCode: string | null
  expiracaoSegundos: number
  /** Preenchido quando o pagamento entra. */
  pagoEm: string | null
  endToEndId: string | null
}

async function paraSaida(dados: CobRespostaInter): Promise<PixImediato> {
  const copia = dados.pixCopiaECola ?? null
  const recebido = dados.pix?.[0]

  return {
    txid: dados.txid,
    status: dados.status,
    valor: Number(dados.valor?.original ?? 0),
    pixCopiaECola: copia,
    pixQrCode: copia
      ? await QRCode.toDataURL(copia, { errorCorrectionLevel: "M", margin: 1, width: 320 })
      : null,
    expiracaoSegundos: dados.calendario?.expiracao ?? 0,
    pagoEm: recebido?.horario ?? null,
    endToEndId: recebido?.endToEndId ?? null,
  }
}

/**
 * Cria a cobrança imediata do balcão. A doc do Inter indica esse endpoint
 * justamente para "compra em loja física".
 */
export async function criarPixImediato(entrada: {
  txid: string
  valor: number
  expiracaoSegundos?: number
  solicitacao?: string
  devedor?: { nome: string; cpf?: string; cnpj?: string }
}): Promise<PixImediato> {
  const resposta = await chamarInter<CobRespostaInter>(`/pix/v2/cob/${entrada.txid}`, {
    metodo: "PUT",
    escopos: ["cob.write"],
    corpo: {
      calendario: { expiracao: entrada.expiracaoSegundos ?? 900 },
      valor: { original: entrada.valor.toFixed(2) },
      chave: chavePix(),
      ...(entrada.solicitacao
        ? { solicitacaoPagador: entrada.solicitacao.slice(0, 140) }
        : {}),
      ...(entrada.devedor ? { devedor: entrada.devedor } : {}),
    },
  })

  return paraSaida(resposta)
}

export async function consultarPixImediato(txid: string): Promise<PixImediato> {
  const resposta = await chamarInter<CobRespostaInter>(`/pix/v2/cob/${txid}`, {
    escopos: ["cob.read"],
  })
  return paraSaida(resposta)
}

/** `CONCLUIDA` é o status do Pix pago. */
export function pixFoiPago(pix: PixImediato) {
  return pix.status === "CONCLUIDA"
}

/**
 * Simulador do sandbox: marca a cobrança como paga. Não existe em produção —
 * por isso a checagem da URL, para nunca ser chamado por engano contra a conta real.
 */
/**
 * Simulador alternativo do sandbox, que paga pelo copia-e-cola. O simulador por
 * txid (`/cob/pagar/{txid}`) andou devolvendo 500 do lado do Inter, então este
 * serve de caminho B para validar o fluxo.
 */
export async function simularPagamentoPorQrCode(qrCode: string, valor: number) {
  if (!process.env.INTER_BASE_URL?.includes("sandbox")) {
    throw new Error("Simulação de pagamento só existe no sandbox")
  }
  return chamarInter(`/pix/v2/sandbox/cob/pagamento`, {
    metodo: "POST",
    escopos: ["pix.write"],
    corpo: { qrCode, valor },
  })
}

export async function simularPagamentoPix(txid: string, valor: number) {
  if (!process.env.INTER_BASE_URL?.includes("sandbox")) {
    throw new Error("Simulação de pagamento só existe no sandbox")
  }
  // Pede escopo pix.write (não cob.write) e o corpo com o valor pago.
  return chamarInter<{ e2e: string }>(`/pix/v2/cob/pagar/${txid}`, {
    metodo: "POST",
    escopos: ["pix.write"],
    corpo: { valor },
  })
}
