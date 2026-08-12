import { data, Form, useNavigation } from "react-router"
import { LogIn } from "lucide-react"

import type { Route } from "./+types/entrar"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { db } from "~/lib/db.server"
import {
  gerarHash,
  normalizarEmail,
  validarEmail,
  validarSenha,
} from "~/lib/senha.server"
import {
  autenticar,
  contarUsuarios,
  criarSessao,
  lojaUnica,
  usuarioDaSessao,
} from "~/lib/sessao.server"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Entrar — PDV BrasSaco" }]
}

function destinoSeguro(bruto: string | null) {
  // Só caminho interno: um destino absoluto viraria redirect aberto.
  if (!bruto || !bruto.startsWith("/") || bruto.startsWith("//")) return "/"
  return bruto
}

export async function loader({ request }: Route.LoaderArgs) {
  const usuario = await usuarioDaSessao(request)
  const destino = destinoSeguro(new URL(request.url).searchParams.get("destino"))
  if (usuario) throw new Response(null, { status: 302, headers: { location: destino } })

  // Sem nenhum usuário cadastrado, a tela cria o primeiro — senão o sistema
  // ficaria inacessível para sempre.
  return { primeiroAcesso: (await contarUsuarios()) === 0, destino }
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData()
  const email = String(form.get("email") ?? "")
  const senha = String(form.get("senha") ?? "")
  const destino = destinoSeguro(String(form.get("destino") ?? "/"))
  const semUsuarios = (await contarUsuarios()) === 0

  if (semUsuarios) {
    const nome = String(form.get("nome") ?? "").trim()

    if (nome.length < 3) return data({ erro: "Informe seu nome" }, { status: 400 })
    if (!validarEmail(email)) return data({ erro: "E-mail inválido" }, { status: 400 })

    const problema = validarSenha(senha)
    if (problema) return data({ erro: problema }, { status: 400 })

    // O primeiro nasce gerente: alguém precisa poder criar os demais, e não há
    // quem o promova depois.
    const usuario = await db.usuario.create({
      data: {
        nome,
        email: normalizarEmail(email),
        papel: "gerente",
        // Sem lojas = a rede toda. Quem cria o primeiro acesso é o dono.
        lojas: [],
        senhaHash: await gerarHash(senha),
      },
    })
    return criarSessao({ usuarioId: usuario.id, loja: await lojaUnica(usuario.id), destino })
  }

  const resultado = await autenticar(email, senha)
  if (!resultado.ok) return data({ erro: resultado.erro }, { status: 400 })

  // Com uma loja só, entra direto. Com mais de uma, `criarSessao` manda escolher —
  // e adivinhar seria gravar venda na loja errada.
  return criarSessao({
    usuarioId: resultado.usuarioId,
    loja: await lojaUnica(resultado.usuarioId),
    destino,
  })
}

export default function Entrar({ loaderData, actionData }: Route.ComponentProps) {
  const { primeiroAcesso, destino } = loaderData
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-lg">
        <span className="mb-6 block w-fit rounded-md bg-white px-2 py-1">
          <img
            src="/logo_bel.svg"
            alt="BrasSaco Embalagens"
            className="h-7 w-auto"
            width={349}
            height={86}
          />
        </span>

        <h1 className="text-base font-semibold">
          {primeiroAcesso ? "Criar o primeiro acesso" : "Entrar no PDV"}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {primeiroAcesso
            ? "Nenhum usuário cadastrado ainda. Este será o gerente, que cadastra os demais."
            : "Use seu e-mail e senha de operador."}
        </p>

        <Form method="post" className="mt-6 space-y-3">
          {/* O destino vem na query; sem este campo ele se perdia no POST e o
              login sempre caía na raiz. */}
          <input type="hidden" name="destino" value={destino} />
          {primeiroAcesso ? (
            <Campo nome="nome" rotulo="Nome" autoFoco />
          ) : null}
          <Campo
            nome="email"
            rotulo="E-mail"
            tipo="email"
            autoComplete="username"
            autoFoco={!primeiroAcesso}
          />
          <Campo
            nome="senha"
            rotulo="Senha"
            tipo="password"
            autoComplete={primeiroAcesso ? "new-password" : "current-password"}
          />

          {actionData?.erro ? (
            <p className="text-xs font-medium text-destructive" role="alert">
              {actionData.erro}
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={enviando}
            className="mt-2 h-10 w-full rounded-lg font-semibold"
          >
            {enviando ? (
              "Entrando…"
            ) : (
              <>
                <LogIn className="size-4" />
                {primeiroAcesso ? "Criar acesso" : "Entrar"}
                <Kbd className="bg-primary-foreground/20 text-primary-foreground">
                  Enter
                </Kbd>
              </>
            )}
          </Button>
        </Form>
      </div>
    </main>
  )
}

function Campo({
  nome,
  rotulo,
  tipo = "text",
  autoComplete,
  autoFoco,
}: {
  nome: string
  rotulo: string
  tipo?: string
  autoComplete?: string
  autoFoco?: boolean
}) {
  return (
    <div>
      <label
        htmlFor={nome}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {rotulo}
      </label>
      <Input
        id={nome}
        name={nome}
        type={tipo}
        required
        autoComplete={autoComplete}
        autoFocus={autoFoco}
        className="rounded-lg"
      />
    </div>
  )
}
