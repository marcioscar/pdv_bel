import { Banknote, CalendarClock, CreditCard, QrCode, Wallet } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { cn } from "~/lib/utils"
import { formatarCpfCnpj } from "~/lib/documento"
import { moeda } from "~/lib/moeda"
import {
  DIAS_VENCIMENTO_PADRAO,
  FORMAS_PAGAMENTO,
  type FormaPagamento,
} from "~/lib/pdv"

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
  forma: FormaPagamento
  onFormaChange: (forma: FormaPagamento) => void
  recebido: number | null
  onFinalizar: () => void
  finalizando: boolean
  gravando: boolean
  cliente: { nome: string; cpfCnpj: string } | null
  vencimento: Date | null
}

export function PainelPagamento({
  subtotal,
  desconto,
  total,
  volumes,
  forma,
  onFormaChange,
  recebido,
  onFinalizar,
  finalizando,
  gravando,
  cliente,
  vencimento,
}: Props) {
  const troco = recebido === null ? null : recebido - total
  const insuficiente = troco !== null && troco < 0
  const aPrazo = forma === "prazo"
  // A prazo vira boleto e o boleto precisa do pagador; sem cliente não fecha.
  const faltaCliente = aPrazo && cliente === null

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

      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Forma de pagamento <Kbd className="ml-1">F8</Kbd>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {FORMAS_PAGAMENTO.map((opcao, indice) => {
            const Icone = ICONES[opcao.id]
            const selecionada = opcao.id === forma
            return (
              <Button
                key={opcao.id}
                type="button"
                tabIndex={-1}
                variant={selecionada ? "default" : "outline"}
                size="sm"
                onClick={() => onFormaChange(opcao.id)}
                className="justify-start rounded-lg"
              >
                <Icone className="size-4" />
                <span className="flex-1 text-left">{opcao.rotulo}</span>
                <Kbd
                  className={cn(
                    "text-[9px]",
                    selecionada && "bg-primary-foreground/20 text-primary-foreground"
                  )}
                >
                  ⇧F{indice + 1}
                </Kbd>
              </Button>
            )
          })}
        </div>
      </div>

      {aPrazo || cliente ? (
        <div
          className={cn(
            "rounded-lg border p-3",
            faltaCliente ? "border-destructive/40 bg-destructive/5" : "border-border bg-card"
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Cliente
            </span>
            <Kbd>F6</Kbd>
          </div>
          {cliente ? (
            <>
              <div className="mt-1 truncate text-sm font-medium">{cliente.nome}</div>
              <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {formatarCpfCnpj(cliente.cpfCnpj)}
              </div>
            </>
          ) : (
            <div className="mt-1 text-xs font-medium text-destructive">
              Venda a prazo exige cliente
            </div>
          )}

          {aPrazo ? (
            <div className="mt-2.5 flex items-baseline justify-between border-t border-border pt-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Vencimento
              </span>
              <span className="font-mono text-sm font-semibold tabular-nums">
                {vencimento
                  ? vencimento.toLocaleDateString("pt-BR")
                  : `${DIAS_VENCIMENTO_PADRAO} dias`}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {recebido !== null ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Recebido</span>
            <span className="font-mono tabular-nums">{moeda(recebido)}</span>
          </div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {insuficiente ? "Falta" : "Troco"}
            </span>
            <span
              className={cn(
                "font-mono text-xl font-bold tabular-nums",
                insuficiente && "text-destructive"
              )}
            >
              {moeda(Math.abs(troco ?? 0))}
            </span>
          </div>
        </div>
      ) : null}

      <div className="mt-auto">
        <Button
          type="button"
          tabIndex={-1}
          size="lg"
          onClick={onFinalizar}
          disabled={total <= 0 || insuficiente || gravando || faltaCliente}
          className="h-14 w-full rounded-xl text-base font-semibold"
        >
          {gravando
            ? "GRAVANDO…"
            : finalizando
              ? "CONFIRMAR PAGAMENTO"
              : "FINALIZAR VENDA"}
          {gravando ? null : (
            <Kbd className="bg-primary-foreground/20 text-primary-foreground">F10</Kbd>
          )}
        </Button>
      </div>
    </aside>
  )
}
