import { useEffect, useState } from "react"
import { AlertTriangle, Check, Loader2, Printer, QrCode, X } from "lucide-react"

import { Button } from "~/components/ui/button"
import type { PixPendenteResumo } from "~/lib/pix-pendente.server"
import { moeda } from "~/lib/moeda"
import { cn } from "~/lib/utils"

type Props = {
  pendentes: PixPendenteResumo[]
  /** txid sendo cancelado agora, para travar o botão até a resposta. */
  cancelando: string | null
  onCancelar: (txid: string) => void
  onImprimir: (vendaId: string) => void
  onVisto: (id: string) => void
}

/**
 * Os Pix que esperam pagamento com o caixa já livre, e o desfecho de cada um.
 *
 * Fica no canto e não some sozinho: um Pix pago precisa do comprovante na mão
 * do cliente, e um Pix pago sem venda precisa de alguém olhando o extrato.
 */
export function PixEmEspera({ pendentes, cancelando, onCancelar, onImprimir, onVisto }: Props) {
  // Um relógio só para todos os cartões.
  const [agora, setAgora] = useState(() => Date.now())
  const esperando = pendentes.some((p) => p.situacao === "aguardando")
  useEffect(() => {
    if (!esperando) return
    const id = setInterval(() => setAgora(Date.now()), 1000)
    return () => clearInterval(id)
  }, [esperando])

  if (pendentes.length === 0) return null

  return (
    <div
      aria-label="Pix em segundo plano"
      className="fixed right-4 bottom-20 z-30 flex w-80 flex-col gap-2"
    >
      {pendentes.map((p) => {
        const restante = Math.max(0, Math.floor((new Date(p.expiraEm).getTime() - agora) / 1000))
        const tempo = `${Math.floor(restante / 60)}:${String(restante % 60).padStart(2, "0")}`

        return (
          <div
            key={p.id}
            role="status"
            className={cn(
              "rounded-xl border bg-card p-3 text-sm shadow-lg",
              p.situacao === "falhou" ? "border-destructive" : "border-border"
            )}
          >
            <div className="flex items-start gap-2">
              <Icone situacao={p.situacao} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">
                  Pix {moeda(p.total)}
                  {p.situacao === "paga" && p.vendaNumero ? ` · venda #${p.vendaNumero}` : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {p.situacao === "aguardando"
                    ? `Aguardando · ${p.operador} · ${restante > 0 ? tempo : "expirando"}`
                    : p.situacao === "gravando"
                      ? "Pago — gravando a venda…"
                      : p.situacao === "paga"
                        ? "Pago — venda gravada"
                        : p.situacao === "cancelada"
                          ? "Cancelado — nada foi gravado"
                          : p.situacao === "expirada"
                            ? "Expirou sem pagamento — nada foi gravado"
                            : null}
                </div>
                {p.situacao === "falhou" ? (
                  <p className="mt-1 text-xs font-medium text-destructive">
                    Pago, mas a venda NÃO foi gravada: {p.erro}. Confira o extrato do
                    Inter e chame o gerente antes de cobrar de novo.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-2 flex justify-end gap-2">
              {p.situacao === "aguardando" ? (
                <Button
                  type="button"
                  tabIndex={-1}
                  variant="ghost"
                  size="sm"
                  className="rounded-lg"
                  disabled={cancelando === p.txid}
                  onClick={() => onCancelar(p.txid)}
                >
                  {cancelando === p.txid ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                  Cancelar
                </Button>
              ) : null}
              {p.situacao === "paga" && p.vendaId ? (
                <Button
                  type="button"
                  tabIndex={-1}
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => onImprimir(p.vendaId!)}
                >
                  <Printer className="size-4" />
                  Imprimir
                </Button>
              ) : null}
              {p.situacao !== "aguardando" && p.situacao !== "gravando" ? (
                <Button
                  type="button"
                  tabIndex={-1}
                  size="sm"
                  className="rounded-lg"
                  onClick={() => onVisto(p.id)}
                >
                  OK
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Icone({ situacao }: { situacao: string }) {
  const classe = "mt-0.5 size-4 shrink-0"
  if (situacao === "aguardando" || situacao === "gravando") {
    return <Loader2 className={cn(classe, "animate-spin text-muted-foreground")} aria-hidden />
  }
  if (situacao === "paga") return <Check className={cn(classe, "text-primary")} aria-hidden />
  if (situacao === "falhou") {
    return <AlertTriangle className={cn(classe, "text-destructive")} aria-hidden />
  }
  return <QrCode className={cn(classe, "text-muted-foreground")} aria-hidden />
}
