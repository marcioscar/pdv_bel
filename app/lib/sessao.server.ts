import { createCookieSessionStorage, redirect } from "react-router"

import { db } from "~/lib/db.server"
import "~/lib/env.server"
import {
  ACOES_DE_GERENTE,
  ehGerente,
  PAPEL_PADRAO,
  papelValido,
  type AcaoDeGerente,
  type Papel,
} from "~/lib/permissoes"
import { listarLojas } from "~/lib/lojas.server"
import { conferirSenha, normalizarEmail } from "~/lib/senha.server"

export type UsuarioLogado = {
  id: string
  nome: string
  email: string
  papel: Papel
  /** Loja em que está operando agora — escolhida ao entrar. */
  loja: string
  /** Lojas onde pode operar. Cadastro vazio significa a rede toda. */
  lojasPermitidas: string[]
}

/** Usuário autenticado mas ainda sem loja escolhida na sessão. */
export type UsuarioSemLoja = Omit<UsuarioLogado, "loja">

/**
 * O segredo assina o cookie: sem ele qualquer um forjaria uma sessão. Em
 * produção é obrigatório vir do ambiente; em desenvolvimento cai num valor fixo
 * para não travar quem acabou de clonar o projeto.
 */
/**
 * Diagnóstico para o /saude. Reporta o TAMANHO do segredo, nunca o valor: sem
 * isso, "não chegou" e "chegou errado" são indistinguíveis de fora, e foi
 * exatamente essa cegueira que transformou uma variável faltando num 502 mudo.
 */
export function diagnosticoSessao() {
  const segredoRecebido = process.env.SESSION_SECRET
  return {
    tamanhoDoSegredo: segredoRecebido?.length ?? 0,
    ambiente: process.env.NODE_ENV ?? "desconhecido",
    ok: Boolean(segredoRecebido && segredoRecebido.length >= 16),
    exigido: process.env.NODE_ENV === "production",
  }
}

/** O mesmo segredo do cookie de sessão, para outros cookies assinados do app. */
export function segredoDoCookie() {
  return segredo()
}

function segredo() {
  const doAmbiente = process.env.SESSION_SECRET
  if (doAmbiente && doAmbiente.length >= 16) return doAmbiente

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET ausente ou com menos de 16 caracteres — obrigatório em produção"
    )
  }
  return "segredo-de-desenvolvimento-nao-use-em-producao"
}

type Sessao = { usuarioId: string; loja: string }
type Armazem = ReturnType<typeof createCookieSessionStorage<Sessao>>
let armazemCache: Armazem | null = null

/**
 * Construído sob demanda, não no carregamento do módulo.
 *
 * Lendo o segredo no import, a falta dele derrubava o processo inteiro — e com
 * ele `/saude` e os webhooks do Inter, que não usam sessão. O resultado era um
 * 502 mudo, sem nada que dissesse o que faltava. Assim só quebra quem depende
 * de sessão, e o `/saude` continua respondendo para apontar a causa.
 */
