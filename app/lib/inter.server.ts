import "~/lib/env.server"

import { createPrivateKey, X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { Agent } from "undici"

/**
 * Cliente da API do Banco Inter, **por conta**.
 *
 * A rede tem quatro lojas e TRÊS contas: QI e QNE são matriz e filial e
 * compartilham a conta; NRT e SDS têm a sua. Cada conta é um par de credenciais e
 * um certificado próprios — então config, agente mTLS e token são guardados por
 * código de conta. Um cache global emitiria o boleto de uma loja na conta de
 * outra, o que é erro de dinheiro, não de tela.
 *
 * Três particularidades moldam este arquivo:
 *
 * 1. A API exige mTLS. O `fetch` global do Node não aceita certificado de
 *    cliente por opção de request — é preciso passar um `dispatcher` do undici
 *    com o par certificado/chave.
 * 2. O endpoint de token aceita **5 chamadas por minuto** e o token vale 1 hora.
 *    Sem cache, um caixa movimentado seria bloqueado em segundos. O limite é por
 *    credencial, então cada conta tem o seu balde.
 * 3. As variáveis são nomeadas pela conta: INTER_MATRIZ_CLIENT_ID, INTER_NRT_CERT…
 *    A conta em INTER_CONTA_PADRAO aceita também os nomes sem prefixo, que é como
 *    a instalação de loja única já está configurada.
 */

export type EscopoInter =
  | "boleto-cobranca.read"
  | "boleto-cobranca.write"
  | "cob.read"
  | "cob.write"
  | "pix.read"
  | "pix.write"
  | "webhook.read"
  | "webhook.write"

type Config = {
  baseUrl: string
  clientId: string
  clientSecret: string
  cert: Buffer
  key: Buffer
  contaCorrente?: string
  chavePix?: string
}

const configPorConta = new Map<string, Config>()
const agentePorConta = new Map<string, Agent>()

/**
 * A conta que aceita as variáveis sem prefixo (INTER_CLIENT_ID etc.).
 *
 * O fallback vale SÓ para ela, de propósito: se valesse para todas, uma conta sem
 * configuração emitiria calada com as credenciais da matriz — boleto no CNPJ
 * errado, descoberto pelo contador semanas depois. Faltando configuração, é erro.
 */
function contaPadrao() {
  return process.env.INTER_CONTA_PADRAO || "MATRIZ"
}

/** Nome da variável de uma conta, com o nome sem prefixo como reserva. */
function doAmbiente(conta: string, sufixo: string): string | undefined {
  const especifica = process.env[`INTER_${conta}_${sufixo}`]
  if (especifica) return especifica
  return conta === contaPadrao() ? process.env[`INTER_${sufixo}`] : undefined
}

export class InterNaoConfigurado extends Error {}

export class ErroInter extends Error {
  constructor(
    readonly status: number,
    readonly corpo: unknown,
    mensagem: string
  ) {
    super(mensagem)
  }
}

/**
 * Lê um PEM do ambiente. Aceita o conteúdo direto na variável (com `\n` reais ou
 * escapados) ou em base64 — painéis como o easypanel costumam estragar quebras de
 * linha, então base64 é o caminho seguro. Se nenhuma vier, cai no arquivo.
 */
function pemDeAmbiente(conta: string, sufixo: string): Buffer | null {
  const varConteudo = `INTER_${conta}_${sufixo}`
  const conteudo = doAmbiente(conta, sufixo)

  if (conteudo) {
    if (conteudo.includes("-----BEGIN")) {
      return Buffer.from(conteudo.replace(/\\n/g, "\n"))
    }
    const decodificado = Buffer.from(conteudo, "base64")
    if (!decodificado.toString("utf8").includes("-----BEGIN")) {
      throw new InterNaoConfigurado(`${varConteudo} não parece um PEM nem base64 de um PEM`)
    }
    return decodificado
  }

  const caminho = doAmbiente(conta, `${sufixo}_PATH`)
  return caminho ? readFileSync(caminho) : null
}

/**
 * O certificado é do ambiente certo?
 *
 * Sandbox e produção são autoridades certificadoras DIFERENTES — "UAT Partners
 * CDPJ Certificate Authority" contra "API Intermediate Certificate Authority" — e
 * cada host só confia na sua. Cruzar os dois faz o Inter derrubar o handshake com
 * `tlsv1 alert unknown ca`, um erro de OpenSSL que não diz nada sobre a causa.
 *
 * Vale conferir aqui porque a situação é comum: a conta da matriz tem certificado
 * de sandbox para desenvolvimento, mas NRT e SDS só têm o de produção. Rodar local
 * apontando para o sandbox e mexer numa venda dessas lojas cai exatamente nisso.
 */
function ambienteDoCertificado(cert: Buffer): "sandbox" | "producao" | null {
  try {
    const emissor = new X509Certificate(cert).issuer
    if (/UAT/i.test(emissor)) return "sandbox"
    if (/API Intermediate/i.test(emissor)) return "producao"
    return null
  } catch {
    return null
  }
}

function lerConfig(conta: string): Config {
  const guardada = configPorConta.get(conta)
  if (guardada) return guardada

  // A base (sandbox ou produção) é do ambiente inteiro, não da conta: não faz
  // sentido uma loja em teste e outra em produção no mesmo processo.
  const baseUrl = process.env.INTER_BASE_URL
  const clientId = doAmbiente(conta, "CLIENT_ID")
  const clientSecret = doAmbiente(conta, "CLIENT_SECRET")
  // Em produção o certificado vem por variável (o arquivo não entra na imagem,
  // por decisão: chave privada não pertence a uma layer do Docker). Em dev, o
  // caminho no disco é mais prático.
  const cert = pemDeAmbiente(conta, "CERT")
  const key = pemDeAmbiente(conta, "KEY")

  const faltando = Object.entries({
    INTER_BASE_URL: baseUrl,
    [`INTER_${conta}_CLIENT_ID`]: clientId,
    [`INTER_${conta}_CLIENT_SECRET`]: clientSecret,
    [`INTER_${conta}_CERT`]: cert,
    [`INTER_${conta}_KEY`]: key,
  })
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome)

  if (faltando.length > 0) {
    throw new InterNaoConfigurado(
      `Conta ${conta} não configurada. Faltam: ${faltando.join(", ")}`
    )
  }

  const alvo = baseUrl!.includes("sandbox") || baseUrl!.includes("uatinter")
    ? "sandbox"
    : "producao"
  const doCert = ambienteDoCertificado(cert!)
  if (doCert && doCert !== alvo) {
    throw new InterNaoConfigurado(
      `A conta ${conta} tem certificado de ${doCert.toUpperCase()} e INTER_BASE_URL ` +
        `aponta para ${alvo.toUpperCase()}. O Inter recusaria o handshake com ` +
        `"unknown ca". Use o certificado do ambiente, ou troque a INTER_BASE_URL.`
    )
  }

  const config: Config = {
    baseUrl: baseUrl!.replace(/\/$/, ""),
    clientId: clientId!,
    clientSecret: clientSecret!,
    cert: cert!,
    key: key!,
    contaCorrente: doAmbiente(conta, "CONTA_CORRENTE") || undefined,
    chavePix: doAmbiente(conta, "CHAVE_PIX") || undefined,
  }
  configPorConta.set(conta, config)
  return config
}

