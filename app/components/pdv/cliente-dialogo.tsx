import { useEffect, useMemo, useRef, useState } from "react"
import { UserPlus } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { FormularioCliente } from "~/components/pdv/formulario-cliente"
import { formatarCpfCnpj } from "~/lib/documento"
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
  /**
   * Abre direto no formulário de cadastro.
   *
   * Quando vem da conferência do F10, a busca já aconteceu no combobox de lá —
   * cair noutra lista de busca seria repetir o passo que o operador acabou de dar.
   */
  direto?: boolean
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
  direto = false,
}: Props) {
  const [busca, setBusca] = useState("")
  const [indice, setIndice] = useState(0)
  const [cadastrando, setCadastrando] = useState(direto)

  const campoBusca = useRef<HTMLInputElement>(null)
  const primeiroCampo = useRef<HTMLInputElement>(null)

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
        // Vindo direto do cadastro, o Esc fecha: a lista atrás não é o caminho
        // de volta, é a conferência.
        if (cadastrando && !direto) setCadastrando(false)
        else onFechar()
        return
      }

      // No formulário, o Enter é do próprio <form>: cadastrar de qualquer campo
      // já é o comportamento nativo, e interceptar aqui só o duplicaria.
      if (cadastrando) return

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
      /* Camada 50: este diálogo abre SOBRE a conferência do F10 (que é z-40). Sem
      isso ele ficava atrás dela — a ordem do JSX decidia, e a ordem do JSX é
      a última coisa em que se pensa ao mexer numa tela. */
      className="absolute inset-0 z-50 flex items-start justify-center bg-background/80 p-10 backdrop-blur-sm"
    >
      <div
        className={cn(
          "w-full rounded-xl border border-border bg-card p-6 shadow-xl",
          // O cadastro tem doze colunas; a lista de busca é uma coluna só.
          cadastrando ? "max-w-3xl" : "max-w-2xl"
        )}
      >
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
          <FormularioCliente
            gravando={gravando}
            erro={erro}
            primeiroCampo={primeiroCampo}
            aoSalvar={(dados) => {
              const formulario = new FormData()
              for (const [campo, valor] of Object.entries(dados)) {
                formulario.append(campo, valor)
              }
              onCriar(formulario)
            }}
            rodape={(salvar) => (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Endereço e documento são o que o boleto exige.
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
                  <Button
                    type="button"
                    disabled={gravando}
                    onClick={salvar}
                    className="rounded-lg"
                  >
                    {gravando ? "Gravando…" : "Cadastrar"}
                    {gravando ? null : <Kbd>Enter</Kbd>}
                  </Button>
                </div>
              </div>
            )}
          />
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

        {erro && !cadastrando ? (
          <p className="mt-3 text-xs font-medium text-destructive" role="alert">
            {erro}
          </p>
        ) : null}
      </div>
    </div>
  )
}
