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
  pix?: {
    endToEndId: string
    valor: string
    horario: string
    devolucoes?: unknown[]
    /** Quem pagou. O Banco Central manda quando o participante informa. */
    pagador?: { nome?: string; cpf?: string; cnpj?: string }
    infoPagador?: string
  }[]
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
  /** O Inter devolve o valor como string; guardamos numérico para comparar. */
  valorPago: number | null
  devolucoes: number
  /**
   * Quem pagou, quando o banco informa.
   *
   * Nem toda transação traz — depende do participante de origem. O comprovante
   * omite a linha em vez de imprimir "não informado", que só ocuparia espaço na
   * bobina para dizer que não sabe.
   */
  pagadorNome: string | null
  pagadorDocumento: string | null
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
    pagadorNome: recebido?.pagador?.nome ?? null,
    pagadorDocumento: recebido?.pagador?.cpf ?? recebido?.pagador?.cnpj ?? null,
    valorPago: recebido ? Number(recebido.valor) : null,
    devolucoes: recebido?.devolucoes?.length ?? 0,
  }
}

/**
 * Cria a cobrança imediata do balcão. A doc do Inter indica esse endpoint
 * justamente para "compra em loja física".
 */
export async function criarPixImediato(entrada: {
  /** Conta do Inter da loja que está vendendo — cada uma tem a sua chave Pix. */
  conta: string
  txid: string
  valor: number
  expiracaoSegundos?: number
  solicitacao?: string
  devedor?: { nome: string; cpf?: string; cnpj?: string }
}): Promise<PixImediato> {
  const resposta = await chamarInter<CobRespostaInter>(`/pix/v2/cob/${entrada.txid}`, {
    conta: entrada.conta,
    metodo: "PUT",
    escopos: ["cob.write"],
    corpo: {
      calendario: { expiracao: entrada.expiracaoSegundos ?? 900 },
      valor: { original: entrada.valor.toFixed(2) },
      chave: chavePix(entrada.conta),
      ...(entrada.solicitacao
        ? { solicitacaoPagador: entrada.solicitacao.slice(0, 140) }
        : {}),
      ...(entrada.devedor ? { devedor: entrada.devedor } : {}),
    },
  })

  return paraSaida(resposta)
}

export async function consultarPixImediato(
  txid: string,
  conta: string
): Promise<PixImediato> {
  const resposta = await chamarInter<CobRespostaInter>(`/pix/v2/cob/${txid}`, {
    conta,
    escopos: ["cob.read"],
  })
  return paraSaida(resposta)
}

/**
 * Tira a cobrança do ar no Inter: o QR deixa de aceitar pagamento.
 *
 * Fechar a janela no caixa não basta — a cobrança seguiria valendo até expirar,
 * e o cliente com o QR impresso na mão pagaria uma venda que não existe mais.
 * O Inter só remove cobrança ATIVA; a já paga devolve erro, e quem chama
 * precisa conferir o status para não perder o pagamento.
 */
export async function removerPixImediato(txid: string, conta: string): Promise<PixImediato> {
  const resposta = await chamarInter<CobRespostaInter>(`/pix/v2/cob/${txid}`, {
    conta,
    metodo: "PATCH",
    escopos: ["cob.write"],
    corpo: { status: "REMOVIDA_PELO_USUARIO_RECEBEDOR" },
  })
  return paraSaida(resposta)
}

// ---------------------------------------------------------------------------
// Cobrança com vencimento (cobv): o Pix na entrega
// ---------------------------------------------------------------------------

type CobvRespostaInter = {
  txid: string
  status: string
  valor?: { original?: string }
  pixCopiaECola?: string
  calendario?: { dataDeVencimento?: string; validadeAposVencimento?: number }
  pix?: CobRespostaInter["pix"]
}

export type PixComVencimento = {
  txid: string
  status: string
  valor: number
  pixCopiaECola: string | null
  /** AAAA-MM-DD, como o Inter devolve. */
  vencimento: string | null
  validadeAposVencimento: number
  pagoEm: string | null
  valorPago: number | null
  devolucoes: number
}

function cobvParaSaida(dados: CobvRespostaInter): PixComVencimento {
  const recebido = dados.pix?.[0]
  return {
    txid: dados.txid,
    status: dados.status,
    valor: Number(dados.valor?.original ?? 0),
    pixCopiaECola: dados.pixCopiaECola ?? null,
    vencimento: dados.calendario?.dataDeVencimento ?? null,
    validadeAposVencimento: dados.calendario?.validadeAposVencimento ?? 0,
    pagoEm: recebido?.horario ?? null,
    valorPago: recebido ? Number(recebido.valor) : null,
    devolucoes: recebido?.devolucoes?.length ?? 0,
  }
}