export function interConfigurado(conta: string) {
  try {
    lerConfig(conta)
    return true
  } catch {
    return false
  }
}

/**
 * O que o certificado da conta diz sobre si: de quem é e até quando vale.
 *
 * Serve ao /saude, e existe porque certificado do Inter vale um ano e vence
 * calado — a emissão simplesmente para de funcionar num dia qualquer, com a
 * mensagem genérica de handshake. Melhor ver "vence em 12 dias" antes.
 *
 * Também confere o titular: cada conta é de um CNPJ diferente, e parear o
 * certificado de uma empresa com as credenciais de outra dá 401.
 */
export function certificadoDaConta(conta: string) {
  try {
    // Lê o PEM direto, sem passar pela config completa: o certificado existir não
    // depende de a credencial existir, e mostrar "null" só porque falta o
    // client_id esconderia justamente o que já está pronto.
    const cert = pemDeAmbiente(conta, "CERT")
    if (!cert) return null

    const key = pemDeAmbiente(conta, "KEY")
    const x509 = new X509Certificate(cert)
    const vence = new Date(x509.validTo)
    const dias = Math.floor((vence.getTime() - Date.now()) / 86_400_000)

    const base = process.env.INTER_BASE_URL ?? ""
    const alvo = base.includes("sandbox") || base.includes("uatinter") ? "sandbox" : "producao"
    const ambiente = ambienteDoCertificado(cert)

    return {
      titular: x509.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) ?? null,
      venceEm: vence.toISOString().slice(0, 10),
      diasParaVencer: dias,
      // Um mês é tempo suficiente para pedir outro no portal sem correria.
      renovar: dias < 30,
      ambiente,
      // Os três motivos pelos quais um certificado correto ainda não serve.
      ambienteConfere: ambiente === null || ambiente === alvo,
      chaveCombina: key ? x509.checkPrivateKey(createPrivateKey(key)) : null,
    }
  } catch {
    return null
  }
}

