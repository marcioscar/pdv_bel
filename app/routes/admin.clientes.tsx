import { useEffect, useMemo, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { Check, Loader2, Plus, Search, UserSearch, Users } from "lucide-react"

import type { Route } from "./+types/admin.clientes"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import {
  formatarCep,
  formatarCpfCnpj,
  limparCep,
  limparDocumento,
  mascararCep,
  mascararCpfCnpj,
  mascararTelefone,
  tipoPessoaDe,
  UFS,
  validarCep,
  validarCnpj,
  validarCpfCnpj,
} from "~/lib/documento"
import {
  alternarCliente,
  atualizarCliente,
  criarCliente,
  lerCliente,
  listarClientes,
} from "~/lib/clientes.server"
import { exigirUsuario } from "~/lib/sessao.server"
import type { EnderecoDoCep } from "~/routes/cep"
import type { DadosDoCnpj } from "~/routes/cnpj"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Clientes — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  // Cadastrar cliente é tarefa de operador — o boleto precisa do pagador, e quem
  // atende é quem tem os dados na mão.
  const eu = await exigirUsuario(request)
  // Inclui inativos: é esta a tela que os reativa.
  return {
    clientes: await listarClientes({ incluirInativos: true }),
    // A loja do turno: é ela que vai marcar o cadastro que nascer aqui.
    loja: eu.loja,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)

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
    : await criarCliente(entrada, { loja: eu.loja })

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
  inscricaoEstadual: string
  contatoNome: string
  contatoTelefone: string
  contatoEmail: string
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
  inscricaoEstadual: "",
  contatoNome: "",
  contatoTelefone: "",
  contatoEmail: "",
}

function doCliente(c: Cliente): Formulario {
  return {
    id: c.id,
    nome: c.nome,
    cpfCnpj: formatarCpfCnpj(c.cpfCnpj),
    cep: formatarCep(c.cep),
    endereco: c.endereco,
    numero: c.numero ?? "",
    complemento: c.complemento ?? "",
    bairro: c.bairro,
    cidade: c.cidade,
    uf: c.uf,
    email: c.email ?? "",
    ddd: c.ddd ?? "",
    telefone: mascararTelefone(c.telefone ?? ""),
    inscricaoEstadual: c.inscricaoEstadual ?? "",
    contatoNome: c.contatoNome ?? "",
    contatoTelefone: c.contatoTelefone ?? "",
    contatoEmail: c.contatoEmail ?? "",
  }
}

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

