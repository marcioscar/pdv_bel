import { data, Form, useNavigation } from "react-router"
import { UserPlus, Users } from "lucide-react"

import type { Route } from "./+types/usuarios"
import { Topo } from "~/components/pdv/topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { db } from "~/lib/db.server"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import {
  gerarHash,
  normalizarEmail,
  validarEmail,
  validarSenha,
} from "~/lib/senha.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Usuários — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const usuarios = await db.usuario.findMany({
    orderBy: { nome: "asc" },
    select: {
      id: true,
      nome: true,
      email: true,
      ativo: true,
      criadoEm: true,
      ultimoAcessoEm: true,
    },
  })

  return { eu, usuarios }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)
  const form = await request.formData()
  const acao = String(form.get("acao") ?? "criar")

  if (acao === "alternar") {
    const id = String(form.get("id") ?? "")
    // Desativar a si mesmo tranca o próprio operador para fora.
    if (id === eu.id) {
      return data({ erro: "Você não pode desativar seu próprio acesso" }, { status: 400 })
    }

    const alvo = await db.usuario.findUnique({ where: { id } })
    if (!alvo) return data({ erro: "Usuário não encontrado" }, { status: 400 })

    // Precisa sobrar alguém ativo, senão ninguém entra.
    if (alvo.ativo && (await db.usuario.count({ where: { ativo: true } })) <= 1) {
      return data({ erro: "Precisa haver ao menos um usuário ativo" }, { status: 400 })
    }

    await db.usuario.update({ where: { id }, data: { ativo: !alvo.ativo } })
    return { mensagem: `${alvo.nome} ${alvo.ativo ? "desativado" : "reativado"}` }
  }

  const nome = String(form.get("nome") ?? "").trim()
  const email = String(form.get("email") ?? "")
  const senha = String(form.get("senha") ?? "")

  if (nome.length < 3) return data({ erro: "Informe o nome completo" }, { status: 400 })
  if (!validarEmail(email)) return data({ erro: "E-mail inválido" }, { status: 400 })

  const problema = validarSenha(senha)
  if (problema) return data({ erro: problema }, { status: 400 })

  const jaExiste = await db.usuario.findUnique({ where: { email: normalizarEmail(email) } })
  if (jaExiste) return data({ erro: "Esse e-mail já está cadastrado" }, { status: 400 })

  await db.usuario.create({
    data: { nome, email: normalizarEmail(email), senhaHash: await gerarHash(senha) },
  })

  return { mensagem: `${nome} cadastrado` }
}

export default function Usuarios({ loaderData, actionData }: Route.ComponentProps) {
  const { eu, usuarios } = loaderData
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao()

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo operador={eu.nome} relogio={relogio} escuro={escuro} onAlternarTema={alternar}>
        <span>
          {usuarios.filter((u) => u.ativo).length}{" "}
          {usuarios.filter((u) => u.ativo).length === 1 ? "ativo" : "ativos"}
        </span>
      </Topo>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-5 flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            <h1 className="text-base font-semibold">Usuários do caixa</h1>
          </div>

          <Form
            id="novo-usuario"
            method="post"
            className="grid grid-cols-12 items-end gap-3 rounded-xl border border-border bg-muted/30 p-4"
          >
            <input type="hidden" name="acao" value="criar" />
            <Campo nome="nome" rotulo="Nome" className="col-span-4" />
            <Campo nome="email" rotulo="E-mail" tipo="email" className="col-span-4" />
            <Campo
              nome="senha"
              rotulo="Senha (mín. 8)"
              tipo="password"
              className="col-span-3"
              autoComplete="new-password"
            />
            <Button type="submit" disabled={enviando} className="col-span-1 rounded-lg">
              <UserPlus className="size-4" />
            </Button>
          </Form>

          {actionData && "erro" in actionData && actionData.erro ? (
            <p className="mt-3 text-xs font-medium text-destructive" role="alert">
              {actionData.erro}
            </p>
          ) : null}
          {actionData && "mensagem" in actionData && actionData.mensagem ? (
            <p className="mt-3 text-xs font-medium" role="status">
              {actionData.mensagem}
            </p>
          ) : null}

          <table className="mt-6 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="py-2.5 text-left font-semibold">Nome</th>
                <th scope="col" className="py-2.5 text-left font-semibold">E-mail</th>
                <th scope="col" className="py-2.5 text-left font-semibold">Último acesso</th>
                <th scope="col" className="py-2.5 text-left font-semibold">Situação</th>
                <th scope="col" className="py-2.5 text-right font-semibold" />
              </tr>
            </thead>
            <tbody>
              {usuarios.map((usuario) => (
                <tr
                  key={usuario.id}
                  className={cn("border-b border-border", !usuario.ativo && "opacity-60")}
                >
                  <td className="py-2.5 font-medium">
                    {usuario.nome}
                    {usuario.id === eu.id ? (
                      <span className="ml-2 text-[10px] text-muted-foreground">(você)</span>
                    ) : null}
                  </td>
                  <td className="py-2.5 font-mono text-xs text-muted-foreground">
                    {usuario.email}
                  </td>
                  <td className="py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                    {usuario.ultimoAcessoEm
                      ? new Date(usuario.ultimoAcessoEm).toLocaleString("pt-BR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : "nunca"}
                  </td>
                  <td className="py-2.5">
                    <Badge
                      variant={usuario.ativo ? "secondary" : "destructive"}
                      className="text-[10px]"
                    >
                      {usuario.ativo ? "ativo" : "desativado"}
                    </Badge>
                  </td>
                  <td className="py-2.5 text-right">
                    {usuario.id === eu.id ? null : (
                      <Form method="post" className="inline">
                        <input type="hidden" name="acao" value="alternar" />
                        <input type="hidden" name="id" value={usuario.id} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="xs"
                          disabled={enviando}
                          className={cn(usuario.ativo && "text-destructive")}
                        >
                          {usuario.ativo ? "Desativar" : "Reativar"}
                        </Button>
                      </Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-6 text-xs text-muted-foreground">
            A senha é guardada como hash scrypt com sal — não há como recuperá-la, só
            cadastrar outra. Desativar bloqueia o acesso na requisição seguinte, sem
            esperar o cookie expirar.
          </p>
        </div>
      </div>
    </main>
  )
}

function Campo({
  nome,
  rotulo,
  tipo = "text",
  className,
  autoComplete = "off",
}: {
  nome: string
  rotulo: string
  tipo?: string
  className?: string
  autoComplete?: string
}) {
  return (
    <div className={className}>
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
        className="rounded-lg"
      />
    </div>
  )
}
