import { useEffect, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { Loader2, Search } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import type { NcmEncontrado } from "~/lib/ncm.server"
import type { RespostaNcm } from "~/routes/admin.ncm"
import { cn } from "~/lib/utils"

type Consulta = { achados: NcmEncontrado[]; tabelaVazia: boolean }

/**
 * Escolhe o NCM procurando pela tabela oficial, em vez de digitar oito dígitos
 * de cabeça.
 *
 * A busca é do lado do servidor porque a tabela tem dez mil linhas — mandá-las
 * ao navegador custaria dois megabytes por carregamento de página para algo que
 * só se usa ao cadastrar produto novo.
 *
 * O campo continua aceitando os oito dígitos digitados direto: quem já sabe o
 * código não deve ser obrigado a procurar por ele.
 */
export function BuscaNcm({
  valor,
  onEscolher,
  className,
}: {
  valor: string
  onEscolher: (ncm: string) => void
  className?: string
}) {
  const busca = useFetcher<Consulta>()
  const importacao = useFetcher<RespostaNcm>()
  const [aberta, setAberta] = useState(false)
  const [termo, setTermo] = useState("")
  const caixa = useRef<HTMLDivElement>(null)

  const importando = importacao.state !== "idle"

  // Só consulta com a lista aberta, e espera a digitação parar: sem isso é uma
  // ida ao servidor por tecla, com o resultado da penúltima chegando por último.
  useEffect(() => {
    if (!aberta) return
    const id = setTimeout(() => {
      busca.load(`/admin/ncm?q=${encodeURIComponent(termo)}`)
    }, 250)
    return () => clearTimeout(id)
  }, [termo, aberta])

  // Clicar fora fecha. Sem isto a lista fica sobre os campos seguintes.
  useEffect(() => {
    if (!aberta) return
    function aoClicar(evento: MouseEvent) {
      if (!caixa.current?.contains(evento.target as Node)) setAberta(false)
    }
    document.addEventListener("mousedown", aoClicar)
    return () => document.removeEventListener("mousedown", aoClicar)
  }, [aberta])

  // Terminou de importar: refaz a consulta, senão a lista segue dizendo que a
  // tabela está vazia enquanto ela já tem dez mil linhas.
  useEffect(() => {
    if (importacao.state === "idle" && importacao.data?.ok) {
      busca.load(`/admin/ncm?q=${encodeURIComponent(termo)}`)
    }
  }, [importacao.state, importacao.data])

  const achados = busca.data?.achados ?? []
  const tabelaVazia = busca.data?.tabelaVazia ?? false

  return (
    <div ref={caixa} className={cn("relative", className)}>
      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          NCM
        </span>
        <Input
          value={valor}
          onChange={(e) => onEscolher(e.target.value.replace(/\D/g, "").slice(0, 8))}
          onFocus={() => setAberta(true)}
          placeholder="8 dígitos ou busque"
          className="mt-1 h-9 font-mono"
        />
      </label>

      {aberta ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-[34rem] max-w-[90vw] rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              placeholder="saco plástico, caixa papel ondulado, 3923…"
              className="h-6 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {busca.state !== "idle" ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
          </div>

          {tabelaVazia ? (
            <div className="px-3 py-4 text-center">
              <p className="text-xs text-muted-foreground">
                A tabela NCM ainda não foi trazida da fonte oficial.
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={importando}
                onClick={() => importacao.submit(null, { method: "post", action: "/admin/ncm" })}
                className="mt-2"
              >
                {importando ? "Trazendo… (uns 20 s)" : "Trazer agora do Siscomex"}
              </Button>
              {importacao.data && !importacao.data.ok ? (
                <p className="mt-1.5 text-[11px] text-destructive">{importacao.data.erro}</p>
              ) : null}
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {achados.length === 0 ? (
                <li className="px-3 py-3 text-xs text-muted-foreground">
                  {termo.trim()
                    ? "Nada com esse termo. A tabela usa o vocabulário oficial — 'papel ou cartão' no lugar de papelão, 'películas' no lugar de filme."
                    : "Digite para procurar."}
                </li>
              ) : (
                achados.map((n) => (
                  <li key={n.codigo}>
                    <button
                      type="button"
                      onClick={() => {
                        onEscolher(n.codigo)
                        setAberta(false)
                      }}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-accent",
                        valor === n.codigo && "bg-accent"
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{n.formatado}</span>
                        {/* Quantos produtos já usam: quem cadastra o milésimo saco
                            quer o mesmo código dos outros 999. */}
                        {n.usos > 0 ? (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                            {n.usos} no catálogo
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {n.caminho}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
