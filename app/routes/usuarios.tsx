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
import { contarGerentesAtivos, exigirGerente } from "~/lib/sessao.server"
import {
  ehGerente,
  PAPEIS,
  PAPEL_PADRAO,
  papelValido,
  rotuloDoPapel,
} from "~/lib/permissoes"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Usuários — BrasSaco" }]
}

/** Um ObjectId malformado faz o Prisma lançar, virando 500 em vez de 400. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "gerenciarUsuarios")

  const usuarios = await db.usuario.findMany({
    orderBy: { nome: "asc" },
    select: {
      id: true,
      nome: true,
      email: true,
      papel: true,
      ativo: true,
      criadoEm: true,
      ultimoAcessoEm: true,
    },
  })

  return { eu, usuarios }
}

/**
 * O sistema não pode ficar sem quem administre.
 *
 * Quem garante isso hoje é a regra de não mexer em si mesmo, logo abaixo: se o
 * autor é um gerente ativo e o alvo também é, já existem dois — então esta
 * contagem nunca reprova nada no fluxo atual. Ela fica como rede para o dia em
 * que a autogestão for liberada ou um script mexer nos papéis, e é de propósito
 * que ela NÃO seja a proteção principal.
 */
async function sobraOutroGerente(alvo: { id: string; papel: string; ativo: boolean }) {
  if (!ehGerente(alvo.papel) || !alvo.ativo) return true
  return (await contarGerentesAtivos()) > 1
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "gerenciarUsuarios")
  const form = await request.formData()
  const acao = String(form.get("acao") ?? "criar")

  if (acao === "alternar" || acao === "papel") {
    const id = String(form.get("id") ?? "")
    if (!OBJECT_ID.test(id)) {
      return data({ erro: "Usuário inválido" }, { status: 400 })
    }
    // Mexer em si mesmo tranca o próprio gerente para fora do que administra.
    if (id === eu.id) {
      return data(
        {
          erro:
            acao === "alternar"
              ? "Você não pode desativar seu próprio acesso"
              : "Você não pode mudar seu próprio papel",
        },
        { status: 400 }
      )
    }

    const alvo = await db.usuario.findUnique({ where: { id } })
    if (!alvo) return data({ erro: "Usuário não encontrado" }, { status: 400 })

    if (acao === "alternar") {
      // Precisa sobrar alguém ativo, senão ninguém entra.
      if (alvo.ativo && (await db.usuario.count({ where: { ativo: true } })) <= 1) {
        return data({ erro: "Precisa haver ao menos um usuário ativo" }, { status: 400 })
      }
      if (!(await sobraOutroGerente(alvo))) {
        return data({ erro: "Precisa haver ao menos um gerente ativo" }, { status: 400 })
      }

      await db.usuario.update({ where: { id }, data: { ativo: !alvo.ativo } })
      return { mensagem: `${alvo.nome} ${alvo.ativo ? "desativado" : "reativado"}` }
    }

    const novo = String(form.get("papel") ?? "")
    if (!papelValido(novo)) return data({ erro: "Papel inválido" }, { status: 400 })
    if (novo === alvo.papel) return { mensagem: `${alvo.nome} já é ${rotuloDoPapel(novo)}` }
    if (!ehGerente(novo) && !(await sobraOutroGerente(alvo))) {
      return data({ erro: "Precisa haver ao menos um gerente ativo" }, { status: 400 })
    }

    await db.usuario.update({ where: { id }, data: { papel: novo } })
    return { mensagem: `${alvo.nome} agora é ${rotuloDoPapel(novo)}` }
  }

  const nome = String(form.get("nome") ?? "").trim()
  const email = String(form.get("email") ?? "")
  const senha = String(form.get("senha") ?? "")
  const papel = String(form.get("papel") ?? PAPEL_PADRAO)

  if (nome.length < 3) return data({ erro: "Informe o nome completo" }, { status: 400 })
  if (!validarEmail(email)) return data({ erro: "E-mail inválido" }, { status: 400 })
  if (!papelValido(papel)) return data({ erro: "Papel inválido" }, { status: 400 })

  const problema = validarSenha(senha)
  if (problema) return data({ erro: problema }, { status: 400 })

  const jaExiste = await db.usuario.findUnique({ where: { email: normalizarEmail(email) } })
  if (jaExiste) return data({ erro: "Esse e-mail já está cadastrado" }, { status: 400 })

  await db.usuario.create({
    data: { nome, email: normalizarEmail(email), papel, senhaHash: await gerarHash(senha) },
  })

  return { mensagem: `${nome} cadastrado como ${rotuloDoPapel(papel)}` }
}

export default function Usuarios({ loaderData, actionData }: Route.ComponentProps) {
  const { eu, usuarios } = loaderData
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      >
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
            <Campo nome="nome" rotulo="Nome" className="col-span-3" />
            <Campo nome="email" rotulo="E-mail" tipo="email" className="col-span-3" />
            <Campo
              nome="senha"
              rotulo="Senha (mín. 8)"
              tipo="password"
              className="col-span-3"
              autoComplete="new-password"
            />
            <div className="col-span-2">
              <label
                htmlFor="papel"
                className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Papel
              </label>
              <select
                id="papel"
                name="papel"
                defaultValue={PAPEL_PADRAO}
                className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
              >
                {PAPEIS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.rotulo}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={enviando} className="col-span-1 rounded-lg">
              <UserPlus className="size-4" />
            </Button>
          </Form>

          <p className="mt-2 text-[11px] text-muted-foreground">
            {PAPEIS.map((p) => `${p.rotulo}: ${p.descricao.toLowerCase()}`).join(" · ")}
          </p>

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
                <th scope="col" className="py-2.5 text-left font-semibold">Papel</th>
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
                  <td className="py-2.5">
                    <Badge
                      variant={ehGerente(usuario.papel) ? "default" : "outline"}
                      className="text-[10px]"
                    >
                      {rotuloDoPapel(usuario.papel)}
                    </Badge>
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
                      <>
                        <Form method="post" className="inline">
                          <input type="hidden" name="acao" value="papel" />
                          <input type="hidden" name="id" value={usuario.id} />
                          <input
                            type="hidden"
                            name="papel"
                            value={ehGerente(usuario.papel) ? "operador" : "gerente"}
                          />
                          <Button type="submit" variant="ghost" size="xs" disabled={enviando}>
                            {ehGerente(usuario.papel)
                              ? "Tornar operador"
                              : "Tornar gerente"}
                          </Button>
                        </Form>
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
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-6 text-xs text-muted-foreground">
            A senha é guardada como hash scrypt com sal — não há como recuperá-la, só
            cadastrar outra. Desativar bloqueia o acesso na requisição seguinte, sem
            esperar o cookie expirar. Sempre precisa sobrar um gerente ativo, e
            ninguém muda o próprio papel.
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
