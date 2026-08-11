import { createCookieSessionStorage, redirect } from "react-router"

import { db } from "~/lib/db.server"
import "~/lib/env.server"
import { conferirSenha, normalizarEmail } from "~/lib/senha.server"

export type UsuarioLogado = { id: string; nome: string; email: string }

/**
 * O segredo assina o cookie: sem ele qualquer um forjaria uma sessão. Em
 * produção é obrigatório vir do ambiente; em desenvolvimento cai num valor fixo
 * para não travar quem acabou de clonar o projeto.
 */
function segredo() {
  const doAmbiente = process.env.SESSION_SECRET
  if (doAmbiente && doAmbiente.length >= 16) return doAmbiente

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET ausente ou curto demais (mínimo 16 caracteres) — obrigatório em produção"
    )
  }
  return "segredo-de-desenvolvimento-nao-use-em-producao"
}

const armazem = createCookieSessionStorage<{ usuarioId: string }>({
  cookie: {
    name: "pdv_sessao",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    // 12 horas cobre um turno de caixa sem obrigar login no meio do expediente.
    maxAge: 60 * 60 * 12,
    secrets: [segredo()],
    secure: process.env.NODE_ENV === "production",
  },
})

export async function criarSessao(usuarioId: string, destino = "/") {
  const sessao = await armazem.getSession()
  sessao.set("usuarioId", usuarioId)

  return redirect(destino, {
    headers: { "set-cookie": await armazem.commitSession(sessao) },
  })
}

export async function encerrarSessao(request: Request) {
  const sessao = await armazem.getSession(request.headers.get("cookie"))
  return redirect("/entrar", {
    headers: { "set-cookie": await armazem.destroySession(sessao) },
  })
}

/** Devolve o usuário da sessão, ou null. Não redireciona. */
export async function usuarioDaSessao(request: Request): Promise<UsuarioLogado | null> {
  const sessao = await armazem.getSession(request.headers.get("cookie"))
  const usuarioId = sessao.get("usuarioId")
  if (!usuarioId) return null

  const usuario = await db.usuario.findUnique({ where: { id: usuarioId } })
  // Usuário desativado perde o acesso na próxima requisição, sem esperar o cookie expirar.
  if (!usuario || !usuario.ativo) return null

  return { id: usuario.id, nome: usuario.nome, email: usuario.email }
}

/**
 * Exige sessão. Guarda o destino em `?destino=` para devolver o operador à tela
 * que ele tentou abrir depois do login.
 */
export async function exigirUsuario(request: Request): Promise<UsuarioLogado> {
  const usuario = await usuarioDaSessao(request)
  if (usuario) return usuario

  const url = new URL(request.url)
  const destino = url.pathname + url.search
  throw redirect(`/entrar?destino=${encodeURIComponent(destino)}`)
}

export async function contarUsuarios() {
  return db.usuario.count()
}

export type ResultadoLogin =
  | { ok: true; usuarioId: string }
  | { ok: false; erro: string }

/**
 * Autentica. A mensagem de erro é a mesma para e-mail inexistente e senha
 * errada, de propósito: dizer qual dos dois falhou entrega quais e-mails existem.
 */
export async function autenticar(email: string, senha: string): Promise<ResultadoLogin> {
  const usuario = await db.usuario.findUnique({
    where: { email: normalizarEmail(email) },
  })

  if (!usuario || !usuario.ativo) {
    // Confere contra um hash descartável para o tempo de resposta não revelar
    // se o e-mail existe.
    await conferirSenha(senha, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA")
    return { ok: false, erro: "E-mail ou senha inválidos" }
  }

  if (!(await conferirSenha(senha, usuario.senhaHash))) {
    return { ok: false, erro: "E-mail ou senha inválidos" }
  }

  await db.usuario.update({
    where: { id: usuario.id },
    data: { ultimoAcessoEm: new Date() },
  })

  return { ok: true, usuarioId: usuario.id }
}
