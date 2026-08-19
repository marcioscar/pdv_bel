import { cn } from "~/lib/utils"

/**
 * Um número grande com rótulo — o cartão que abre Relatórios e Vendas da rede.
 *
 * Compartilhado para os dois lerem igual: faturamento em corpo maior, contagem
 * em corpo menor e o que é problema (cancelamentos) em vermelho. Duas cópias
 * divergiriam no espaçamento, e a diferença passaria por decisão de projeto.
 */
export function Numero({
  rotulo,
  valor,
  detalhe,
  destaque,
  alerta,
}: {
  rotulo: string
  valor: string
  detalhe?: string
  destaque?: boolean
  alerta?: boolean
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono font-bold tabular-nums",
          destaque ? "text-2xl" : "text-xl",
          alerta && "text-destructive"
        )}
      >
        {valor}
      </div>
      {detalhe ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{detalhe}</div>
      ) : null}
    </div>
  )
}
