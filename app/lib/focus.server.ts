import "~/lib/env.server"

import type { ModeloNota } from "~/lib/fiscal"

/**
 * Cliente da API da Focus NFe — NFC-e (modelo 65) e NF-e (modelo 55).
 *
 * A Focus fica no meio do caminho entre o PDV e a SEFAZ: recebe a nota em JSON,
 * assina com o certificado que está no painel dela e conversa com a SEFAZ. Por
 * isso aqui não há mTLS como no Inter — o certificado não passa por este
 * processo, e a autenticação é um token em Basic auth.
 *
 * Três coisas moldam este arquivo:
 *
 * 1. **A emissão é assíncrona.** O POST responde 202 com
 *    `status: "processando_autorizacao"`, e o desfecho chega depois — por
 *    consulta ou por webhook. Tratar 202 como erro faria toda nota parecer
 *    falha.
 * 2. **O `ref` é nosso e é a trava.** É o identificador que a Focus associa à
 *    nota; reenviar o mesmo `ref` devolve a nota que já existe em vez de emitir
 *    outra. Sem ele, um duplo clique viraria duas notas pelo mesmo dinheiro.
 * 3. **O ambiente é escolhido pelo token.** Há um token de homologação e um de
 *    produção, e são endereços diferentes. Enquanto só houver o de homologação,
 *    é nele que se emite — e a tela precisa dizer isso em letras grandes, porque
 *    nota de homologação não vale nada.
 */

const URLS = {
  homologacao: "https://homologacao.focusnfe.com.br/v2",
  producao: "https://api.focusnfe.com.br/v2",
} as const

export type Ambiente = keyof typeof URLS

const TEMPO_LIMITE = 20000

export class ErroFocus extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
    readonly codigo?: string
  ) {
    super(mensagem)
    this.name = "ErroFocus"
  }
}

export class FocusNaoConfigurada extends Error {
  constructor() {
    super("Configure FOCUS_NFE_TOKEN_HOMOLOGACAO ou FOCUS_NFE_TOKEN_PRODUCAO no .env")
    this.name = "FocusNaoConfigurada"
  }
}

function variavel(nome: string) {
  const valor = process.env[nome]
  return typeof valor === "string" ? valor.trim() : ""
}

/**
 * O ambiente em que se emite agora.
 *
 * Produção só quando o token dela existe — e a escolha é do ambiente, não da
 * tela: não há botão para emitir em homologação com o token de produção
 * configurado. Misturar os dois é como se emite nota de teste com valor fiscal.
 */
export function ambienteFocus(): Ambiente {
  return variavel("FOCUS_NFE_TOKEN_PRODUCAO") ? "producao" : "homologacao"
}

export function focusConfigurada() {
  return Boolean(variavel("FOCUS_NFE_TOKEN_PRODUCAO") || variavel("FOCUS_NFE_TOKEN_HOMOLOGACAO"))
}

function token() {
  const t = variavel("FOCUS_NFE_TOKEN_PRODUCAO") || variavel("FOCUS_NFE_TOKEN_HOMOLOGACAO")
  if (!t) throw new FocusNaoConfigurada()
  return t
}

/** O que a Focus devolve ao emitir, consultar ou cancelar. */
export type RespostaFocus = {
  status?: string
  status_sefaz?: string
  mensagem_sefaz?: string
  numero?: string
  serie?: string
  chave_nfe?: string
  numero_protocolo?: string
  caminho_danfe?: string
  caminho_xml_nota_fiscal?: string
  caminho_xml_carta_correcao?: string
  qrcode_url?: string
  erros?: Array<{ campo?: string; mensagem?: string }>
  codigo?: string
  mensagem?: string
  [chave: string]: unknown
}