export default function AdminClientes({ loaderData }: Route.ComponentProps) {
  const { clientes, loja } = loaderData

  const [busca, setBusca] = useState("")
  const [mostrarInativos, setMostrarInativos] = useState(false)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  // `editando` guarda quem está no diálogo mesmo depois de fechar, para a
  // animação de saída não perder o conteúdo; `chave` remonta o formulário a cada
  // abertura, que é o que garante campos limpos sem um efeito de sincronia.
  const [aberto, setAberto] = useState(false)
  const [editando, setEditando] = useState<Cliente | null>(null)
  const [chave, setChave] = useState(0)

  const campoBusca = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

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
    if (!aberto) campoBusca.current?.focus()
  }, [aberto])

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 5000)
    return () => clearTimeout(id)
  }, [aviso])

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data
    setAviso(
      fetcher.data.ok
        ? { texto: fetcher.data.mensagem, tipo: "sucesso" }
        : { texto: fetcher.data.erro, tipo: "erro" }
    )
  }, [fetcher.state, fetcher.data])

  function abrir(cliente: Cliente | null) {
    setEditando(cliente)
    setChave((n) => n + 1)
    setAberto(true)
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

      <Dialog open={aberto} onOpenChange={(estado) => setAberto(estado)}>
        <FormularioCliente
          key={chave}
          cliente={editando}
          loja={loja}
          aoConcluir={(mensagem) => {
            setAviso({ texto: mensagem, tipo: "sucesso" })
            setAberto(false)
          }}
        />
      </Dialog>

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
              <th scope="col" className="w-28 px-2 py-2.5 text-left font-semibold">
                Cadastro
              </th>
              <th scope="col" className="w-24 px-5 py-2.5 text-right font-semibold" />
            </tr>
          </thead>
          <tbody>
            {encontrados.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-16 text-center">
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
                    aberto && editando?.id === cliente.id && "bg-accent",
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
                    {cliente.inscricaoEstadual ? (
                      <span className="block text-[10px] opacity-70">
                        IE {cliente.inscricaoEstadual}
                      </span>
                    ) : null}
                  </td>
                  <td className="max-w-xs truncate px-2 py-2 text-xs text-muted-foreground">
                    {cliente.endereco}
                    {cliente.numero ? `, ${cliente.numero}` : ""} · {cliente.bairro} ·{" "}
                    {formatarCep(cliente.cep)}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {cliente.cidade}/{cliente.uf}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {/* Os cadastros anteriores a este campo não têm loja: melhor
                        o travessão do que fingir que foi a loja de quem olha. */}
                    {cliente.lojaCadastro ?? "—"}
                    <span className="block font-mono text-[10px] tabular-nums opacity-70">
                      {cliente.criadoEm.toLocaleDateString("pt-BR")}
                    </span>
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

/**
 * O formulário mora num componente à parte, com estado próprio, e é remontado a
 * cada abertura. Antes ele era um painel na própria tela e o estado do cadastro
 * vivia junto com o da lista: o efeito que dava foco no primeiro campo dependia
 * do objeto do formulário e, como cada tecla criava um objeto novo, o foco
 * voltava para o Nome a cada caractere digitado em qualquer outro campo.
 */
function FormularioCliente({
  cliente,
  loja,
  aoConcluir,
}: {
  cliente: Cliente | null
  loja: string
  aoConcluir: (mensagem: string) => void
}) {
  const [form, setForm] = useState<Formulario>(cliente ? doCliente(cliente) : VAZIO)
  const [erro, setErro] = useState<string | null>(null)
  const [nota, setNota] = useState<string | null>(null)

  const primeiroCampo = useRef<HTMLInputElement>(null)
  const cepBuscado = useRef<string | null>(cliente ? limparCep(cliente.cep) : null)
  const cnpjBuscado = useRef<string | null>(cliente ? limparDocumento(cliente.cpfCnpj) : null)
  const ultimaResposta = useRef<unknown>(null)

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  const buscaCep = useFetcher<EnderecoDoCep | { erro: string }>()
  const buscaCnpj = useFetcher<DadosDoCnpj | { erro: string }>()
  const buscandoCep = buscaCep.state !== "idle"
  const buscandoCnpj = buscaCnpj.state !== "idle"

  const documento = limparDocumento(form.cpfCnpj)
  const documentoInvalido =
    (documento.length === 11 || documento.length === 14) && !validarCpfCnpj(documento)

  function alterar(campos: Partial<Formulario>) {
    setForm((atual) => ({ ...atual, ...campos }))
  }

  // Assim que o CEP fica completo, busca — sem apertar nada.
  useEffect(() => {
    const limpo = limparCep(form.cep)
    if (!validarCep(limpo) || cepBuscado.current === limpo) return
    cepBuscado.current = limpo
    buscaCep.load(`/cep/${limpo}`)
  }, [form.cep, buscaCep])

  // E o mesmo com o CNPJ: quatorze dígitos válidos, a Receita responde o resto do
  // cadastro. CPF não tem consulta pública — ali só vale a validação do dígito.
  useEffect(() => {
    if (!validarCnpj(documento) || !/^\d{14}$/.test(documento)) return
    if (cnpjBuscado.current === documento) return
    cnpjBuscado.current = documento
    buscaCnpj.load(`/cnpj/${documento}`)
  }, [documento, buscaCnpj])

  useEffect(() => {
    if (buscaCep.state !== "idle" || !buscaCep.data) return
    if ("erro" in buscaCep.data) {
      setNota(buscaCep.data.erro)
      return
    }
    const achado = buscaCep.data
    setNota(null)
    // Substitui os quatro campos: preservar o que estava deixaria o bairro do CEP
    // anterior numa cidade nova — endereço misturado, que iria para o boleto.
    alterar({
      endereco: achado.endereco,
      bairro: achado.bairro,
      cidade: achado.cidade,
      uf: achado.uf,
    })
  }, [buscaCep.state, buscaCep.data])

  useEffect(() => {
    if (buscaCnpj.state !== "idle" || !buscaCnpj.data) return
    if ("erro" in buscaCnpj.data) {
      setNota(buscaCnpj.data.erro)
      return
    }
    const achado = buscaCnpj.data
    setNota(
      achado.situacao && achado.situacao !== "ATIVA"
        ? `Atenção: situação cadastral ${achado.situacao} na Receita`
        : null
    )
    // O CEP veio junto: marca como já buscado para a consulta de CEP não disparar
    // e sobrescrever o logradouro da Receita pelo genérico do CEP.
    if (achado.cep) cepBuscado.current = achado.cep

    setForm((atual) => ({
      ...atual,
      nome: achado.nome || atual.nome,
      cep: achado.cep ? mascararCep(achado.cep) : atual.cep,
      endereco: achado.endereco || atual.endereco,
      numero: achado.numero || atual.numero,
      complemento: achado.complemento || atual.complemento,
      bairro: achado.bairro || atual.bairro,
      cidade: achado.cidade || atual.cidade,
      uf: achado.uf || atual.uf,
      ddd: achado.ddd || atual.ddd,
      telefone: achado.telefone ? mascararTelefone(achado.telefone) : atual.telefone,
      email: achado.email || atual.email,
    }))
  }, [buscaCnpj.state, buscaCnpj.data])

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data

    if (fetcher.data.ok) aoConcluir(fetcher.data.mensagem)
    else setErro(fetcher.data.erro)
  }, [fetcher.state, fetcher.data, aoConcluir])

  function salvar() {
    if (gravando) return
    setErro(null)
    // Grava sem máscara: o banco guarda dígito, a máscara é só da tela.
    fetcher.submit(
      {
        ...form,
        id: form.id ?? "",
        cpfCnpj: documento,
        cep: limparCep(form.cep),
        ddd: form.ddd.replace(/\D/g, ""),
        telefone: form.telefone.replace(/\D/g, ""),
      },
      { method: "post" }
    )
  }

  const tipo = tipoPessoaDe(documento)

  return (
    <DialogContent
      className="sm:max-w-3xl"
      initialFocus={primeiroCampo}
    >
      <DialogHeader>
        <DialogTitle>{cliente ? "Editar cliente" : "Novo cliente"}</DialogTitle>
        <DialogDescription>
          Comece pelo documento: com o CNPJ a Receita preenche o resto, e o CEP
          completa o endereço. Tudo o que está aqui é o que vai no boleto.
        </DialogDescription>
      </DialogHeader>

      <form
        onSubmit={(evento) => {
          evento.preventDefault()
          salvar()
        }}
        className="grid grid-cols-12 gap-3"
      >
        <div className="col-span-4">
          <label className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            CPF / CNPJ
            {buscandoCnpj ? (
              <span className="flex items-center gap-1 normal-case">
                <Loader2 className="size-3 animate-spin" aria-hidden /> consultando Receita
              </span>
            ) : tipo ? (
              <Badge variant="outline" className="text-[9px] normal-case">
                {tipo === "JURIDICA" ? "PJ" : "PF"}
              </Badge>
            ) : null}
          </label>
          <Input
            ref={primeiroCampo}
            value={form.cpfCnpj}
            onChange={(e) => alterar({ cpfCnpj: mascararCpfCnpj(e.target.value) })}
            placeholder="000.000.000-00"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={documentoInvalido || undefined}
            className="h-9 rounded-lg font-mono tabular-nums"
          />
          {documentoInvalido ? (
            <p className="mt-1 text-[11px] font-medium text-destructive">
              Dígito verificador não confere
            </p>
          ) : null}
        </div>
        <Campo
          rotulo="Inscr. estadual"
          valor={form.inscricaoEstadual}
          onChange={(v) => alterar({ inscricaoEstadual: v.toUpperCase() })}
          placeholder="ISENTO"
          className="col-span-3"
        />
        <Campo
          rotulo="Nome / Razão social"
          valor={form.nome}
          onChange={(v) => alterar({ nome: v })}
          className="col-span-5"
        />

        <div className="col-span-3">
          <label className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            CEP
            {buscandoCep ? (
              <span className="flex items-center gap-1 normal-case">
                <Search className="size-3 animate-pulse" aria-hidden /> buscando
              </span>
            ) : null}
          </label>
          <Input
            value={form.cep}
            onChange={(e) => alterar({ cep: mascararCep(e.target.value) })}
            placeholder="30110-000"
            inputMode="numeric"
            autoComplete="off"
            className="h-9 rounded-lg font-mono tabular-nums"
          />
        </div>
        <Campo
          rotulo="Endereço"
          valor={form.endereco}
          onChange={(v) => alterar({ endereco: v })}
          className="col-span-7"
        />
        <Campo
          rotulo="Nº"
          valor={form.numero}
          onChange={(v) => alterar({ numero: v })}
          className="col-span-2"
        />

        <Campo
          rotulo="Complemento"
          valor={form.complemento}
          onChange={(v) => alterar({ complemento: v })}
          className="col-span-3"
        />
        <Campo
          rotulo="Bairro"
          valor={form.bairro}
          onChange={(v) => alterar({ bairro: v })}
          className="col-span-4"
        />
        <Campo
          rotulo="Cidade"
          valor={form.cidade}
          onChange={(v) => alterar({ cidade: v })}
          className="col-span-3"
        />
        <div className="col-span-2">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            UF
          </label>
          <select
            value={form.uf}
            onChange={(e) => alterar({ uf: e.target.value })}
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
          rotulo="DDD"
          valor={form.ddd}
          onChange={(v) => alterar({ ddd: v.replace(/\D/g, "").slice(0, 2) })}
          className="col-span-2"
        />
        <Campo
          rotulo="Telefone"
          valor={form.telefone}
          onChange={(v) => alterar({ telefone: mascararTelefone(v) })}
          className="col-span-3"
        />
        <Campo
          rotulo="E-mail"
          valor={form.email}
          onChange={(v) => alterar({ email: v })}
          className="col-span-7"
        />

        {/* O bloco de cima é o que vai no boleto; este é para o vendedor ligar.
            Sem a separação, "telefone" e "e-mail" apareceriam duas vezes na
            mesma grade sem nada dizendo qual é qual. */}
        <div className="col-span-12 mt-1 border-t border-border pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Contato na empresa
        </div>
        <Campo
          rotulo="Nome do contato"
          valor={form.contatoNome}
          onChange={(v) => alterar({ contatoNome: v })}
          className="col-span-4"
        />
        <Campo
          rotulo="Telefone do contato"
          valor={form.contatoTelefone}
          onChange={(v) => alterar({ contatoTelefone: v })}
          placeholder="(61) 99100-1916"
          className="col-span-3"
        />
        <Campo
          rotulo="E-mail do contato"
          valor={form.contatoEmail}
          onChange={(v) => alterar({ contatoEmail: v })}
          className="col-span-5"
        />

        {/* O submit de verdade: deixa o Enter em qualquer campo cadastrar. */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
      </form>

      {erro ? (
        <p className="text-sm font-medium text-destructive" role="alert">
          {erro}
        </p>
      ) : nota ? (
        <p className="text-sm text-muted-foreground" role="status">
          {nota}
        </p>
      ) : null}

      <DialogFooter className="sm:items-center sm:justify-between">
        <span className="text-xs text-muted-foreground">
          {cliente
            ? cliente.lojaCadastro
              ? `Cadastrado em ${cliente.lojaCadastro} · ${cliente.criadoEm.toLocaleDateString("pt-BR")}`
              : `Cadastrado em ${cliente.criadoEm.toLocaleDateString("pt-BR")}`
            : `Vai ficar registrado como cadastro da loja ${loja}`}
        </span>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
          <Button type="button" disabled={gravando} onClick={salvar}>
            <Check className="size-4" />
            {gravando ? "Salvando…" : cliente ? "Salvar" : "Cadastrar"}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  )
}

function Campo({
  ref,
  rotulo,
  valor,
  onChange,
  placeholder,
  className,
}: {
  ref?: React.Ref<HTMLInputElement>
  rotulo: string
  valor: string
  onChange: (valor: string) => void
  placeholder?: string
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
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="h-9 rounded-lg"
      />
    </div>
  )
}
