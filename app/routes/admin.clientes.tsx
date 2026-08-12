import { useEffect, useMemo, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { Check, Loader2, Plus, UserSearch, Users, X } from "lucide-react"

import type { Route } from "./+types/admin.clientes"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import {
  alternarCliente,
  atualizarCliente,
  criarCliente,
  lerCliente,
  listarClientes,
} from "~/lib/clientes.server"
import {
  formatarCep,
  formatarCpfCnpj,
  limparCep,
  UFS,
  validarCep,
} from "~/lib/documento"
import { exigirUsuario } from "~/lib/sessao.server"
import type { EnderecoDoCep } from "~/routes/cep"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Clientes — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  // Cadastrar cliente é tarefa de operador — o boleto precisa do pagador, e quem
  // atende é quem tem os dados na mão.
  await exigirUsuario(request)
  // Inclui inativos: é esta a tela que os reativa.
  return { clientes: await listarClientes({ incluirInativos: true }) }
}

export async function action({ request }: Route.ActionArgs) {
  await exigirUsuario(request)

  const form = await request.formData()
  const id = String(form.get("id") ?? "")

  if (String(form.get("acao")) === "alternar") {
    const resultado = await alternarCliente(id)
    return resultado.ok
      ? { ok: true as const, mensagem: resultado.mensagem }
      : data({ ok: false as const, erro: resultado.erro, campo: null }, { status: 400 })
  }

  const entrada = lerCliente(form)

  const resultado = id
    ? await atualizarCliente(id, entrada)
    : await criarCliente(entrada)

  if (!resultado.ok) {
    return data(
      { ok: false as const, erro: resultado.erro, campo: resultado.campo ?? null },
      { status: 400 }
    )
  }

  return {
    ok: true as const,
    mensagem: `${resultado.cliente.nome} ${id ? "atualizado" : "cadastrado"}`,
  }
}

type Cliente = Awaited<ReturnType<typeof listarClientes>>[number]

type Formulario = {
  id: string | null
  nome: string
  cpfCnpj: string
  cep: string
  endereco: string
  numero: string
  complemento: string
  bairro: string
  cidade: string
  uf: string
  email: string
  ddd: string
  telefone: string
}

const VAZIO: Formulario = {
  id: null,
  nome: "",
  cpfCnpj: "",
  cep: "",
  endereco: "",
  numero: "",
  complemento: "",
  bairro: "",
  cidade: "",
  uf: "MG",
  email: "",
  ddd: "",
  telefone: "",
}

function doCliente(c: Cliente): Formulario {
  return {
    id: c.id,
    nome: c.nome,
    cpfCnpj: c.cpfCnpj,
    cep: c.cep,
    endereco: c.endereco,
    numero: c.numero ?? "",
    complemento: c.complemento ?? "",
    bairro: c.bairro,
    cidade: c.cidade,
    uf: c.uf,
    email: c.email ?? "",
    ddd: c.ddd ?? "",
    telefone: c.telefone ?? "",
  }
}

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

