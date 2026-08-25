import { useEffect, useMemo, useRef, useState } from "react"
import { data, Link, useFetcher } from "react-router"
import { Check, Plus, Search, ShoppingBag, Truck, X } from "lucide-react"

import type { Route } from "./+types/admin.fornecedores"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import {
  alternarFornecedor,
  atualizarFornecedor,
  criarFornecedor,
  lerFornecedor,
  listarFornecedores,
} from "~/lib/fornecedores.server"
import { formatarCpfCnpj } from "~/lib/documento"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Fornecedores — BrasSaco" }]
}

/**
 * De quem se compra.
 *
 * Só gerente: quem fornece, por quanto e desde quando é informação de
 * negociação. O operador precisa saber o que tem em estoque, não de quem veio.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "editarProdutos")
  // Inclui inativos: é esta a tela que os reativa.
  return { fornecedores: await listarFornecedores({ incluirInativos: true }) }
}

export async function action({ request }: Route.ActionArgs) {
  await exigirGerente(request, "editarProdutos")

  const form = await request.formData()
  const id = String(form.get("id") ?? "")

  if (String(form.get("acao")) === "alternar") {
    const resultado = await alternarFornecedor(id)
    return resultado.ok
      ? { ok: true as const, mensagem: resultado.mensagem }
      : data({ ok: false as const, erro: resultado.erro, campo: null }, { status: 400 })
  }

  const entrada = lerFornecedor(form)
  const resultado = id
    ? await atualizarFornecedor(id, entrada)
    : await criarFornecedor(entrada)

  if (!resultado.ok) {
    return data(
      { ok: false as const, erro: resultado.erro, campo: resultado.campo ?? null },
      { status: 400 }
    )
  }

  const nome = resultado.fornecedor.nomeFantasia || resultado.fornecedor.razaoSocial
  return { ok: true as const, mensagem: `${nome} ${id ? "atualizado" : "cadastrado"}` }
}

type Fornecedor = Awaited<ReturnType<typeof listarFornecedores>>[number]

type Formulario = {
  id: string | null
  codigo: string
  razaoSocial: string
  nomeFantasia: string
  cidade: string
  bairro: string
  documento: string
  observacao: string
}

const VAZIO: Formulario = {
  id: null,
  codigo: "",
  razaoSocial: "",
  nomeFantasia: "",
  cidade: "",
  bairro: "",
  documento: "",
  observacao: "",
}

function doFornecedor(f: Fornecedor): Formulario {
  return {
    id: f.id,
    codigo: f.codigo,
    razaoSocial: f.razaoSocial,
    nomeFantasia: f.nomeFantasia ?? "",
    cidade: f.cidade,
    bairro: f.bairro,
    documento: f.documento ?? "",
    observacao: f.observacao ?? "",
  }
}

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

/** O nome que se usa: fantasia quando existe, razão social quando não. */
function nomeDe(f: Fornecedor) {
  return f.nomeFantasia || f.razaoSocial
}

