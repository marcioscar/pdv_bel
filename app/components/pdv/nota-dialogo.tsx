import { CircleAlert, CircleCheck, FileText, Loader2, RotateCw } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"

export type NotaNoBalcao = {
  vendaId: string
  vendaNumero: number
  /** "nfe" | "nfce" — null quando a emissão falhou antes de a Focus responder. */
  modelo: string | null
  notaId: string | null
  numero: string | null
  emitida: boolean
  /** Homologação: autorizada, mas sem valor fiscal. */
  teste: boolean
  erro: string | null
  emitindo: boolean
}

type Props = {
  nota: NotaNoBalcao
  onTentarDeNovo: () => void
  onFechar: () => void
}

/**
 * O desfecho da nota pedida no fechamento, ali mesmo no caixa.
 *
 * Abre em dois casos, e só neles: NF-e autorizada, cujo DANFE é A4 e não sai na
 * bobina, e nota que não saiu. Antes os dois viravam uma linha na barra de
 * status — "NF-e: emita em Vendas", com a nota JÁ emitida —, e o vendedor ia
 * procurar a venda para emitir de novo. A NFC-e autorizada não abre nada: o
 * DANFE dela já saiu na bobina no lugar do cupom.
 */
export function NotaDialogo({ nota, onTentarDeNovo, onFechar }: Props) {
  const rotulo = nota.modelo === "nfce" ? "NFC-e" : nota.modelo === "nfe" ? "NF-e" : "Nota"
  const danfe = nota.notaId ? `/notas/${nota.notaId}/danfe` : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nota-titulo"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 id="nota-titulo" className="text-base font-semibold">
            Venda #{nota.vendaNumero}
          </h2>
          <span className="text-xs text-muted-foreground">{rotulo}</span>
        </div>

        {nota.emitindo ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
            <div className="text-sm">Enviando a {rotulo} à SEFAZ…</div>
          </div>
        ) : nota.emitida ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <CircleCheck className="size-8 text-primary" aria-hidden />
            <div className="text-lg font-semibold">
              {rotulo} {nota.numero ?? ""} autorizada
            </div>
            <div className="text-xs text-muted-foreground">
              {nota.teste
                ? "Homologação: nota de teste, sem valor fiscal"
                : "O DANFE é A4: abra para imprimir na impressora comum ou mandar ao cliente"}
            </div>
          </div>
        ) : (
          <div className="py-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <CircleAlert className="size-4" aria-hidden />
              {rotulo} não saiu — a venda está gravada
            </div>
            <div
              role="alert"
              className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm leading-snug"
            >
              {nota.erro ?? "A SEFAZ ainda não respondeu. Confira em Vendas daqui a pouco."}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Corrigido o motivo (cadastro do cliente, NCM do produto), tente de novo aqui. Ela
              continua pendente em Vendas.
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {!nota.emitindo && !nota.emitida ? (
            <Button type="button" variant="outline" onClick={onTentarDeNovo} className="rounded-lg">
              <RotateCw className="size-4" aria-hidden />
              Tentar de novo
            </Button>
          ) : null}
          {nota.emitida && danfe ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              onClick={() => window.open(danfe, "_blank", "noopener")}
            >
              <FileText className="size-4" aria-hidden />
              Abrir DANFE
            </Button>
          ) : null}
          <Button type="button" onClick={onFechar} disabled={nota.emitindo} className="rounded-lg">
            <Kbd>Enter</Kbd>
            Fechar
          </Button>
        </div>
      </div>
    </div>
  )
}
