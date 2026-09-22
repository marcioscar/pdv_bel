import { useState } from "react"
import { data, Form, useNavigation } from "react-router"
import { Check, Pencil, UserPlus, Users, X } from "lucide-react"

import type { Route } from "./+types/admin.usuarios"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { db } from "~/lib/db.server"
import {
  gerarHash,
  normalizarEmail,
  validarEmail,
  validarSenha,
} from "~/lib/senha.server"
import { listarLojas } from "~/lib/lojas.server"
import { contarGerentesAtivos, exigirGerente } from "~/lib/sessao.server"
import { codigoVendedorEmUso } from "~/lib/vendedores.server"
import {
  ehGerente,
  PAPEIS,
  PAPEL_PADRAO,
  papelValido,
  rotuloDoPapel,
} from "~/lib/permissoes"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Usuários — BrasSaco" }]
}

/** Um ObjectId malformado faz o Prisma lançar, virando 500 em vez de 400. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "gerenciarUsuarios")

  const [usuarios, lojas] = await Promise.all([
    db.usuario.findMany({
      orderBy: { nome: "asc" },
      select: {
        id: true,
        nome: true,
        email: true,
        papel: true,
        lojas: true,
        codigoVendedor: true,
        ativo: true,
        criadoEm: true,
        ultimoAcessoEm: true,
      },
    }),
    listarLojas(),
  ])

  return { eu, usuarios, lojas }
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

  if (acao === "lojas") {
    const id = String(form.get("id") ?? "")
    if (!OBJECT_ID.test(id)) return data({ erro: "Usuário inválido" }, { status: 400 })

    const codigos = (await listarLojas()).map((l) => l.codigo)
    // Só códigos que existem: lixo no formulário não vira loja fantasma no cadastro.
    const escolhidas = form.getAll("loja").map(String).filter((c) => codigos.includes(c))

    const alvo = await db.usuario.update({
      where: { id },
      // Todas marcadas é o mesmo que rede toda; guardamos vazio para o usuário
      // acompanhar automaticamente uma loja nova que a rede abrir.
      data: { lojas: escolhidas.length === codigos.length ? [] : escolhidas },
    })
    const quantas = escolhidas.length === codigos.length ? "todas as lojas" : escolhidas.join(", ") || "nenhuma loja"
    return { mensagem: `${alvo.nome}: ${quantas}` }
  }

  /*
   * Editar nome, e-mail e senha de quem já existe.
   *
   * Os três no mesmo lugar porque é a mesma conversa — "arrumar o cadastro
   * desta pessoa" —, mas a senha é OPCIONAL: deixar em branco mantém a atual.
   * Um campo de senha que apaga a senha quando fica vazio é a forma mais rápida
   * de trancar alguém para fora sem perceber.
   *
   * Vale para si mesmo, ao contrário de papel e situação: trocar o próprio nome
   * ou a própria senha não tranca ninguém do lado de fora.
   */
  if (acao === "editar") {
    const id = String(form.get("id") ?? "")
    if (!OBJECT_ID.test(id)) return data({ erro: "Usuário inválido" }, { status: 400 })

    const alvo = await db.usuario.findUnique({ where: { id } })
    if (!alvo) return data({ erro: "Usuário não encontrado" }, { status: 400 })

    const nome = String(form.get("nome") ?? "").trim()
    const email = String(form.get("email") ?? "").trim()
    const senha = String(form.get("senha") ?? "")

    if (nome.length < 3) return data({ erro: "Informe o nome completo" }, { status: 400 })
    if (!validarEmail(email)) return data({ erro: "E-mail inválido" }, { status: 400 })

    // O e-mail é a chave de entrada: dois iguais e o login fica ambíguo. O
    // índice único do Mongo recusaria, mas com um erro que não explica nada.
    const dono = await db.usuario.findUnique({ where: { email: normalizarEmail(email) } })
    if (dono && dono.id !== id) {
      return data({ erro: `O e-mail ${email} já é de ${dono.nome}` }, { status: 400 })
    }

    const mudou = []
    if (alvo.nome !== nome) mudou.push("nome")
    if (normalizarEmail(alvo.email) !== normalizarEmail(email)) mudou.push("e-mail")

    const dados: { nome: string; email: string; senhaHash?: string } = {
      nome,
      email: normalizarEmail(email),
    }

    if (senha) {
      const problema = validarSenha(senha)
      if (problema) return data({ erro: problema }, { status: 400 })
      dados.senhaHash = await gerarHash(senha)
      mudou.push("senha")
    }

    await db.usuario.update({ where: { id }, data: dados })

    return {
      mensagem: mudou.length
        ? `${nome}: ${mudou.join(", ")} ${mudou.length > 1 ? "atualizados" : "atualizado"}`
        : `Nada mudou em ${nome}`,
    }
  }

  if (acao === "codigoVendedor") {
    const id = String(form.get("id") ?? "")
    if (!OBJECT_ID.test(id)) return data({ erro: "Usuário inválido" }, { status: 400 })

    const codigo = String(form.get("codigoVendedor") ?? "").trim().slice(0, 10)
    if (codigo && !/^\d+$/.test(codigo)) {
      return data({ erro: "O código do vendedor é só números" }, { status: 400 })
    }

    // Cobrado aqui porque o campo não pode ter índice único no Mongo (ver o
    // comentário em `Usuario.codigoVendedor`). Dois com o mesmo código fariam
    // a comissão cair para quem o banco devolvesse primeiro.
    if (codigo) {
      const dono = await codigoVendedorEmUso(codigo, id)
      if (dono) return data({ erro: `O código ${codigo} já é de ${dono}` }, { status: 400 })
    }

    const alvo = await db.usuario.update({
      where: { id },
      data: { codigoVendedor: codigo || null },
    })
    return {
      mensagem: codigo
        ? `${alvo.nome} vende com o código ${codigo}`
        : `${alvo.nome} não recebe mais comissão de venda`,
    }
  }

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
  const { eu, usuarios, lojas } = loaderData
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"
  const ativos = usuarios.filter((u) => u.ativo).length

  /** Quem está em edição. Um de cada vez: duas linhas abertas confundem. */
  const [editando, setEditando] = useState<string | null>(null)

  return (
    <>
      <div className="p-6">
        <div className="max-w-4xl">
          <div className="mb-5 flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            <h1 className="text-base font-semibold">Usuários do caixa</h1>
            <span className="text-xs text-muted-foreground">
              {ativos} {ativos === 1 ? "ativo" : "ativos"}
            </span>
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
                <th scope="col" className="py-2.5 text-left font-semibold">Lojas</th>
                <th scope="col" className="py-2.5 text-left font-semibold" title="Código que o caixa digita para creditar a comissão">Cód. vend.</th>
                <th scope="col" className="py-2.5 text-left font-semibold">Último acesso</th>
                <th scope="col" className="py-2.5 text-left font-semibold">Situação</th>
                <th scope="col" className="py-2.5 text-right font-semibold" />
              </tr>
            </thead>
            <tbody>
              {usuarios.map((usuario) =>
                editando === usuario.id ? (
                  <tr key={usuario.id} className="border-b border-border bg-primary/5">
                    <td colSpan={8} className="py-3">
                      <Form
                        method="post"
                        className="flex flex-wrap items-end gap-3"
                        onSubmit={() => setEditando(null)}
                      >
                        <input type="hidden" name="acao" value="editar" />
                        <input type="hidden" name="id" value={usuario.id} />
                        <div>
                          <label
                            htmlFor={`nome-${usuario.id}`}
                            className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Nome
                          </label>
                          <Input
                            id={`nome-${usuario.id}`}
                            name="nome"
                            defaultValue={usuario.nome}
                            required
                            autoComplete="off"
                            className="h-9 w-56 rounded-lg"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`email-${usuario.id}`}
                            className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            E-mail
                          </label>
                          <Input
                            id={`email-${usuario.id}`}
                            name="email"
                            type="email"
                            defaultValue={usuario.email}
                            required
                            autoComplete="off"
                            className="h-9 w-64 rounded-lg"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`senha-${usuario.id}`}
                            className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Nova senha
                          </label>
                          <Input
                            id={`senha-${usuario.id}`}
                            name="senha"
                            type="password"
                            placeholder="deixe vazio para manter"
                            autoComplete="new-password"
                            className="h-9 w-56 rounded-lg"
                          />
                        </div>
                        <Button type="submit" size="sm" disabled={enviando} className="h-9 rounded-lg">
                          <Check className="size-4" />
                          Salvar
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setEditando(null)}
                          className="h-9 rounded-lg"
                        >
                          <X className="size-4" />
                        </Button>
                        {/* A senha em branco mantém a atual: dito aqui, e não só
                            no rodapé, porque é onde a dúvida aparece. */}
                        <p className="w-full text-[11px] text-muted-foreground">
                          Senha vazia mantém a que ele já tem. Trocar o e-mail muda com o
                          que ele entra no sistema.
                        </p>
                      </Form>
                    </td>
                  </tr>
                ) : (
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
                  {/* As lojas onde ele pode operar. Marcar todas equivale a "rede",
                      e é assim que ele acompanha uma loja nova sem novo cadastro. */}
                  <td className="py-2.5">
                    <Form method="post" className="flex flex-wrap items-center gap-1">
                      <input type="hidden" name="acao" value="lojas" />
                      <input type="hidden" name="id" value={usuario.id} />
                      {lojas.map((loja) => {
                        const marcada =
                          usuario.lojas.length === 0 || usuario.lojas.includes(loja.codigo)
                        return (
                          <label
                            key={loja.codigo}
                            className={cn(
                              "cursor-pointer rounded px-1.5 py-0.5 font-mono text-[10px]",
                              marcada
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground"
                            )}
                            title={loja.nome}
                          >
                            <input
                              type="checkbox"
                              name="loja"
                              value={loja.codigo}
                              defaultChecked={marcada}
                              className="sr-only"
                              onChange={(e) => e.currentTarget.form?.requestSubmit()}
                            />
                            {loja.codigo}
                          </label>
                        )
                      })}
                      {usuario.lojas.length === 0 ? (
                        <span className="text-[10px] text-muted-foreground">rede</span>
                      ) : null}
                    </Form>
                  </td>
                  {/* Quem não vende fica sem código, e aí não aparece como
                      opção no fechamento da venda. */}
                  <td className="py-2.5">
                    <Form method="post" className="flex items-center gap-1">
                      <input type="hidden" name="acao" value="codigoVendedor" />
                      <input type="hidden" name="id" value={usuario.id} />
                      <Input
                        name="codigoVendedor"
                        // `key` no valor: sem ela o campo continua montado com o
                        // defaultValue antigo depois que o loader revalida, e o
                        // Base UI reclama de default trocado em campo não
                        // controlado. Remontar é mais simples que controlá-lo.
                        key={usuario.codigoVendedor ?? ""}
                        defaultValue={usuario.codigoVendedor ?? ""}
                        onBlur={(e) => {
                          if (e.currentTarget.value !== (usuario.codigoVendedor ?? "")) {
                            e.currentTarget.form?.requestSubmit()
                          }
                        }}
                        inputMode="numeric"
                        placeholder="—"
                        aria-label={`Código de vendedor de ${usuario.nome}`}
                        className="h-7 w-16 font-mono text-xs tabular-nums"
                      />
                    </Form>
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
                    {/* Editar vale para todo mundo, inclusive para si mesmo:
                        trocar o próprio nome ou a própria senha não tranca
                        ninguém do lado de fora, ao contrário de papel e
                        situação, que continuam bloqueados no próprio usuário. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setEditando(usuario.id)}
                    >
                      <Pencil className="size-3.5" />
                      Editar
                    </Button>
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
                )
              )}
            </tbody>
          </table>

          <p className="mt-6 text-xs text-muted-foreground">
            A senha é guardada como hash scrypt com sal — não há como recuperá-la, só
            cadastrar outra, e é o que "Editar" faz: campo vazio mantém a atual. Desativar bloqueia o acesso na requisição seguinte, sem
            esperar o cookie expirar. Sempre precisa sobrar um gerente ativo, e
            ninguém muda o próprio papel. Clique nos códigos de loja para vincular
            ou desvincular — quem tem mais de uma escolhe ao entrar.
          </p>
        </div>
      </div>
    </>
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
