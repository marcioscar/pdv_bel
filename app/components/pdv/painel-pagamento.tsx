import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { cn } from "~/lib/utils"
import { formatarCpfCnpj } from "~/lib/documento"
import { moeda } from "~/lib/moeda"

type Props = {
  subtotal: number
  desconto: number
  total: number
  volumes: number
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
  cliente,
  gravando,
  onFinalizar,
  desabilitado,
}: Props) {
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

      {/* A forma de pagamento saiu daqui: ela é escolhida na conferência do F10,
          e repeti-la abaixo do total só ocupava a vista com um dado que ninguém
          decide nesta tela. O cliente aparece só quando existe — o normal é a
          venda inteira correr como Consumidor Final. */}
      {cliente ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Cliente
          </div>
          <div className="mt-1 truncate text-sm font-medium">{cliente.nome}</div>
          <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {formatarCpfCnpj(cliente.cpfCnpj)}
          </div>
        </div>
      ) : null}

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