export function chavePixConfigurada(conta: string) {
  try {
    return Boolean(lerConfig(conta).chavePix)
  } catch {
    return false
  }
}

function agente(conta: string) {
  const guardado = agentePorConta.get(conta)
  if (guardado) return guardado

  const { cert, key } = lerConfig(conta)
  const novo = new Agent({ connect: { cert, key } })
  agentePorConta.set(conta, novo)
  return novo
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------


type TokenCache = { valor: string; escopos: Set<EscopoInter>; expiraEm: number }

// Por conta: o token de uma conta não vale na outra, e o limite de 5 chamadas por
// minuto do endpoint de token é por credencial.
const tokenPorConta = new Map<string, TokenCache>()
const emVooPorConta = new Map<string, Promise<string>>()

/**
 * Todos os escopos que o app usa. O token é pedido para o conjunto inteiro de uma
 * só vez, de propósito: o endpoint de token aceita 5 chamadas por minuto, e pedir
 * um token por combinação de escopo (venda, boleto, pix, webhook) estourava esse
 * limite numa única operação.
 */
const ESCOPOS_DO_APP: EscopoInter[] = [
  "boleto-cobranca.read",
  "boleto-cobranca.write",
  "cob.read",
  "cob.write",
  "pix.read",
  "pix.write",
  "webhook.read",
  "webhook.write",
]

/** Se algum escopo não estiver liberado, o pedido inteiro falha; aí pedimos só o necessário. */
const conjuntoCompletoFalhou = new Set<string>()

function cobre(cache: TokenCache, escopos: EscopoInter[]) {
  return escopos.every((escopo) => cache.escopos.has(escopo))
}

export async function obterToken(conta: string, escopos: EscopoInter[]): Promise<string> {
  const guardado = tokenPorConta.get(conta)
  if (guardado && cobre(guardado, escopos) && guardado.expiraEm > Date.now() + 60_000) {
    return guardado.valor
  }
  const jaPedindo = emVooPorConta.get(conta)
  if (jaPedindo) return jaPedindo

  const pedido = (async () => {
    if (conjuntoCompletoFalhou.has(conta)) return pedirToken(conta, escopos)

    try {
      return await pedirToken(conta, ESCOPOS_DO_APP)
    } catch (erro) {
      if (!(erro instanceof ErroInter) || erro.status !== 401) throw erro
      conjuntoCompletoFalhou.add(conta)
      return pedirToken(conta, escopos)
    }
  })().finally(() => {
    emVooPorConta.delete(conta)
  })

  emVooPorConta.set(conta, pedido)
  return pedido
}

async function pedirToken(conta: string, escopos: EscopoInter[]): Promise<string> {
  const { baseUrl, clientId, clientSecret } = lerConfig(conta)

  const resposta = await fetch(`${baseUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: [...escopos].sort().join(" "),
    }),
    dispatcher: agente(conta),
  } as RequestInit)

  const corpo = await resposta.text()
  if (!resposta.ok) {
    throw new ErroInter(
      resposta.status,
      corpo,
      resposta.status === 429
        ? "Limite de chamadas do token excedido"
        : `Falha ao obter token (${resposta.status})`
    )
  }

  const dados = JSON.parse(corpo) as { access_token: string; expires_in: number }
  const novo: TokenCache = {
    valor: dados.access_token,
    escopos: new Set(escopos),
    expiraEm: Date.now() + dados.expires_in * 1000,
  }
  tokenPorConta.set(conta, novo)
  return novo.valor
}

/** Só para os testes: descarta os tokens guardados. */
export function esquecerToken() {
  tokenPorConta.clear()
}


// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------

type OpcoesChamada = {
  metodo?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  corpo?: unknown
  escopos: EscopoInter[]
  /** Código da ContaInter. Obrigatório: não existe chamada "da conta genérica". */
  conta: string
  /** Alguns endpoints devolvem PDF/binário em vez de JSON. */
  bruto?: boolean
}

/** Espera recomendada pela doc do Inter para o 429: alguns segundos. */
const ESPERAS_429 = [2000, 5000, 10_000]

export async function chamarInter<T = unknown>(
  caminho: string,
  opcoes: OpcoesChamada
): Promise<T> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      return await chamarUmaVez<T>(caminho, opcoes)
    } catch (erro) {
      const espera =
        erro instanceof ErroInter && erro.status === 429 ? ESPERAS_429[tentativa] : undefined
      if (espera === undefined) throw traduzirErroDeTls(erro, opcoes.conta)
      await new Promise((r) => setTimeout(r, espera))
    }
  }
}

/**
 * Erro de TLS chega como código do OpenSSL, ilegível para quem opera. Vira frase.
 * A checagem em `lerConfig` deve pegar o caso comum antes; isto é a rede embaixo.
 */
function traduzirErroDeTls(erro: unknown, conta: string): unknown {
  const codigo =
    (erro as { code?: string })?.code ??
    ((erro as { cause?: { code?: string } })?.cause?.code ?? "")

  if (codigo === "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA") {
    return new InterNaoConfigurado(
      `O Inter recusou o certificado da conta ${conta} ("unknown ca"). ` +
        "Quase sempre é certificado de um ambiente com INTER_BASE_URL do outro."
    )
  }
  if (codigo === "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED") {
    return new InterNaoConfigurado(
      `O certificado da conta ${conta} está expirado — emita outro no portal do Inter.`
    )
  }
  return erro
}

async function chamarUmaVez<T>(
  caminho: string,
  { metodo = "GET", corpo, escopos, conta, bruto = false }: OpcoesChamada
): Promise<T> {
  const { baseUrl, contaCorrente } = lerConfig(conta)
  // Barra dupla no path faz o Inter responder 406, conforme a doc de erros.
  const rota = caminho.startsWith("/") ? caminho.replace(/\/{2,}/g, "/") : `/${caminho}`
  const acesso = await obterToken(conta, escopos)

  const cabecalhos: Record<string, string> = {
    authorization: `Bearer ${acesso}`,
    // Alguns endpoints (cancelar, por exemplo) recusam "application/json" e só
    // declaram suportar "application/problem+json". `*/*` serve a todos.
    accept: "*/*",
  }
  if (corpo !== undefined) cabecalhos["content-type"] = "application/json"
  if (contaCorrente) cabecalhos["x-conta-corrente"] = contaCorrente

  const resposta = await fetch(`${baseUrl}${rota}`, {
    method: metodo,
    headers: cabecalhos,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    dispatcher: agente(conta),
  } as RequestInit)

  if (bruto) {
    if (!resposta.ok) {
      throw new ErroInter(resposta.status, await resposta.text(), `Inter ${resposta.status}`)
    }
    return (await resposta.arrayBuffer()) as T
  }

  const texto = await resposta.text()
  const dados = texto ? seguroJson(texto) : null

  if (!resposta.ok) {
    throw new ErroInter(resposta.status, dados ?? texto, mensagemDeErro(resposta.status, dados))
  }

  return dados as T
}

function seguroJson(texto: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    return texto
  }
}

