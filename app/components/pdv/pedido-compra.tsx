import { useState } from "react"
import { PackageCheck } from "lucide-react"

import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"

/**
 * Recebe exige escolher a loja: a compra é da rede, mas o caminhão do
 * fornecedor para numa loja física, e é lá que o estoque precisa dar entrada.
 * Sem a loja escolhida o botão fica desabilitado — a alternativa era assumir
 * uma loja padrão, e advinhar errado creditaria mercadoria numa prateleira que
 * não a recebeu.
 *
 * Compartilhado entre a tela de Compras e a consulta de pedidos: as duas
 * mudam a situação do mesmo jeito, e duas cópias divergiriam na hora de
 * lembrar a loja.
 */
export function ReceberPedido({
  lojas,
  gravando,
  onReceber,
}: {
  lojas: string[]
  gravando: boolean
  onReceber: (loja: string) => void
}) {
  const [loja, setLoja] = useState("")

  return (
    <div className="flex items-center gap-1">
      <select
        value={loja}
        onChange={(e) => setLoja(e.target.value)}
        className={cn(
          "h-8 rounded-lg border bg-background px-1.5 text-xs",
          loja ? "border-border" : "border-destructive/50"
        )}
        aria-label="Loja que recebeu a mercadoria"
      >
        <option value="">Loja…</option>
        {lojas.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={gravando || !loja}
        onClick={() => onReceber(loja)}
      >
        <PackageCheck className="size-3.5" />
        Recebido
      </Button>
    </div>
  )
}