/**
 * Cria a cobrança Pix com vencimento — a do Pix na entrega.
 *
 * Diferente da imediata do balcão, que expira em minutos: esta vale até o
 * vencimento e mais `validadeAposVencimento` dias, o tempo de o entregador
 * chegar. O Banco Central exige o devedor (nome e CPF ou CNPJ) neste tipo.
 */
export async function criarPixComVencimento(entrada: {
  conta: string
  txid: string
  valor: number
  /** AAAA-MM-DD. */
  vencimento: string
  validadeAposVencimento: number
  devedor: { nome: string; cpf?: string; cnpj?: string }
  solicitacao?: string
}): Promise<PixComVencimento> {
  const resposta = await chamarInter<CobvRespostaInter>(`/pix/v2/cobv/${entrada.txid}`, {
    conta: entrada.conta,
    metodo: "PUT",
    escopos: ["cobv.write"],
    corpo: {
      calendario: {
        dataDeVencimento: entrada.vencimento,
        validadeAposVencimento: entrada.validadeAposVencimento,
      },
      devedor: entrada.devedor,
      valor: { original: entrada.valor.toFixed(2) },
      chave: chavePix(entrada.conta),
      ...(entrada.solicitacao
        ? { solicitacaoPagador: entrada.solicitacao.slice(0, 140) }
        : {}),
    },
  })
  return cobvParaSaida(resposta)
}

export async function consultarPixComVencimento(
  txid: string,
  conta: string
): Promise<PixComVencimento> {
  const resposta = await chamarInter<CobvRespostaInter>(`/pix/v2/cobv/${txid}`, {
    conta,
    escopos: ["cobv.read"],
  })
  return cobvParaSaida(resposta)
}

/** Tira do ar: o QR deixa de aceitar pagamento. Só funciona com a cobrança ATIVA. */
export async function removerPixComVencimento(txid: string, conta: string) {
  const resposta = await chamarInter<CobvRespostaInter>(`/pix/v2/cobv/${txid}`, {
    conta,
    metodo: "PATCH",
    escopos: ["cobv.write"],
    corpo: { status: "REMOVIDA_PELO_USUARIO_RECEBEDOR" },
  })
  return cobvParaSaida(resposta)
}

export type ConfirmacaoPix =
  | { pago: true; pix: PixImediato }
  | { pago: false; motivo: string; pix: PixImediato }

/**
 * Decide se o pagamento pode liberar a venda.
 *
 * `CONCLUIDA` sozinho não basta. Confere também que o valor pago é o esperado e
 * que não houve devolução — sem isso, uma cobrança de centavos poderia liberar
 * uma venda de qualquer tamanho, ou mercadoria sairia depois de o dinheiro voltar.
 */
export function confirmarPagamento(pix: PixImediato, valorEsperado: number): ConfirmacaoPix {
  if (pix.status !== "CONCLUIDA") {
    return { pago: false, motivo: `Pagamento não confirmado (${pix.status})`, pix }
  }
  if (pix.devolucoes > 0) {
    return { pago: false, motivo: "O Pix foi devolvido", pix }
  }
  if (pix.valorPago === null) {
    return { pago: false, motivo: "Cobrança concluída sem Pix registrado", pix }
  }
  // Centavos: comparar em inteiros evita o erro de ponto flutuante.
  if (Math.round(pix.valorPago * 100) !== Math.round(valorEsperado * 100)) {
    return {
      pago: false,
      motivo: `Valor pago (${pix.valorPago}) diferente do total da venda (${valorEsperado})`,
      pix,
    }
  }
  return { pago: true, pix }
}

/** `CONCLUIDA` é o status do Pix pago. Use `confirmarPagamento` para liberar venda. */
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
export async function simularPagamentoPorQrCode(conta: string, qrCode: string, valor: number) {
  if (!process.env.INTER_BASE_URL?.includes("sandbox")) {
    throw new Error("Simulação de pagamento só existe no sandbox")
  }
  return chamarInter(`/pix/v2/sandbox/cob/pagamento`, {
    conta,
    metodo: "POST",
    escopos: ["pix.write"],
    corpo: { qrCode, valor },
  })
}

export async function simularPagamentoPix(conta: string, txid: string, valor: number) {
  if (!process.env.INTER_BASE_URL?.includes("sandbox")) {
    throw new Error("Simulação de pagamento só existe no sandbox")
  }
  // Pede escopo pix.write (não cob.write) e o corpo com o valor pago.
  return chamarInter<{ e2e: string }>(`/pix/v2/cob/pagar/${txid}`, {
    conta,
    metodo: "POST",
    escopos: ["pix.write"],
    corpo: { valor },
  })
}