/**
 * Mensagens conforme https://developers.inter.co/erros-status-code — sem isso, os
 * códigos sem corpo (400, 406, 429) chegavam ao operador como "Inter respondeu 400".
 */
const PORTATUS: Record<number, string> = {
  400: "Requisição inválida — se vier sem detalhe, o certificado não foi enviado",
  401: "Credenciais ou token inválidos, ou o escopo não está registrado na integração",
  403: "O token não tem os escopos necessários para este endpoint",
  406: "Recusado pelo firewall do Inter (IP dinâmico de cloud) ou caminho malformado",
  422: "Regra de negócio não atendida",
  429: "Limite de chamadas por minuto excedido",
}

/** O Inter devolve `title`/`detail` (RFC 7807) e às vezes uma lista de violações. */
function mensagemDeErro(status: number, dados: unknown): string {
  if (typeof dados === "object" && dados !== null) {
    const erro = dados as {
      title?: string
      detail?: string
      violacoes?: { razao?: string; propriedade?: string }[]
    }
    const violacao = erro.violacoes?.[0]
    if (violacao?.razao) {
      return `${violacao.razao}${violacao.propriedade ? ` (${violacao.propriedade})` : ""}`
    }
    if (erro.detail) return erro.detail
    if (erro.title) return erro.title
  }
  // Corpo vazio ou irreconhecível: a doc de status code explica o que significa.
  return PORTATUS[status] ?? `Inter respondeu ${status}`
}

