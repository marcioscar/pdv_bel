import { Banknote, CalendarClock, CreditCard, QrCode, Wallet } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { cn } from "~/lib/utils"
import { formatarCpfCnpj } from "~/lib/documento"
import { moeda } from "~/lib/moeda"
import { FORMAS_PAGAMENTO, type FormaPagamento } from "~/lib/pdv"

const ICONES: Record<FormaPagamento, React.ComponentType<{ className?: string }>> = {
  dinheiro: Banknote,
  credito: CreditCard,
  debito: Wallet,
  pix: QrCode,
  prazo: CalendarClock,
}

type Props = {
  subtotal: number
  desconto: number
  total: number
  volumes: number
  /** Só para exibir o que está escolhido — quem decide é o diálogo do F10. */
  forma: FormaPagamento
  cliente: { nome: string; cpfCnpj: string } | null
  gravando: boolean
  onFinalizar: () => void
  desabilitado: boolean
}

/**
 * Resumo da venda. Ele NÃO decide mais a forma de pagamento nem o cliente: isso
 * acontece no diálogo do F10. Dois lugares mexendo no mesmo dado é como se grava
 * venda em dinheiro marcada como cartão.
 */
export function PainelPagamento({
  subtotal,
  desconto,
  total,
  volumes,
  forma,
  cliente,
  gravando,
  onFinalizar,
  desabilitado,
}: Props) {
  const Icone = ICONES[forma]

  return (
    <aside className="flex w-[320px] shrink-0 flex-col gap-4 border-l border-border bg-muted/30 p-5">
      <div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Subtotal</span>
          <span className="font-mono tabular-nums">{moeda(subtotal)}</span>
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
          <span>
            Desconto <Kbd className="ml-1">F3</Kbd>
          </span>
          <span
            className={cn(
              "font-mono tabular-nums",
              desconto > 0 && "text-destructive"
            )}
          >
            {desconto > 0 ? `− ${moeda(desconto)}` : moeda(0)}
          </span>
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
          <span>Volumes</span>
          <span className="font-mono tabular-nums">{volumes}</span>
        </div>

        <Separator className="my-3" />

        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Total a pagar
        </div>
        <div className="mt-0.5 font-mono text-4xl font-bold tracking-tight tabular-nums">
          {moeda(total)}
        </div>
      </div>

      {/* Mostra a escolha atual; trocar é no diálogo do F10. */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Pagamento
        </div>
        <div className="mt-1 flex items-center gap-2 text-sm font-medium">
          <Icone className="size-4 text-muted-foreground" />
          {FORMAS_PAGAMENTO.find((f) => f.id === forma)?.rotulo}
        </div>
        {cliente ? (
          <>
            <Separator className="my-2.5" />
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Cliente
            </div>
            <div className="mt-1 truncate text-sm font-medium">{cliente.nome}</div>
            <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {formatarCpfCnpj(cliente.cpfCnpj)}
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-auto">
        <Button
          type="button"
          tabIndex={-1}
          size="lg"
          onClick={onFinalizar}
          disabled={desabilitado || gravando}
          className="h-14 w-full rounded-xl text-base font-semibold"
        >
          {gravando ? "GRAVANDO…" : "FINALIZAR VENDA"}
          {gravando ? null : (
            <Kbd className="bg-primary-foreground/20 text-primary-foreground">F10</Kbd>
          )}
        </Button>
      </div>
    </aside>
  )
}
