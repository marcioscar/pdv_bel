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
 *    produção, e são endereços diferentes. Enquanto não houver nenhum de
 *    produção, é em homologação que se emite — e a tela precisa dizer isso em
 *    letras grandes, porque nota de homologação não vale nada.
 * 4. **O token é POR EMPRESA, não da conta.** A Focus gera um par de tokens
 *    (homologação e produção) no cadastro de cada empresa, e o token é o que
 *    diz de quem é a nota. A rede tem quatro CNPJs, então são quatro pares —
 *    `FOCUS_NFE_TOKEN_PRODUCAO_QI`, `_QNE`, `_NRT`, `_SDS`.
 *
 * Sobre o item 4: o token de uma empresa NÃO emite pela outra. Mandar o CNPJ da
 * QNE com o token da QI faz a Focus recusar, o que é o comportamento desejado —
 * falha alta e imediata, em vez de nota emitida sob o CNPJ errado.
 *
 * O ambiente continua GLOBAL de propósito, mesmo com token por loja. Se cada
 * loja escolhesse o seu, uma sem token de produção seguiria emitindo em
 * homologação depois da virada — nota com cara de autorizada e sem valor
 * nenhum. Com o ambiente global, ela falha na hora e diz qual variável falta.
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
  constructor(readonly variavelFaltando: string) {
    super(`Configure ${variavelFaltando} no ambiente`)
    this.name = "FocusNaoConfigurada"
  }
}

function variavel(nome: string) {
  const valor = process.env[nome]
  return typeof valor === "string" ? valor.trim() : ""
}

const PREFIXO = {
  producao: "FOCUS_NFE_TOKEN_PRODUCAO",
  homologacao: "FOCUS_NFE_TOKEN_HOMOLOGACAO",
} as const

/** "QI" → "_QI". Só letras e dígitos: nome de variável não aceita o resto. */
function sufixo(loja: string) {
  return `_${loja.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")}`
}

/** O nome exato da variável de uma loja — é o que as mensagens de erro citam. */
export function variavelDoToken(loja: string, ambiente: Ambiente = ambienteFocus()) {
  return `${PREFIXO[ambiente]}${sufixo(loja)}`
}

/**
 * Existe algum token de produção configurado?
 *
 * Varre o ambiente em vez de olhar uma variável fixa porque agora são quatro
 * nomes possíveis — um por loja — mais o antigo sem sufixo, que continua valendo
 * como reserva para quem só tem uma empresa.
 */
function temTokenDe(ambiente: Ambiente) {
  return Object.entries(process.env).some(
    ([chave, valor]) =>
      chave.startsWith(PREFIXO[ambiente]) && typeof valor === "string" && valor.trim() !== ""
  )
}

/**
 * O ambiente em que se emite agora — GLOBAL, para toda a rede.
 *
 * Basta UM token de produção para a rede inteira passar a emitir em produção.
 * Não há botão para voltar: emitir em homologação com produção configurada é
 * exatamente como se emite nota de teste achando que vale.
 */
export function ambienteFocus(): Ambiente {
  return temTokenDe("producao") ? "producao" : "homologacao"
}

/**
 * A integração está de pé? Com `loja`, pergunta se AQUELA loja pode emitir.
 *
 * Sem loja é a pergunta antiga, "existe integração": serve para as telas que
 * decidem se mostram o botão de nota antes de saber de qual loja se trata.
 */
/**
 * De onde sai o token desta loja: do nome dela, do nome sem sufixo, ou de
 * lugar nenhum.
 *
 * Existe para o diagnóstico poder dizer a diferença. "Configurado" esconderia
 * que a loja está emitindo com o token de outra empresa — que funciona
 * enquanto houver uma empresa só e recusa no dia em que houver duas.
 */
export function origemDoToken(
  loja: string,
  ambiente: Ambiente = ambienteFocus()
): "propria" | "reserva" | "ausente" {
  if (variavel(variavelDoToken(loja, ambiente))) return "propria"
  if (variavel(PREFIXO[ambiente])) return "reserva"
  return "ausente"
}

export function focusConfigurada(loja?: string) {
  if (!loja) return temTokenDe("producao") || temTokenDe("homologacao")
  const ambiente = ambienteFocus()
  return Boolean(variavel(variavelDoToken(loja, ambiente)) || variavel(PREFIXO[ambiente]))
}

/**
 * O token da loja no ambiente atual.
 *
 * Cai no nome sem sufixo quando o da loja não existe — é o que mantém de pé a
 * instalação que tinha uma empresa só, sem exigir que alguém renomeie a
 * variável no servidor no meio do expediente. Se nenhum dos dois existe, o erro
 * diz o nome exato que falta, porque "configure o token" não ajuda quem tem
 * quatro para configurar.
 */
function token(loja: string) {
  const ambiente = ambienteFocus()
  const daLoja = variavel(variavelDoToken(loja, ambiente))
  if (daLoja) return daLoja

  const geral = variavel(PREFIXO[ambiente])
  if (geral) return geral

  throw new FocusNaoConfigurada(variavelDoToken(loja, ambiente))
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
  /** De qual loja é a chamada: o token é dela, não da conta. */
  loja: string,
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: unknown
): Promise<RespostaFocus> {
  const credencial = Buffer.from(`${token(loja)}:`).toString("base64")

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

export function emitirNota(loja: string, modelo: ModeloNota, ref: string, payload: unknown) {
  return chamar(loja, "POST", `/${modelo}?ref=${encodeURIComponent(ref)}`, payload)
}

export function consultarNota(loja: string, modelo: ModeloNota, ref: string) {
  // `completa=1` traz o XML e os caminhos junto, poupando uma segunda consulta.
  return chamar(loja, "GET", `/${modelo}/${encodeURIComponent(ref)}?completa=1`)
}

/**
 * Os gatilhos cadastrados nesta conta — um por evento e CNPJ.
 *
 * Vale conferir antes de criar: cadastrar duas vezes o mesmo evento faz a Focus
 * avisar duas vezes, e o segundo aviso encontra a nota já atualizada.
 */
export async function listarGatilhos(
  loja: string
): Promise<Array<{ id?: number; url?: string; event?: string; cnpj?: string }>> {
  const resposta = await chamar(loja, "GET", "/hooks")
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
  /** A loja cujo token autentica — o gatilho é da empresa dela. */
  loja: string
  evento: "nfe" | "nfce"
  url: string
  cnpj: string
  segredo?: string
}) {
  return chamar(entrada.loja, "POST", "/hooks", {
    event: entrada.evento,
    url: entrada.url,
    cnpj: entrada.cnpj,
    ...(entrada.segredo
      ? { authorization: entrada.segredo, authorization_header: "x-focus-segredo" }
      : {}),
  })
}

export function apagarGatilho(loja: string, id: number) {
  return chamar(loja, "DELETE", `/hooks/${id}`)
}

/**
 * Cancela a nota. A justificativa vai para a SEFAZ e é pública: entra no evento
 * de cancelamento, que fica no XML.
 */
export function cancelarNota(
  loja: string,
  modelo: ModeloNota,
  ref: string,
  justificativa: string
) {
  return chamar(loja, "DELETE", `/${modelo}/${encodeURIComponent(ref)}`, { justificativa })
}
