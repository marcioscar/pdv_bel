import nodemailer from "nodemailer"

/**
 * E-mail pela caixa da Hostinger (brassaco@brassaco.com.br), por SMTP.
 *
 * As credenciais vêm só do ambiente — nunca do código nem do banco:
 *   SMTP_HOST      smtp.hostinger.com
 *   SMTP_PORTA     465 (SSL), o padrão da Hostinger; 587 usa STARTTLS
 *   SMTP_USUARIO   brassaco@brassaco.com.br
 *   SMTP_SENHA     a senha da caixa
 *   SMTP_NOME      opcional: o nome que aparece como remetente
 *
 * Sem elas, `emailConfigurado()` é falso e quem chama mostra isso, em vez de
 * fingir que mandou.
 */

export function emailConfigurado() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USUARIO && process.env.SMTP_SENHA)
}

let transporte: nodemailer.Transporter | null = null

function transportador() {
  if (transporte) return transporte
  const porta = Number(process.env.SMTP_PORTA ?? 465)
  transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: porta,
    // 465 é SSL desde o primeiro byte; 587 começa aberto e sobe para TLS.
    secure: porta === 465,
    auth: { user: process.env.SMTP_USUARIO, pass: process.env.SMTP_SENHA },
  })
  return transporte
}

export type Anexo = { nome: string; conteudo: Buffer; tipo: string }

export async function enviarEmail(entrada: {
  para: string
  assunto: string
  texto: string
  html?: string
  anexos?: Anexo[]
}): Promise<{ ok: true } | { ok: false; erro: string }> {
  if (!emailConfigurado()) {
    return { ok: false, erro: "E-mail não configurado (SMTP_HOST, SMTP_USUARIO e SMTP_SENHA)" }
  }
  try {
    const usuario = process.env.SMTP_USUARIO!
    await transportador().sendMail({
      from: { name: process.env.SMTP_NOME || "BrasSaco Embalagens", address: usuario },
      // Resposta do cliente volta para a mesma caixa.
      replyTo: usuario,
      to: entrada.para,
      subject: entrada.assunto,
      text: entrada.texto,
      html: entrada.html,
      attachments: entrada.anexos?.map((a) => ({
        filename: a.nome,
        content: a.conteudo,
        contentType: a.tipo,
      })),
    })
    return { ok: true }
  } catch (erro) {
    return { ok: false, erro: erro instanceof Error ? erro.message : "Falha ao enviar o e-mail" }
  }
}

/** Formato de e-mail o bastante para não mandar para "fulano" ou vazio. */
export function emailValido(endereco: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(endereco.trim())
}
