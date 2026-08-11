import { useEffect, useMemo, useRef, useState } from "react"
import { UserPlus } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { formatarCpfCnpj, UFS } from "~/lib/documento"
import { cn } from "~/lib/utils"

export type ClienteResumo = {
  id: string
  nome: string
  cpfCnpj: string
  cidade: string
  uf: string
}

type Props = {
  clientes: ClienteResumo[]
  selecionado: ClienteResumo | null
  gravando: boolean
  erro: string | null
  onEscolher: (cliente: ClienteResumo) => void
  onDesvincular: () => void
  onCriar: (dados: FormData) => void
  onFechar: () => void
}

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

export function ClienteDialogo({
  clientes,
  selecionado,
  gravando,
  erro,
  onEscolher,
  onDesvincular,
  onCriar,
  onFechar,
}: Props) {
  const [busca, setBusca] = useState("")
  const [indice, setIndice] = useState(0)
  const [cadastrando, setCadastrando] = useState(false)

  const campoBusca = useRef<HTMLInputElement>(null)
  const primeiroCampo = useRef<HTMLInputElement>(null)
  const formulario = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (cadastrando) primeiroCampo.current?.focus()
    else campoBusca.current?.focus()
  }, [cadastrando])

  useEffect(() => setIndice(0), [busca])

  const encontrados = useMemo(() => {
    const termo = normalizar(busca)
    const so = busca.replace(/\D/g, "")
    if (!termo) return clientes.slice(0, 8)

    return clientes
      .filter(
        (cliente) =>
          normalizar(cliente.nome).includes(termo) ||
          (so.length >= 3 && cliente.cpfCnpj.includes(so))
      )
      .slice(0, 8)
  }, [busca, clientes])

  // O diálogo captura as teclas antes da tela de venda enquanto está aberto.
  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") {
        evento.preventDefault()
        evento.stopPropagation()
        if (cadastrando) setCadastrando(false)
        else onFechar()
        return
      }

      if (cadastrando) {
        // No formulário, Enter envia — mas não quando o foco está num botão.
        if (evento.key === "Enter" && !(evento.target instanceof HTMLButtonElement)) {
          evento.preventDefault()
          evento.stopPropagation()
          formulario.current?.requestSubmit()
        }
        return
      }

      if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
        evento.preventDefault()
        evento.stopPropagation()
        const delta = evento.key === "ArrowDown" ? 1 : -1
        setIndice((atual) =>
          Math.min(Math.max(atual + delta, 0), Math.max(encontrados.length - 1, 0))
        )
        return
      }

      if (evento.key === "Enter") {
        evento.preventDefault()
        evento.stopPropagation()
        const escolhido = encontrados[indice]
        if (escolhido) onEscolher(escolhido)
        else setCadastrando(true)
        return
      }

      if (evento.key === "F7") {
        evento.preventDefault()
        evento.stopPropagation()
        setCadastrando(true)
      }
    }

    window.addEventListener("keydown", aoTeclar, true)
    return () => window.removeEventListener("keydown", aoTeclar, true)
  }, [cadastrando, encontrados, indice, onEscolher, onFechar])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cliente da venda"
      className="absolute inset-0 z-40 flex items-start justify-center bg-background/80 p-10 backdrop-blur-sm"
    >
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">
            {cadastrando ? "Novo cliente" : "Vincular cliente à venda"}
          </h2>
          <span className="text-xs text-muted-foreground">
            <Kbd>Esc</Kbd> {cadastrando ? "volta" : "fecha"}
          </span>
        </div>

        {selecionado && !cadastrando ? (
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              <b className="font-semibold">{selecionado.nome}</b>{" "}
              <span className="font-mono text-xs text-muted-foreground">
                {formatarCpfCnpj(selecionado.cpfCnpj)}
              </span>
            </span>
            <Button
              type="button"
              tabIndex={-1}
              variant="ghost"
              size="xs"
              onClick={onDesvincular}
            >
              Desvincular
            </Button>
          </div>
        ) : null}

        <Separator className="my-4" />

        {cadastrando ? (
          <form
            ref={formulario}
            onSubmit={(evento) => {
              evento.preventDefault()
              onCriar(new FormData(evento.currentTarget))
            }}
            className="grid grid-cols-6 gap-3"
          >
            <Campo
              ref={primeiroCampo}
              nome="nome"
              rotulo="Nome / Razão social"
              className="col-span-4"
              obrigatorio
            />
            <Campo nome="cpfCnpj" rotulo="CPF / CNPJ" className="col-span-2" obrigatorio />

            <Campo nome="cep" rotulo="CEP" className="col-span-2" obrigatorio />
            <Campo
              nome="endereco"
              rotulo="Endereço"
              className="col-span-4"
              obrigatorio
            />

            <Campo nome="numero" rotulo="Número" className="col-span-1" />
            <Campo nome="complemento" rotulo="Complemento" className="col-span-2" />
            <Campo nome="bairro" rotulo="Bairro" className="col-span-3" obrigatorio />

            <Campo nome="cidade" rotulo="Cidade" className="col-span-3" obrigatorio />
            <div className="col-span-1">
              <label
                htmlFor="uf"
                className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                UF *
              </label>
              <select
                id="uf"
                name="uf"
                required
                defaultValue="MG"
                className="h-9 w-full rounded-lg border border-border bg-input/50 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                {UFS.map((uf) => (
                  <option key={uf} value={uf}>
                    {uf}
                  </option>
                ))}
              </select>
            </div>
            <Campo nome="ddd" rotulo="DDD" className="col-span-1" />
            <Campo nome="telefone" rotulo="Telefone" className="col-span-1" />

            <Campo nome="email" rotulo="E-mail" tipo="email" className="col-span-6" />

            <div className="col-span-6 mt-1 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Os campos com * são exigidos pelo boleto.
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  tabIndex={-1}
                  variant="outline"
                  onClick={() => setCadastrando(false)}
                  className="rounded-lg"
                >
                  Voltar
                </Button>
                <Button type="submit" disabled={gravando} className="rounded-lg">
                  {gravando ? "Gravando…" : "Cadastrar"}
                  {gravando ? null : <Kbd>Enter</Kbd>}
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <>
            <Input
              ref={campoBusca}
              value={busca}
              onChange={(evento) => setBusca(evento.target.value)}
              placeholder="Busque por nome ou CPF/CNPJ…"
              aria-label="Buscar cliente"
              autoComplete="off"
              className="rounded-lg"
            />

            <ul className="mt-3 max-h-72 overflow-y-auto" role="listbox">
              {encontrados.length === 0 ? (
                <li className="px-1 py-8 text-center text-sm text-muted-foreground">
                  Nenhum cliente encontrado.
                  <br />
                  <Kbd>Enter</Kbd> ou <Kbd>F7</Kbd> para cadastrar.
                </li>
              ) : (
                encontrados.map((cliente, i) => (
                  <li key={cliente.id} role="option" aria-selected={i === indice}>
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => onEscolher(cliente)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                        i === indice
                          ? "bg-accent shadow-[inset_3px_0_0_var(--primary)]"
                          : "hover:bg-muted/60"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {cliente.nome}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {formatarCpfCnpj(cliente.cpfCnpj)}
                      </span>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {cliente.cidade}/{cliente.uf}
                      </Badge>
                    </button>
                  </li>
                ))
              )}
            </ul>

            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> escolhe · <Kbd>Enter</Kbd> vincula
              </span>
              <Button
                type="button"
                tabIndex={-1}
                variant="outline"
                size="sm"
                onClick={() => setCadastrando(true)}
                className="rounded-lg"
              >
                <UserPlus className="size-4" />
                Novo cliente
                <Kbd>F7</Kbd>
              </Button>
            </div>
          </>
        )}

        {erro ? (
          <p className="mt-3 text-xs font-medium text-destructive" role="status">
            {erro}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Campo({
  ref,
  nome,
  rotulo,
  tipo = "text",
  className,
  obrigatorio,
}: {
  ref?: React.Ref<HTMLInputElement>
  nome: string
  rotulo: string
  tipo?: string
  className?: string
  obrigatorio?: boolean
}) {
  return (
    <div className={className}>
      <label
        htmlFor={nome}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {rotulo} {obrigatorio ? "*" : ""}
      </label>
      <Input
        ref={ref}
        id={nome}
        name={nome}
        type={tipo}
        required={obrigatorio}
        autoComplete="off"
        className="rounded-lg"
      />
    </div>
  )
}