export default function AdminClientes({ loaderData }: Route.ComponentProps) {
  const { clientes } = loaderData

  const [busca, setBusca] = useState("")
  const [mostrarInativos, setMostrarInativos] = useState(false)
  const [form, setForm] = useState<Formulario | null>(null)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const campoBusca = useRef<HTMLInputElement>(null)
  const primeiroCampo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)
  const cepBuscado = useRef<string | null>(null)

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"
  const buscaCep = useFetcher<EnderecoDoCep | { erro: string }>()
  const buscandoCep = buscaCep.state !== "idle"

  const visiveis = useMemo(
    () => (mostrarInativos ? clientes : clientes.filter((c) => c.ativo)),
    [clientes, mostrarInativos]
  )
  const inativos = clientes.length - clientes.filter((c) => c.ativo).length

  const encontrados = useMemo(() => {
    const termo = normalizar(busca)
    const digitos = busca.replace(/\D/g, "")
    if (!termo) return visiveis

    return visiveis.filter(
      (c) =>
        normalizar(c.nome).includes(termo) ||
        normalizar(c.cidade).includes(termo) ||
        (digitos.length >= 3 && c.cpfCnpj.includes(digitos))
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

  // Assim que o CEP fica completo, busca — sem apertar nada.
  useEffect(() => {
    if (!form) return
    const limpo = limparCep(form.cep)
    if (!validarCep(limpo) || cepBuscado.current === limpo) return
    cepBuscado.current = limpo
    buscaCep.load(`/cep/${limpo}`)
  }, [form, buscaCep])

  useEffect(() => {
    if (buscaCep.state !== "idle" || !buscaCep.data) return
    if ("erro" in buscaCep.data) {
      setAviso({ texto: buscaCep.data.erro, tipo: "erro" })
      return
    }
    const achado = buscaCep.data
    // Substitui os quatro campos: preservar o que estava deixaria o bairro do CEP
    // anterior numa cidade nova — endereço misturado, que iria para o boleto.
    setForm((atual) =>
      atual
        ? {
            ...atual,
            endereco: achado.endereco,
            bairro: achado.bairro,
            cidade: achado.cidade,
            uf: achado.uf,
          }
        : atual
    )
  }, [buscaCep.state, buscaCep.data])

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

  function abrir(cliente: Cliente | null) {
    cepBuscado.current = cliente ? limparCep(cliente.cep) : null
    setForm(cliente ? doCliente(cliente) : VAZIO)
  }

  function salvar() {
    if (!form || gravando) return
    fetcher.submit({ ...form, id: form.id ?? "" }, { method: "post" })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Clientes</h1>
        <Input
          ref={campoBusca}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          type="search"
          placeholder="Buscar por nome, cidade ou CPF/CNPJ…"
          aria-label="Buscar cliente"
          autoComplete="off"
          spellCheck={false}
          className="h-9 max-w-md rounded-lg"
        />
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {visiveis.length} {visiveis.length === 1 ? "cadastrado" : "cadastrados"}
        </span>
        {inativos > 0 ? (
          <Button
            type="button"
            variant={mostrarInativos ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setMostrarInativos((v) => !v)}
            className="shrink-0 rounded-lg"
          >
            {mostrarInativos ? "Ocultar" : "Mostrar"} {inativos}{" "}
            {inativos === 1 ? "inativo" : "inativos"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={() => abrir(null)}
          className="ml-auto shrink-0 rounded-lg"
        >
          <Plus className="size-4" />
          Novo cliente
        </Button>
      </div>

      {form ? (
        <div className="border-b border-border bg-primary/5 px-5 py-3">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {form.id ? "Editando cadastro" : "Novo cliente"}
            {buscandoCep ? (
              <span className="flex items-center gap-1 normal-case">
                <Loader2 className="size-3 animate-spin" aria-hidden /> buscando CEP
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-12 items-end gap-3">
            <Campo
              ref={primeiroCampo}
              rotulo="Nome"
              valor={form.nome}
              onChange={(v) => setForm({ ...form, nome: v })}
              className="col-span-4"
            />
            <Campo
              rotulo="CPF / CNPJ"
              valor={form.cpfCnpj}
              onChange={(v) => setForm({ ...form, cpfCnpj: v })}
              className="col-span-3"
            />
            <Campo
              rotulo="CEP"
              valor={form.cep}
              onChange={(v) => setForm({ ...form, cep: v })}
              className="col-span-2"
            />
            <Campo
              rotulo="DDD"
              valor={form.ddd}
              onChange={(v) => setForm({ ...form, ddd: v })}
              className="col-span-1"
            />
            <Campo
              rotulo="Telefone"
              valor={form.telefone}
              onChange={(v) => setForm({ ...form, telefone: v })}
              className="col-span-2"
            />

            <Campo
              rotulo="Endereço"
              valor={form.endereco}
              onChange={(v) => setForm({ ...form, endereco: v })}
              className="col-span-4"
            />
            <Campo
              rotulo="Nº"
              valor={form.numero}
              onChange={(v) => setForm({ ...form, numero: v })}
              className="col-span-1"
            />
            <Campo
              rotulo="Complemento"
              valor={form.complemento}
              onChange={(v) => setForm({ ...form, complemento: v })}
              className="col-span-2"
            />
            <Campo
              rotulo="Bairro"
              valor={form.bairro}
              onChange={(v) => setForm({ ...form, bairro: v })}
              className="col-span-2"
            />
            <Campo
              rotulo="Cidade"
              valor={form.cidade}
              onChange={(v) => setForm({ ...form, cidade: v })}
              className="col-span-2"
            />
            <div className="col-span-1">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                UF
              </label>
              <select
                value={form.uf}
                onChange={(e) => setForm({ ...form, uf: e.target.value })}
                className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
              >
                {UFS.map((uf) => (
                  <option key={uf} value={uf}>
                    {uf}
                  </option>
                ))}
              </select>
            </div>

            <Campo
              rotulo="E-mail"
              valor={form.email}
              onChange={(v) => setForm({ ...form, email: v })}
              onEnter={salvar}
              className="col-span-4"
            />
            <div className="col-span-3 flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={gravando}
                onClick={salvar}
                className="rounded-lg"
              >
                <Check className="size-4" />
                {gravando ? "Salvando…" : form.id ? "Salvar" : "Cadastrar"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setForm(null)}
                className="rounded-lg"
              >
                <X className="size-4" />
                <Kbd>Esc</Kbd>
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="px-5 py-2.5 text-left font-semibold">Nome</th>
              <th scope="col" className="w-44 px-2 py-2.5 text-left font-semibold">
                CPF / CNPJ
              </th>
              <th scope="col" className="px-2 py-2.5 text-left font-semibold">Endereço</th>
              <th scope="col" className="w-40 px-2 py-2.5 text-left font-semibold">
                Cidade
              </th>
              <th scope="col" className="w-24 px-5 py-2.5 text-right font-semibold" />
            </tr>
          </thead>
          <tbody>
            {encontrados.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-16 text-center">
                  <UserSearch
                    className="mx-auto size-10 text-muted-foreground/40"
                    aria-hidden
                  />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {busca
                      ? `Nada encontrado para “${busca}”`
                      : "Nenhum cliente cadastrado. A venda a prazo precisa de um."}
                  </p>
                </td>
              </tr>
            ) : (
              encontrados.map((cliente) => (
                <tr
                  key={cliente.id}
                  className={cn(
                    "border-b border-border",
                    form?.id === cliente.id && "bg-accent",
                    !cliente.ativo && "opacity-60"
                  )}
                >
                  <td className="px-5 py-2 font-medium">
                    {cliente.nome}
                    <Badge variant="outline" className="ml-2 text-[9px]">
                      {cliente.tipoPessoa === "JURIDICA" ? "PJ" : "PF"}
                    </Badge>
                    {!cliente.ativo ? (
                      <Badge variant="destructive" className="ml-1.5 text-[9px]">
                        inativo
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                    {formatarCpfCnpj(cliente.cpfCnpj)}
                  </td>
                  <td className="max-w-xs truncate px-2 py-2 text-xs text-muted-foreground">
                    {cliente.endereco}
                    {cliente.numero ? `, ${cliente.numero}` : ""} · {cliente.bairro} ·{" "}
                    {formatarCep(cliente.cep)}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {cliente.cidade}/{cliente.uf}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => abrir(cliente)}
                    >
                      Editar
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={gravando}
                      title={
                        cliente.ativo
                          ? "Sai do F6 do caixa; vendas antigas continuam intactas"
                          : "Volta a aparecer no caixa"
                      }
                      onClick={() =>
                        fetcher.submit(
                          { acao: "alternar", id: cliente.id },
                          { method: "post" }
                        )
                      }
                      className={cn(cliente.ativo && "text-destructive")}
                    >
                      {cliente.ativo ? "Desativar" : "Reativar"}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs">
        <span className="text-muted-foreground">
          O endereço aqui é o que vai no boleto — endereço incompleto faz o Inter
          recusar a cobrança · cliente não é apagado, é desativado
        </span>
        {aviso ? (
          <span
            className={cn(
              "font-medium",
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
        className="h-9 rounded-lg"
      />
    </div>
  )
}
