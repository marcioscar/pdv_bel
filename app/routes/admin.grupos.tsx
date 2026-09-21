import { useEffect, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { Check, FolderTree, Plus, X } from "lucide-react"

import type { Route } from "./+types/admin.grupos"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import {
  alternarGrupo,
  lerGrupo,
  listarGrupos,
  produtosPorGrupo,
  salvarGrupo,
  TIPOS,
  type TipoDeGrupo,
} from "~/lib/grupos.server"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Grupos de produto — BrasSaco" }]
}

/**
 * As gavetas do catálogo.
 *
 * A tela é pequena porque o cadastro é pequeno — trinta e dois grupos, que
 * mudam uma vez por ano. O que ela realmente decide é uma coisa só: quais
 * grupos são mercadoria de prateleira e quais são encomenda. Essa escolha sai
 * daqui direto para a curva ABC do painel, e é por isso que o tipo aparece na
 * lista, e não escondido no formulário.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "editarProdutos")

  const [grupos, contagem] = await Promise.all([listarGrupos(), produtosPorGrupo()])

  return {
    grupos: grupos.map((g) => ({ ...g, produtos: contagem.porGrupo.get(g.id) ?? 0 })),
    semGrupo: contagem.semGrupo,
  }
}

export async function action({ request }: Route.ActionArgs) {
  await exigirGerente(request, "editarProdutos")

  const form = await request.formData()
  const id = String(form.get("id") ?? "")

  if (String(form.get("acao")) === "alternar") {
    const resultado = await alternarGrupo(id)
    return resultado.ok
      ? { ok: true as const, mensagem: resultado.mensagem }
      : data({ ok: false as const, erro: resultado.erro }, { status: 400 })
  }

  const lido = lerGrupo(form)
  if ("erro" in lido) return data({ ok: false as const, erro: lido.erro }, { status: 400 })

  const resultado = await salvarGrupo(id || null, lido)
  if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 400 })

  return { ok: true as const, mensagem: resultado.mensagem }
}

type Formulario = { id: string | null; codigo: string; nome: string; tipo: TipoDeGrupo }

const VAZIO: Formulario = { id: null, codigo: "", nome: "", tipo: "padrao" }

export default function AdminGrupos({ loaderData }: Route.ComponentProps) {
  const { grupos, semGrupo } = loaderData

  const [form, setForm] = useState<Formulario | null>(null)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const primeiroCampo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)
  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  useEffect(() => {
    if (form) primeiroCampo.current?.focus()
  }, [form])

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 5000)
    return () => clearTimeout(id)
  }, [aviso])

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data

    if (fetcher.data.ok) {
      setAviso({ texto: fetcher.data.mensagem, tipo: "sucesso" })
      setForm(null)
    } else {
      setAviso({ texto: fetcher.data.erro, tipo: "erro" })
    }
  }, [fetcher.state, fetcher.data])

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.ctrlKey || evento.altKey || evento.metaKey) return
      if (evento.key === "Escape" && form) {
        evento.preventDefault()
        setForm(null)
      }
    }
    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [form])

  function salvar() {
    if (!form || gravando) return
    fetcher.submit({ ...form, id: form.id ?? "" }, { method: "post" })
  }

  const foraDaAbc = grupos.filter((g) => g.tipo !== "padrao")
  const produtosForaDaAbc = foraDaAbc.reduce((s, g) => s + g.produtos, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:gap-3 sm:px-5">
        <FolderTree className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Grupos de produto</h1>
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {grupos.length}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={() => setForm(VAZIO)}
          className="ml-auto shrink-0 rounded-lg"
        >
          <Plus className="size-4" />
          Novo grupo
        </Button>
      </div>

      {/* O que a tela decide, dito antes da lista — senão o tipo vira mais uma
          coluna sem consequência aparente. */}
      <p className="border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground sm:px-5">
        O tipo do grupo é o que separa mercadoria de encomenda. A curva ABC do
        painel conta só o que é <strong className="font-medium text-foreground">padrão</strong>
        {foraDaAbc.length > 0 ? (
          <>
            {" "}— {foraDaAbc.map((g) => g.nome).join(", ")}{" "}
            {foraDaAbc.length === 1 ? "fica" : "ficam"} de fora, com{" "}
            {produtosForaDaAbc.toLocaleString("pt-BR")} produto
            {produtosForaDaAbc === 1 ? "" : "s"}.
          </>
        ) : (
          <>. Nenhum grupo está marcado como encomenda.</>
        )}
      </p>

      {form ? (
        <div className="border-b border-border bg-primary/5 px-4 py-3 sm:px-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {form.id ? "Editando grupo" : "Novo grupo"}
          </div>

          <div className="grid grid-cols-12 items-end gap-3">
            <div className="col-span-4 sm:col-span-2">
              <label
                htmlFor="grupo-codigo"
                className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Código
              </label>
              <Input
                id="grupo-codigo"
                ref={primeiroCampo}
                value={form.codigo}
                onChange={(e) => setForm({ ...form, codigo: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                className="h-10 rounded-lg sm:h-9"
              />
            </div>

            <div className="col-span-8 sm:col-span-5">
              <label
                htmlFor="grupo-nome"
                className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Nome
              </label>
              <Input
                id="grupo-nome"
                value={form.nome}
                onChange={(e) => setForm({ ...form, nome: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    salvar()
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                className="h-10 rounded-lg sm:h-9"
              />
            </div>

            <div className="col-span-12 sm:col-span-5">
              <label
                htmlFor="grupo-tipo"
                className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Tipo
              </label>
              <select
                id="grupo-tipo"
                value={form.tipo}
                onChange={(e) => setForm({ ...form, tipo: e.target.value as TipoDeGrupo })}
                className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-9"
              >
                {TIPOS.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.rotulo} — {t.ajuda}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-12 flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={gravando}
                onClick={salvar}
                className="h-10 rounded-lg sm:h-9"
              >
                <Check className="size-4" />
                {gravando ? "Salvando…" : form.id ? "Salvar" : "Cadastrar"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setForm(null)}
                className="h-10 rounded-lg sm:h-9"
              >
                <X className="size-4" />
                <Kbd>Esc</Kbd>
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {grupos.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <FolderTree className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum grupo cadastrado. O catálogo inteiro entra nas análises.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="w-20 px-5 py-2.5 text-left font-semibold">
                  Código
                </th>
                <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                  Nome
                </th>
                <th scope="col" className="w-40 px-2 py-2.5 text-left font-semibold">
                  Tipo
                </th>
                <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">
                  Produtos
                </th>
                <th scope="col" className="w-32 px-5 py-2.5 text-right font-semibold" />
              </tr>
            </thead>
            <tbody>
              {grupos.map((g) => (
                <tr
                  key={g.id}
                  className={cn("border-b border-border", !g.ativo && "opacity-60")}
                >
                  <td className="px-5 py-2 font-mono text-xs tabular-nums">{g.codigo}</td>
                  <td className="px-2 py-2">
                    {g.nome}
                    {!g.ativo ? (
                      <Badge variant="destructive" className="ml-1.5 text-[9px]">
                        inativo
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <Badge
                      variant={g.tipo === "padrao" ? "outline" : "secondary"}
                      className="text-[10px]"
                      title={TIPOS.find((t) => t.valor === g.tipo)?.ajuda}
                    >
                      {TIPOS.find((t) => t.valor === g.tipo)?.rotulo ?? g.tipo}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {g.produtos.toLocaleString("pt-BR")}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        setForm({
                          id: g.id,
                          codigo: g.codigo,
                          nome: g.nome,
                          tipo: (g.tipo as TipoDeGrupo) ?? "padrao",
                        })
                      }
                    >
                      Editar
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={gravando}
                      onClick={() =>
                        fetcher.submit({ acao: "alternar", id: g.id }, { method: "post" })
                      }
                      className={cn(g.ativo && "text-destructive")}
                    >
                      {g.ativo ? "Desativar" : "Reativar"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-5 py-2 text-xs text-muted-foreground">
        <span className="shrink-0">
          {semGrupo > 0
            ? `${semGrupo.toLocaleString("pt-BR")} produto(s) sem grupo`
            : "Todo produto do catálogo tem grupo"}
        </span>
        {aviso ? (
          <span
            className={cn(
              "shrink-0 font-medium",
              aviso.tipo === "erro" ? "text-destructive" : "text-foreground"
            )}
            role="status"
          >
            {aviso.texto}
          </span>
        ) : null}
      </div>
    </div>
  )
}