export default function AdminFornecedores({ loaderData }: Route.ComponentProps) {
  const { fornecedores } = loaderData

  const [busca, setBusca] = useState("")
  const [mostrarInativos, setMostrarInativos] = useState(false)
  const [form, setForm] = useState<Formulario | null>(null)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(
    null
  )

  const campoBusca = useRef<HTMLInputElement>(null)
  const primeiroCampo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  const visiveis = useMemo(
    () => (mostrarInativos ? fornecedores : fornecedores.filter((f) => f.ativo)),
    [fornecedores, mostrarInativos]
  )
  const inativos = fornecedores.length - fornecedores.filter((f) => f.ativo).length

  const encontrados = useMemo(() => {
    const termo = normalizar(busca)
    const digitos = busca.replace(/\D/g, "")
    if (!termo) return visiveis

    return visiveis.filter(
      (f) =>
        normalizar(f.razaoSocial).includes(termo) ||
        normalizar(f.nomeFantasia ?? "").includes(termo) ||
        normalizar(f.cidade).includes(termo) ||
        f.codigo.includes(digitos) ||
        (digitos.length >= 3 && (f.documento ?? "").includes(digitos))
    )
  }, [busca, visiveis])

  useEffect(() => {
    if (form) primeiroCampo.current?.focus()
    else campoBusca.current?.focus()
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:gap-3 sm:px-5">
        <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Fornecedores</h1>
        <Input
          ref={campoBusca}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          type="search"
          placeholder="Buscar por nome, cidade, código ou CNPJ…"
          aria-label="Buscar fornecedor"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full min-w-0 rounded-lg sm:max-w-md"
        />
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {visiveis.length}
        </span>
        {inativos > 0 ? (
          <Button
            type="button"
            variant={mostrarInativos ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setMostrarInativos((v) => !v)}
            className="shrink-0 rounded-lg"
          >
            {mostrarInativos ? "Ocultar" : "Mostrar"} {inativos} inativo
            {inativos === 1 ? "" : "s"}
          </Button>
        ) : null}
        <Link
          to="/admin/pedido-novo"
          className="ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-accent"
        >
          <ShoppingBag className="size-3.5" aria-hidden />
          Fazer pedido
        </Link>
        <Button
          type="button"
          size="sm"
          onClick={() => setForm(VAZIO)}
          className="shrink-0 rounded-lg"
        >
          <Plus className="size-4" />
          Novo
        </Button>
      </div>

      {form ? (
        <div className="border-b border-border bg-primary/5 px-4 py-3 sm:px-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {form.id ? "Editando cadastro" : "Novo fornecedor"}
          </div>

          <div className="grid grid-cols-12 items-end gap-3">
            <Campo
              ref={primeiroCampo}
              rotulo="Código"
              valor={form.codigo}
              onChange={(v) => setForm({ ...form, codigo: v })}
              className="col-span-4 sm:col-span-2"
            />
            <Campo
              rotulo="Razão social"
              valor={form.razaoSocial}
              onChange={(v) => setForm({ ...form, razaoSocial: v })}
              className="col-span-8 sm:col-span-6"
            />
            <Campo
              rotulo="Nome fantasia"
              valor={form.nomeFantasia}
              onChange={(v) => setForm({ ...form, nomeFantasia: v })}
              className="col-span-12 sm:col-span-4"
            />
            <Campo
              rotulo="CNPJ / CPF"
              valor={form.documento}
              onChange={(v) => setForm({ ...form, documento: v })}
              className="col-span-6 sm:col-span-3"
            />
            <Campo
              rotulo="Cidade"
              valor={form.cidade}
              onChange={(v) => setForm({ ...form, cidade: v })}
              className="col-span-6 sm:col-span-3"
            />
            <Campo
              rotulo="Bairro"
              valor={form.bairro}
              onChange={(v) => setForm({ ...form, bairro: v })}
              className="col-span-12 sm:col-span-3"
            />
            <Campo
              rotulo="Observação"
              valor={form.observacao}
              onChange={(v) => setForm({ ...form, observacao: v })}
              onEnter={salvar}
              className="col-span-12 sm:col-span-3"
            />

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
        {encontrados.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Search className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              {busca
                ? `Nada encontrado para “${busca}”`
                : "Nenhum fornecedor cadastrado."}
            </p>
          </div>
        ) : (
          <>
            {/* Telefone: cartão. A tabela de seis colunas não cabe. */}
            <ul className="divide-y divide-border sm:hidden">
              {encontrados.map((f) => (
                <li key={f.id} className={cn("px-4 py-3", !f.ativo && "opacity-60")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{nomeDe(f)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">{f.codigo}</span> · {f.cidade}
                      </p>
                      {f.documento ? (
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                          {formatarCpfCnpj(f.documento)}
                        </p>
                      ) : null}
                    </div>
                    <UltimaCompra em={f.ultimaCompra} />
                  </div>
                  <div className="mt-2 flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setForm(doFornecedor(f))}
                    >
                      Editar
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={gravando}
                      onClick={() =>
                        fetcher.submit({ acao: "alternar", id: f.id }, { method: "post" })
                      }
                      className={cn(f.ativo && "text-destructive")}
                    >
                      {f.ativo ? "Desativar" : "Reativar"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <table className="hidden w-full text-sm sm:table">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="w-20 px-5 py-2.5 text-left font-semibold">
                    Código
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Nome</th>
                  <th scope="col" className="w-44 px-2 py-2.5 text-left font-semibold">
                    CNPJ / CPF
                  </th>
                  <th scope="col" className="w-48 px-2 py-2.5 text-left font-semibold">
                    Cidade
                  </th>
                  <th scope="col" className="w-32 px-2 py-2.5 text-left font-semibold">
                    Última compra
                  </th>
                  <th scope="col" className="w-28 px-5 py-2.5 text-right font-semibold" />
                </tr>
              </thead>
              <tbody>
                {encontrados.map((f) => (
                  <tr
                    key={f.id}
                    className={cn(
                      "border-b border-border",
                      form?.id === f.id && "bg-accent",
                      !f.ativo && "opacity-60"
                    )}
                  >
                    <td className="px-5 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                      {f.codigo}
                    </td>
                    <td className="px-2 py-2 font-medium">
                      {nomeDe(f)}
                      {f.tipoPessoa ? (
                        <Badge variant="outline" className="ml-2 text-[9px]">
                          {f.tipoPessoa === "JURIDICA" ? "PJ" : "PF"}
                        </Badge>
                      ) : null}
                      {!f.ativo ? (
                        <Badge variant="destructive" className="ml-1.5 text-[9px]">
                          inativo
                        </Badge>
                      ) : null}
                      {/* A razão social só aparece quando difere do nome usado —
                          repetir a mesma string em duas colunas é ruído. */}
                      {f.nomeFantasia && f.nomeFantasia !== f.razaoSocial ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {f.razaoSocial}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                      {f.documento ? formatarCpfCnpj(f.documento) : "—"}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      {f.cidade}
                      <span className="ml-1 text-muted-foreground">{f.bairro}</span>
                    </td>
                    <td className="px-2 py-2 text-xs">
                      <UltimaCompra em={f.ultimaCompra} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setForm(doFornecedor(f))}
                      >
                        Editar
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={gravando}
                        title={
                          f.ativo
                            ? "Sai da lista; o histórico continua intacto"
                            : "Volta a aparecer"
                        }
                        onClick={() =>
                          fetcher.submit(
                            { acao: "alternar", id: f.id },
                            { method: "post" }
                          )
                        }
                        className={cn(f.ativo && "text-destructive")}
                      >
                        {f.ativo ? "Desativar" : "Reativar"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs sm:px-5">
        <span className="text-muted-foreground">
          Ordenados por quem comprou mais recentemente · fornecedor não é apagado, é
          desativado
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

/**
 * A data da última compra, e o silêncio de quem nunca comprou.
 *
 * "nunca" escrito é melhor que um traço: 69 dos 128 cadastros estão nesse
 * estado, e é a informação que separa o fornecedor de verdade do cadastro que
 * alguém abriu uma vez e esqueceu.
 */
function UltimaCompra({ em }: { em: Date | string | null }) {
  if (!em) return <span className="text-xs text-muted-foreground/50">nunca</span>

  const data = new Date(em)
  const meses = (Date.now() - data.getTime()) / (1000 * 60 * 60 * 24 * 30)

  return (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        meses > 12 && "text-muted-foreground/60"
      )}
      title={meses > 12 ? "Mais de um ano sem comprar" : undefined}
    >
      {data.toLocaleDateString("pt-BR")}
    </span>
  )
}

function Campo({
  ref,
  rotulo,
  valor,
  onChange,
  onEnter,
  className,
}: {
  ref?: React.Ref<HTMLInputElement>
  rotulo: string
  valor: string
  onChange: (valor: string) => void
  onEnter?: () => void
  className?: string
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </label>
      <Input
        ref={ref}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
        autoComplete="off"
        spellCheck={false}
        className="h-10 rounded-lg sm:h-9"
      />
    </div>
  )
}