async function chamar(
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: unknown
): Promise<RespostaFocus> {
  const credencial = Buffer.from(`${token()}:`).toString("base64")

  const resposta = await fetch(`${URLS[ambienteFocus()]}${caminho}`, {
    method: metodo,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${credencial}`,
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(TEMPO_LIMITE),
  })

  const texto = await resposta.text()
  let dados: RespostaFocus = {}
  try {
    dados = texto ? (JSON.parse(texto) as RespostaFocus) : {}
  } catch {
    // Resposta não-JSON só acontece quando algo está muito errado do lado de lá;
    // o status HTTP abaixo é o que sobra para explicar.
  }

  /*
   * 202 é sucesso: a nota entrou na fila de autorização. Só o resto dos 4xx/5xx
   * é falha — e a mensagem da Focus vale mais que o status, porque costuma vir
   * com a rejeição da SEFAZ por extenso.
   */
  if (!resposta.ok && resposta.status !== 202) {
    const detalhe =
      dados.mensagem ||
      dados.erros?.map((e) => [e.campo, e.mensagem].filter(Boolean).join(": ")).join(" · ") ||
      texto.slice(0, 200)

    throw new ErroFocus(
      detalhe || `Focus NFe respondeu ${resposta.status}`,
      resposta.status,
      typeof dados.codigo === "string" ? dados.codigo : undefined
    )
  }

  return dados
}

export type { ModeloNota } from "~/lib/fiscal"

/**
 * O endereço completo de um arquivo devolvido pela Focus.
 *
 * `caminho_danfe` e `caminho_xml_nota_fiscal` vêm relativos ("/notas_fiscais/...")
 * e são relativos ao SITE da Focus, não ao /v2 da API — e muito menos ao nosso.
 * Guardar o caminho cru fazia o link do DANFE apontar para o próprio PDV, onde
 * não existe.
 */
export function urlDoArquivo(caminho: string | null | undefined) {
  if (!caminho) return null
  if (/^https?:\/\//.test(caminho)) return caminho
  const site = URLS[ambienteFocus()].replace(/\/v2$/, "")
  return `${site}${caminho.startsWith("/") ? "" : "/"}${caminho}`
}

export function emitirNota(modelo: ModeloNota, ref: string, payload: unknown) {
  return chamar("POST", `/${modelo}?ref=${encodeURIComponent(ref)}`, payload)
}

export function consultarNota(modelo: ModeloNota, ref: string) {
  // `completa=1` traz o XML e os caminhos junto, poupando uma segunda consulta.
  return chamar("GET", `/${modelo}/${encodeURIComponent(ref)}?completa=1`)
}

/**
 * Os gatilhos cadastrados nesta conta — um por evento e CNPJ.
 *
 * Vale conferir antes de criar: cadastrar duas vezes o mesmo evento faz a Focus
 * avisar duas vezes, e o segundo aviso encontra a nota já atualizada.
 */
export async function listarGatilhos(): Promise<
  Array<{ id?: number; url?: string; event?: string; cnpj?: string }>
> {
  const resposta = await chamar("GET", "/hooks")
  return Array.isArray(resposta) ? resposta : []
}

/**
 * Cadastra o gatilho que avisa esta instalação quando a SEFAZ responde.
 *
 * `authorization` vira um cabeçalho que a Focus manda de volta — é o segredo
 * que a rota confere antes de fazer qualquer coisa. Sem ele, a URL pública
 * aceitaria pedido de qualquer um.
 */
export function criarGatilho(entrada: {
  evento: "nfe" | "nfce"
  url: string
  cnpj: string
  segredo?: string
}) {
  return chamar("POST", "/hooks", {
    event: entrada.evento,
    url: entrada.url,
    cnpj: entrada.cnpj,
    ...(entrada.segredo
      ? { authorization: entrada.segredo, authorization_header: "x-focus-segredo" }
      : {}),
  })
}

export function apagarGatilho(id: number) {
  return chamar("DELETE", `/hooks/${id}`)
}

/**
 * Cancela a nota. A justificativa vai para a SEFAZ e é pública: entra no evento
 * de cancelamento, que fica no XML.
 */
export function cancelarNota(modelo: ModeloNota, ref: string, justificativa: string) {
  return chamar("DELETE", `/${modelo}/${encodeURIComponent(ref)}`, { justificativa })
}
