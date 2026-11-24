import { useEffect, useState } from "react"
import { CalendarClock } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { moeda } from "~/lib/moeda"
import { cn } from "~/lib/utils"
import {
  CONDICOES_ATIVAS,
  condicaoCabeNoTotal,
  parcelasDaCondicao,
  totalDaCondicao,
  VALOR_MINIMO_BOLETO,
  type CondicaoPagamento,
} from "~/lib/pdv"

type Props = {
  total: number
  /** O orçamento abre sem cliente; a venda a prazo sempre tem um. */
  cliente: { nome: string } | null
  /**
   * Presente só no orçamento (F7): põe "À vista" no topo da lista e troca os
   * textos — ali se imprime um papel, não se fecha venda.
   */
  onAVista?: () => void
  onEscolher: (condicao: CondicaoPagamento) => void
  onFechar: () => void
}

/**
 * Escolha do prazo. As condições são fixas — o vendedor escolhe uma da lista,
 * não digita dias. Antes ele digitava, e nada garantia que o prazo combinado com
 * o cliente fosse um dos que a empresa pratica.
 *
 * Mostra as parcelas já calculadas, com valor e data, antes de fechar a venda:
 * é o que o vendedor precisa dizer ao cliente, e é exatamente o que sairá nos
 * boletos (o mesmo `parcelasDaCondicao` roda no servidor na emissão).
 */
export function CondicaoDialogo({ total, cliente, onAVista, onEscolher, onFechar }: Props) {
  // Só o que cabe no total é navegável: uma parcela abaixo do mínimo do Inter
  // seria recusada na emissão, depois de a venda já estar gravada.
  const cabem = CONDICOES_ATIVAS.filter((c) => condicaoCabeNoTotal(c, total))
  // `null` é o à vista do orçamento.
  const disponiveis: (CondicaoPagamento | null)[] = onAVista ? [null, ...cabem] : cabem
  const rotuloDaJanela = onAVista ? "Orçamento" : "Condição de pagamento"

  function escolher(posicao: number) {
    const escolhida = disponiveis[posicao]
    if (escolhida === undefined) return
    if (escolhida === null) onAVista?.()
    else onEscolher(escolhida)
  }

  const [indice, setIndice] = useState(0)

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      const { key, ctrlKey, altKey, metaKey, shiftKey } = evento
      if (ctrlKey || altKey || metaKey || shiftKey) return

      if (key === "Escape") {
        evento.preventDefault()
        onFechar()
        return
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        evento.preventDefault()
        const delta = key === "ArrowDown" ? 1 : -1
        setIndice((atual) =>
          Math.min(Math.max(atual + delta, 0), Math.max(disponiveis.length - 1, 0))
        )
        return
      }

      // Os números escolhem direto — é a via rápida de quem já sabe o prazo.
      const posicao = Number(key) - 1
      if (Number.isInteger(posicao) && posicao >= 0 && posicao < disponiveis.length) {
        evento.preventDefault()
        escolher(posicao)
        return
      }

      if (key === "Enter" || key === "F10") {
        evento.preventDefault()
        escolher(indice)
      }
    }

    window.addEventListener("keydown", aoTeclar, true)
    return () => window.removeEventListener("keydown", aoTeclar, true)
  }, [disponiveis, indice, onAVista, onEscolher, onFechar])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={rotuloDaJanela}
      /* Camada 50: abre SOBRE a conferência do F10 (z-40), como o de cliente. */
      className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-8 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CalendarClock className="size-4" aria-hidden />
            {rotuloDaJanela}
          </h2>
          <span className="text-xs text-muted-foreground">
            <Kbd>Esc</Kbd> cancela
          </span>
        </div>

        <p className="mt-1 text-xs text-muted-foreground">
          {moeda(total)} à vista
          {cliente ? (
            <>
              , para <span className="font-medium text-foreground">{cliente.nome}</span>
            </>
          ) : null}{" "}
          ·{" "}
          {onAVista
            ? "prazo acima de 15 dias tem acréscimo, que sai embutido no preço dos produtos"
            : "cada parcela vira um boleto, e prazo acima de 15 dias tem acréscimo"}
        </p>

        <Separator className="my-4" />

        {disponiveis.length === 0 ? (
          <p className="py-8 text-center text-sm text-destructive">
            {moeda(total)} não fecha em nenhuma condição: o boleto exige no mínimo{" "}
            {moeda(VALOR_MINIMO_BOLETO)}.
          </p>
        ) : (
          <ul role="listbox" aria-label="Condições" className="space-y-2">
            {disponiveis.map((condicao, i) => {
              const ativa = i === indice
              const totalNoPrazo = condicao ? totalDaCondicao(condicao, total) : total
              const parcelas = condicao ? parcelasDaCondicao(condicao, totalNoPrazo) : []

              return (
                <li key={condicao?.id ?? "a-vista"} role="option" aria-selected={ativa}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setIndice(i)}
                    onClick={() => escolher(i)}
                    className={cn(
                      "w-full rounded-lg border px-4 py-3 text-left transition-colors",
                      ativa
                        ? "border-primary bg-accent shadow-[inset_3px_0_0_var(--primary)]"
                        : "border-border hover:bg-muted/60"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Kbd className="shrink-0">{i + 1}</Kbd>
                      <span className="flex-1 text-sm font-semibold">
                        {condicao?.rotulo ?? "À vista"}
                      </span>
                      {/* O total muda de uma condição para outra: o cliente
                          precisa ouvir quanto paga antes de escolher. */}
                      <span className="text-right font-mono text-sm font-semibold tabular-nums">
                        {moeda(totalNoPrazo)}
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          {condicao && condicao.acrescimo > 0 ? `+${condicao.acrescimo}%` : "preço à vista"}
                        </span>
                      </span>
                      {condicao ? (
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {parcelas.length === 1
                            ? "1 boleto"
                            : `${parcelas.length} boletos`}
                        </Badge>
                      ) : null}
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-9">
                      {parcelas.map((p) => (
                        <span
                          key={p.parcela}
                          className="font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          {parcelas.length > 1 ? `${p.parcela}ª ` : ""}
                          <span className="font-semibold text-foreground">
                            {moeda(p.valor)}
                          </span>{" "}
                          {/* No orçamento o prazo conta da compra, que ainda não houve. */}
                          {onAVista && condicao
                            ? `em ${condicao.dias[p.parcela - 1]} dias`
                            : `em ${p.vencimento.toLocaleDateString("pt-BR")}`}
                        </span>
                      ))}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {cabem.length < CONDICOES_ATIVAS.length && disponiveis.length > 0 ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Condições ocultas dividiriam {moeda(total)} em parcelas abaixo de{" "}
            {moeda(VALOR_MINIMO_BOLETO)}, o mínimo do boleto.
          </p>
        ) : null}

        <Separator className="my-4" />

        <div className="flex justify-between">
          <Button
            type="button"
            tabIndex={-1}
            variant="outline"
            onClick={onFechar}
            className="rounded-lg"
          >
            <Kbd>Esc</Kbd> Voltar
          </Button>
          <Button
            type="button"
            tabIndex={-1}
            disabled={disponiveis.length === 0}
            onClick={() => escolher(indice)}
            className="rounded-lg"
          >
            {onAVista ? "Imprimir" : "Fechar a prazo"}
            <Kbd className="bg-primary-foreground/20 text-primary-foreground">Enter</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
