import { useEffect, useRef } from "react"
import { useFetcher } from "react-router"

import { Button } from "~/components/ui/button"
import { FORMAS_DA_BAIXA } from "~/lib/recebiveis"
import { cn } from "~/lib/utils"

/** O que a ação `intencao=baixar` das telas devolve. */
type RespostaDaBaixa = { ok: true; baixa: string } | { ok: false; erro: string }

/**
 * O formulário de "recebido na loja", o mesmo em Inadimplentes e em Contas a
 * receber. Posta para a rota em que está (as duas têm a ação `baixar`, que
 * chama `baixarNaLoja`), e mostra ali mesmo o que o servidor respondeu — a
 * recusa do Inter precisa aparecer ao lado do boleto, não num canto da tela.
 *
 * Tem fetcher próprio: duas baixas em boletos diferentes não disputam o mesmo
 * estado, e a baixa não se mistura com a resposta de outras ações da página.
 */
export function BaixaNaLoja({
  boleto,
  onFechar,
  onBaixado,
}: {
  boleto: { origem: string; id: string; valor: number }
  onFechar: () => void
  /**
   * Chamado com a mensagem quando a baixa dá certo. Onde o boleto some da lista
   * depois da baixa (Inadimplentes), o formulário some junto — e a confirmação
   * precisa ir para um lugar que continue na tela.
   */
  onBaixado?: (mensagem: string) => void
}) {
  const baixa = useFetcher<RespostaDaBaixa>()
  const enviando = baixa.state !== "idle"
  const resposta = baixa.state === "idle" ? baixa.data : undefined

  // Pela resposta crua, sem esperar o "idle": depois da ação a lista recarrega,
  // e em Inadimplentes o boleto baixado some — junto com este componente —
  // antes de o fetcher voltar a ficar parado.
  const avisado = useRef<unknown>(null)
  useEffect(() => {
    const dado = baixa.data
    if (!dado?.ok || avisado.current === dado) return
    avisado.current = dado
    onBaixado?.(dado.baixa)
  }, [baixa.data, onBaixado])

  return (
    <baixa.Form
      method="post"
      className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-primary/40 bg-background p-2"
    >
      <input type="hidden" name="intencao" value="baixar" />
      <input type="hidden" name="origem" value={boleto.origem} />
      <input type="hidden" name="id" value={boleto.id} />
      <span className="text-xs">
        O cliente pagou na loja — o boleto é cancelado no Inter para não ser pago de novo.
      </span>
      <select
        name="forma"
        defaultValue="dinheiro"
        aria-label="Como o cliente pagou"
        className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
      >
        {FORMAS_DA_BAIXA.map((f) => (
          <option key={f.id} value={f.id}>
            {f.rotulo}
          </option>
        ))}
      </select>
      <input
        name="valor"
        defaultValue={boleto.valor.toFixed(2).replace(".", ",")}
        inputMode="decimal"
        aria-label="Valor recebido"
        className="h-8 w-24 rounded-lg border border-border bg-background px-2 text-right font-mono text-xs"
      />
      <Button type="submit" size="xs" disabled={enviando}>
        {enviando ? "Baixando no Inter…" : "Confirmar baixa"}
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={onFechar}>
        Voltar
      </Button>
      {resposta ? (
        <span
          className={cn("w-full text-xs", resposta.ok ? "font-medium" : "text-destructive")}
          role="status"
        >
          {resposta.ok ? resposta.baixa : resposta.erro}
        </span>
      ) : null}
    </baixa.Form>
  )
}