function armazem(): Armazem {
  if (armazemCache) return armazemCache

  armazemCache = createCookieSessionStorage<Sessao>({
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
  return armazemCache
}

/**
 * Abre a sessão. Argumentos NOMEADOS de propósito: com `(id, loja, destino)`
 * posicional, uma chamada antiga de dois argumentos passaria o destino como loja
 * e o TypeScript aceitaria — os dois são string. Erro silencioso de loja é o pior
 * tipo de erro neste sistema.
 */
export async function criarSessao({
  usuarioId,
  loja,
  destino = "/",
}: {
  usuarioId: string
  loja: string | null
  destino?: string
}) {
  const sessao = await armazem().getSession()
  sessao.set("usuarioId", usuarioId)
  // Sem loja definida, o próximo `exigirUsuario` manda escolher.
  if (loja) sessao.set("loja", loja)

  return redirect(loja ? destino : `/loja?destino=${encodeURIComponent(destino)}`, {
    headers: { "set-cookie": await armazem().commitSession(sessao) },
  })
}

/**
 * Troca a loja da sessão sem pedir a senha de novo.
 *
 * `cookiesExtra` existe para gravar o padrão da máquina na mesma resposta. Dois
 * `set-cookie` exigem `Headers.append` — num objeto literal o segundo sobrescreve
 * o primeiro, e o cookie de sessão se perderia.
 */
export async function definirLojaDaSessao(
  request: Request,
  loja: string,
  destino = "/",
  cookiesExtra: string[] = []
) {
  const sessao = await armazem().getSession(request.headers.get("cookie"))
  sessao.set("loja", loja)

  const cabecalhos = new Headers()
  cabecalhos.append("set-cookie", await armazem().commitSession(sessao))
  for (const cookie of cookiesExtra) cabecalhos.append("set-cookie", cookie)

  return redirect(destino, { headers: cabecalhos })
}

export async function encerrarSessao(request: Request) {
  const sessao = await armazem().getSession(request.headers.get("cookie"))
  return redirect("/entrar", {
    headers: { "set-cookie": await armazem().destroySession(sessao) },
  })
}

/**
 * O usuário do cookie, com as lojas que pode operar. Não redireciona.
 *
 * `loja` vem null quando o cookie ainda não tem loja escolhida OU quando a loja
 * escolhida deixou de valer — funcionário remanejado, loja desativada. Revalidar
 * a cada requisição, e não só no login, é o que faz a mudança de cadastro valer
 * na hora, do mesmo jeito que `ativo` já valia.
 */
export async function usuarioDaSessao(
  request: Request
): Promise<(UsuarioSemLoja & { loja: string | null }) | null> {
  const sessao = await armazem().getSession(request.headers.get("cookie"))
  const usuarioId = sessao.get("usuarioId")
  if (!usuarioId) return null

  const usuario = await db.usuario.findUnique({ where: { id: usuarioId } })
  // Usuário desativado perde o acesso na próxima requisição, sem esperar o cookie expirar.
  if (!usuario || !usuario.ativo) return null

  // Cadastro sem lojas significa a rede toda; resolvemos para a lista real para
  // o resto do sistema nunca precisar interpretar "vazio".
  const todas = (await listarLojas()).map((l) => l.codigo)
  const permitidas =
    usuario.lojas.length === 0
      ? todas
      : usuario.lojas.filter((codigo) => todas.includes(codigo))

  const escolhida = sessao.get("loja")

  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    // Papel desconhecido no banco cai no menor privilégio, não no maior: um valor
    // digitado errado não pode virar promoção.
    papel: papelValido(usuario.papel) ? usuario.papel : PAPEL_PADRAO,
    lojasPermitidas: permitidas,
    loja: escolhida && permitidas.includes(escolhida) ? escolhida : null,
  }
}

/**
 * Exige sessão COM loja. Devolver `loja` sempre preenchido é o que permite tornar
 * o escopo obrigatório nas funções de servidor: quem tem o usuário tem a loja, e
 * o TypeScript cobra o resto.
 *
 * Sem loja válida, manda escolher em vez de adivinhar. Adivinhar seria gravar
 * venda na loja errada, e isso não se descobre olhando a tela.
 */
export async function exigirUsuario(request: Request): Promise<UsuarioLogado> {
  const usuario = await usuarioDaSessao(request)
  const url = new URL(request.url)
  const destino = url.pathname + url.search

  if (!usuario) {
    throw redirect(`/entrar?destino=${encodeURIComponent(destino)}`)
  }
  if (!usuario.loja) {
    throw redirect(`/loja?destino=${encodeURIComponent(destino)}`)
  }

  return { ...usuario, loja: usuario.loja }
}

/**
 * Exige gerente. Vale para loader E action da mesma rota: esconder o botão não é
 * controle de acesso — a rota continua respondendo a quem digitar a URL, e a
 * action continua aceitando um POST montado à mão.
 *
 * Lança 403 em vez de redirecionar para dizer o motivo. Redirecionar em silêncio
 * faz o operador achar que a tela quebrou.
 */
export async function exigirGerente(
  request: Request,
  acao: AcaoDeGerente
): Promise<UsuarioLogado> {
  const usuario = await exigirUsuario(request)
  if (ehGerente(usuario.papel)) return usuario

  throw new Response(ACOES_DE_GERENTE[acao], { status: 403 })
}

/**
 * A loja com que o usuário entra, sem precisar escolher.
 *
 * Duas fontes, nesta ordem:
 *
 * 1. **o padrão da máquina** — o terminal da QNE está sempre na QNE, e os
 *    vendedores revezam de loja. O lugar é mais confiável que a pessoa.
 * 2. **a única loja liberada para ele** — quem só opera numa não tem o que escolher.
 *
 * Devolve null quando resta escolha de verdade; aí a tela pergunta, porque
 * adivinhar grava venda na loja errada e isso não se descobre olhando a tela.
 */
export async function lojaParaEntrar(
  usuarioId: string,
  lojaDaMaquina: string | null
): Promise<string | null> {
  const usuario = await db.usuario.findUnique({
    where: { id: usuarioId },
    select: { lojas: true },
  })
  if (!usuario) return null

  const todas = (await listarLojas()).map((l) => l.codigo)
  const permitidas =
    usuario.lojas.length === 0 ? todas : usuario.lojas.filter((c) => todas.includes(c))

  // O padrão da máquina só vale se ele pode operar lá.
  if (lojaDaMaquina && permitidas.includes(lojaDaMaquina)) return lojaDaMaquina

  return permitidas.length === 1 ? permitidas[0] : null
}

export async function contarUsuarios() {
  return db.usuario.count()
}

/** Gerentes ativos. Serve para não deixar o sistema sem ninguém que administre. */
export async function contarGerentesAtivos() {
  return db.usuario.count({ where: { papel: "gerente", ativo: true } })
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
