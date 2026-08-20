import { escapar } from "~/lib/html"

/**
 * Avisos pelo Telegram — hoje, a fila de autorizações.
 *
 * A Bot API é um POST com um token na URL: nada de SDK, nada de conta paga. O
 * destino é um chat só (o grupo dos gerentes), configurado no ambiente e não no
 * banco: é infraestrutura, muda com o deploy, e um número de chat numa tela de
 * administração é mais uma coisa para alguém quebrar sem perceber.
 */

const API = "https://api.telegram.org"

/** Cinco segundos. O caixa não pode esperar o Telegram para responder ao vendedor. */
const LIMITE_MS = 5_000

function credenciais() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chat = process.env.TELEGRAM_CHAT_ID?.trim()
  return token && chat ? { token, chat } : null
}

export function telegramConfigurado() {
  return credenciais() !== null
}

/**
 * Diagnóstico para o /saude, no mesmo espírito do resto: diz se ESTÁ
 * configurado, nunca o token. Sem isto, "o aviso não chegou" e "o token nunca
 * subiu para o ambiente" seriam indistinguíveis de fora — que é exatamente a
 * cegueira que o /saude existe para evitar.
 */
export function diagnosticoTelegram() {
  const c = credenciais()
  return {
    configurado: c !== null,
    // O chat_id não é segredo (não dá acesso a nada sem o token) e é o campo em
    // que mais se erra: vale poder conferir de fora que é o grupo certo.
    chat: c?.chat ?? null,
  }
}

export type ResultadoAviso = { ok: true } | { ok: false; erro: string }

/**
 * Manda o texto para o grupo. Nunca lança.
 *
 * Aviso é acessório: se o Telegram estiver fora, a venda ainda foi pedida e o
 * pedido está na fila — o gerente vai vê-lo ao abrir a tela. Deixar essa falha
 * derrubar o fluxo do caixa seria trocar um problema pequeno (aviso atrasado)
 * por um grande (vendedor travado com cliente na frente).
 */
export async function enviarTelegram(texto: string): Promise<ResultadoAviso> {
  const c = credenciais()
  if (!c) return { ok: false, erro: "Telegram não configurado" }

  try {
    const resposta = await fetch(`${API}/bot${c.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: c.chat,
        text: texto,
        parse_mode: "HTML",
        // O link para a fila viraria um cartão de pré-visualização ocupando a
        // tela do celular, empurrando para cima justamente o resumo da venda.
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(LIMITE_MS),
    })

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "")
      return { ok: false, erro: `Telegram respondeu ${resposta.status}: ${corpo.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (erro) {
    return {
      ok: false,
      erro: erro instanceof Error ? erro.message : "Falha ao falar com o Telegram",
    }
  }
}

/**
 * Dispara sem segurar quem chamou.
 *
 * O vendedor recebe "pedido enviado" no tempo do banco, não no tempo da rede do
 * Telegram. O erro é registrado no log do servidor — some da tela, não do
 * histórico, porque um aviso que silenciosamente parou de sair é um gerente que
 * nunca mais soube de venda travada.
 */
export function enviarTelegramEmSegundoPlano(texto: string) {
  if (!telegramConfigurado()) return
  void enviarTelegram(texto).then((r) => {
    if (!r.ok) console.error("[telegram] aviso não enviado:", r.erro)
  })
}

/** Escapa o que vai dentro do HTML do Telegram (nomes de cliente, observações). */
export const texto = escapar