export function chavePix(conta: string) {
  const { chavePix } = lerConfig(conta)
  if (!chavePix) {
    throw new InterNaoConfigurado(`Conta ${conta} sem chave Pix (INTER_${conta}_CHAVE_PIX)`)
  }
  return chavePix
}

// ---------------------------------------------------------------------------
// Registro dos webhooks
// ---------------------------------------------------------------------------

/**
 * Registra APENAS o webhook de Cobrança (boleto).
 *
 * O de Pix ficou de fora de propósito: o Inter aceita **um** destino por chave
 * Pix, e a chave desta conta já é usada por outro sistema da empresa. Registrar
 * aqui desviaria as notificações de pagamento dele — foi o que aconteceu uma vez,
 * e por sorte nenhum Pix caiu na janela. O PDV confirma Pix consultando
 * `GET /pix/v2/cob/{txid}`, que é o certo para o balcão: o cliente está na frente
 * e a resposta precisa ser imediata.
 *
 * Antes de gravar, consulta o destino atual e **recusa** sobrescrever URL de
 * terceiro. `sobrescrever: true` é a única forma de forçar, e deve ser decisão
 * consciente de quem chama.
 */
export async function registrarWebhookCobranca(
  conta: string,
  baseUrlPublica: string,
  { sobrescrever = false } = {}
) {
  const raiz = baseUrlPublica.replace(/\/$/, "")
  if (!raiz.startsWith("https://")) {
    throw new Error("A URL do webhook precisa ser HTTPS")
  }
  // Uma URL por conta: o log diz de qual conta veio o retorno, e um callback
  // desviado não encosta nos dados de outra conta.
  const desejada = `${raiz}/webhooks/inter/cobranca/${conta}`

  const atual = await chamarInter<{ webhookUrl?: string }>(
    "/cobranca/v3/cobrancas/webhook",
    { conta, escopos: ["boleto-cobranca.read"] }
  ).catch(() => null)

  if (atual?.webhookUrl && atual.webhookUrl !== desejada && !sobrescrever) {
    throw new Error(
      `A conta ${conta} já tem webhook de cobrança apontando para ${atual.webhookUrl}. ` +
        "Se substituir é intencional, chame com { sobrescrever: true }."
    )
  }

  await chamarInter("/cobranca/v3/cobrancas/webhook", {
    conta,
    metodo: "PUT",
    escopos: ["boleto-cobranca.write"],
    corpo: { webhookUrl: desejada },
  })

  return { webhookUrl: desejada, anterior: atual?.webhookUrl ?? null }
}

/** Só leitura: útil para conferir sem risco de sobrescrever nada. */
export async function consultarWebhooks(conta: string) {
  const cobranca = await chamarInter("/cobranca/v3/cobrancas/webhook", {
    conta,
    escopos: ["boleto-cobranca.read"],
  }).catch((e) => ({ erro: String(e?.message ?? e) }))

  const pix = await chamarInter<Record<string, unknown>>(
    `/pix/v2/webhook/${chavePix(conta)}`,
    { conta, escopos: ["webhook.read"] }
  ).catch((e) => ({ erro: String(e?.message ?? e) }))

  // O de Pix aparece só para conferência — o PDV não o gerencia.
  return { cobranca, pix, pixGerenciadoPeloPdv: false }
}
