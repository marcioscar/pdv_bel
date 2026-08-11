import "~/lib/env.server"

import { readFileSync } from "node:fs"
import { Agent } from "undici"

/**
 * Cliente da API do Banco Inter.
 *
 * Duas particularidades moldam este arquivo:
 *
 * 1. A API exige mTLS. O `fetch` global do Node não aceita certificado de
 *    cliente por opção de request — é preciso passar um `dispatcher` do undici
 *    com o par certificado/chave.
 * 2. O endpoint de token aceita **5 chamadas por minuto** e o token vale 1 hora.
 *    Sem cache, um caixa movimentado seria bloqueado em segundos.
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

let configCache: Config | null = null
let agenteCache: Agent | null = null

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
function pemDeAmbiente(varConteudo: string, varCaminho: string): Buffer | null {
  const conteudo = process.env[varConteudo]

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

  const caminho = process.env[varCaminho]
  return caminho ? readFileSync(caminho) : null
}

function lerConfig(): Config {
  if (configCache) return configCache

  const baseUrl = process.env.INTER_BASE_URL
  const clientId = process.env.INTER_CLIENT_ID
  const clientSecret = process.env.INTER_CLIENT_SECRET
  // Em produção o certificado vem por variável (o arquivo não entra na imagem,
  // por decisão: chave privada não pertence a uma layer do Docker). Em dev, o
  // caminho no disco é mais prático.
  const cert = pemDeAmbiente("INTER_CERT", "INTER_CERT_PATH")
  const key = pemDeAmbiente("INTER_KEY", "INTER_KEY_PATH")

  const faltando = Object.entries({
    INTER_BASE_URL: baseUrl,
    INTER_CLIENT_ID: clientId,
    INTER_CLIENT_SECRET: clientSecret,
    "INTER_CERT ou INTER_CERT_PATH": cert,
    "INTER_KEY ou INTER_KEY_PATH": key,
  })
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome)

  if (faltando.length > 0) {
    throw new InterNaoConfigurado(`Faltam variáveis: ${faltando.join(", ")}`)
  }

  configCache = {
    baseUrl: baseUrl!.replace(/\/$/, ""),
    clientId: clientId!,
    clientSecret: clientSecret!,
    cert: cert!,
    key: key!,
    contaCorrente: process.env.INTER_CONTA_CORRENTE || undefined,
    chavePix: process.env.INTER_CHAVE_PIX || undefined,
  }

  return configCache
}

export function interConfigurado() {
  try {
    lerConfig()
    return true
  } catch {
    return false
  }
}

export function chavePixConfigurada() {
  return Boolean(lerConfig().chavePix)
}

function agente() {
  if (agenteCache) return agenteCache
  const { cert, key } = lerConfig()
  agenteCache = new Agent({ connect: { cert, key } })
  return agenteCache
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------


type TokenCache = { valor: string; escopos: Set<EscopoInter>; expiraEm: number }

let token: TokenCache | null = null
let emVoo: Promise<string> | null = null

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
let usarConjuntoCompleto = true

function cobre(cache: TokenCache, escopos: EscopoInter[]) {
  return escopos.every((escopo) => cache.escopos.has(escopo))
}

export async function obterToken(escopos: EscopoInter[]): Promise<string> {
  if (token && cobre(token, escopos) && token.expiraEm > Date.now() + 60_000) {
    return token.valor
  }
  if (emVoo) return emVoo

  emVoo = (async () => {
    if (!usarConjuntoCompleto) return pedirToken(escopos)

    try {
      return await pedirToken(ESCOPOS_DO_APP)
    } catch (erro) {
      if (!(erro instanceof ErroInter) || erro.status !== 401) throw erro
      usarConjuntoCompleto = false
      return pedirToken(escopos)
    }
  })().finally(() => {
    emVoo = null
  })

  return emVoo
}

async function pedirToken(escopos: EscopoInter[]): Promise<string> {
  const { baseUrl, clientId, clientSecret } = lerConfig()

  const resposta = await fetch(`${baseUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: [...escopos].sort().join(" "),
    }),
    dispatcher: agente(),
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
  token = {
    valor: dados.access_token,
    escopos: new Set(escopos),
    expiraEm: Date.now() + dados.expires_in * 1000,
  }
  return token.valor
}

/** Só para os testes: descarta o token guardado. */
export function esquecerToken() {
  token = null
}


// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------

type OpcoesChamada = {
  metodo?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  corpo?: unknown
  escopos: EscopoInter[]
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
      if (espera === undefined) throw erro
      await new Promise((r) => setTimeout(r, espera))
    }
  }
}

async function chamarUmaVez<T>(
  caminho: string,
  { metodo = "GET", corpo, escopos, bruto = false }: OpcoesChamada
): Promise<T> {
  const { baseUrl, contaCorrente } = lerConfig()
  // Barra dupla no path faz o Inter responder 406, conforme a doc de erros.
  const rota = caminho.startsWith("/") ? caminho.replace(/\/{2,}/g, "/") : `/${caminho}`
  const acesso = await obterToken(escopos)

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
    dispatcher: agente(),
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

export function chavePix() {
  const { chavePix } = lerConfig()
  if (!chavePix) throw new InterNaoConfigurado("INTER_CHAVE_PIX não configurada")
  return chavePix
}

// ---------------------------------------------------------------------------
// Registro dos webhooks
// ---------------------------------------------------------------------------

/**
 * Aponta os webhooks do Inter para a URL pública do app. Precisa ser HTTPS e
 * estar respondendo — o Inter valida a URL no momento do cadastro.
 */
export async function registrarWebhooks(baseUrlPublica: string) {
  const raiz = baseUrlPublica.replace(/\/$/, "")
  if (!raiz.startsWith("https://")) {
    throw new Error("A URL do webhook precisa ser HTTPS")
  }

  // Cada API tem o seu escopo de webhook: a de Cobrança usa boleto-cobranca.*,
  // e webhook.* pertence só à API Pix. Trocar os dois dá 401.
  const cobranca = await chamarInter("/cobranca/v3/cobrancas/webhook", {
    metodo: "PUT",
    escopos: ["boleto-cobranca.write"],
    corpo: { webhookUrl: `${raiz}/webhooks/inter/cobranca` },
  })

  const pix = await chamarInter(`/pix/v2/webhook/${chavePix()}`, {
    metodo: "PUT",
    escopos: ["webhook.write"],
    corpo: { webhookUrl: `${raiz}/webhooks/inter/pix` },
  })

  return { cobranca, pix }
}

export async function consultarWebhooks() {
  const [cobranca, pix] = await Promise.all([
    chamarInter("/cobranca/v3/cobrancas/webhook", { escopos: ["boleto-cobranca.read"] }).catch(
      (e) => ({ erro: String(e.message ?? e) })
    ),
    chamarInter(`/pix/v2/webhook/${chavePix()}`, { escopos: ["webhook.read"] }).catch(
      (e) => ({ erro: String(e.message ?? e) })
    ),
  ])
  return { cobranca, pix }
}
