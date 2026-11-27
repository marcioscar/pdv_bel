import { useEffect, useRef, useState } from "react"
import { CalendarClock } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { arredondar, interpretarValor, moeda } from "~/lib/moeda"
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
   * textos — ali se imprime um papel, não se fecha venda. Também liga o campo
   * de desconto, que só o orçamento tem: na venda o desconto é dado no F10.
   */
  onAVista?: (desconto: number) => void
  /** O desconto só vem no orçamento; na venda é sempre 0. */
  onEscolher: (condicao: CondicaoPagamento, desconto: number) => void
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
export function CondicaoDialogo({ total: subtotal, cliente, onAVista, onEscolher, onFechar }: Props) {
  /*
   * Desconto do orçamento, em reais ("15,50") ou percentual ("10%"), como no
   * F10. Fica só nesta janela: o papel sai com ele, o carrinho não muda — o
   * desconto da venda continua sendo dado (e autorizado) no fechamento.
   */
  const campoDesconto = useRef<HTMLInputElement>(null)
  const [descontoTexto, setDescontoTexto] = useState("")
  const descontoLido = lerDesconto(descontoTexto, subtotal)
  const desconto = onAVista && typeof descontoLido === "number" ? descontoLido : 0
  const erroDesconto = onAVista && typeof descontoLido === "string" ? descontoLido : null
  const total = arredondar(subtotal - desconto)

  // Só o que cabe no total é navegável: uma parcela abaixo do mínimo do Inter
  // seria recusada na emissão, depois de a venda já estar gravada.
  const cabem = CONDICOES_ATIVAS.filter((c) => condicaoCabeNoTotal(c, total))
  // `null` é o à vista do orçamento.
  const disponiveis: (CondicaoPagamento | null)[] = onAVista ? [null, ...cabem] : cabem
  const rotuloDaJanela = onAVista ? "Orçamento" : "Condição de pagamento"

  function escolher(posicao: number) {
    const escolhida = disponiveis[posicao]
    if (escolhida === undefined || erroDesconto) return
    if (escolhida === null) onAVista?.(desconto)
    else onEscolher(escolhida, desconto)
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

      // F3 leva ao desconto — a mesma tecla do carrinho e do fechamento.
      if (key === "F3" && onAVista) {
        evento.preventDefault()
        campoDesconto.current?.focus()
        campoDesconto.current?.select()
        return
      }

      // Dentro do campo de desconto os números são do valor, não atalhos.
      const digitando = evento.target === campoDesconto.current

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
      if (!digitando && Number.isInteger(posicao) && posicao >= 0 && posicao < disponiveis.length) {
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
  }, [disponiveis, indice, onAVista, onEscolher, onFechar, desconto, erroDesconto])

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

        {onAVista ? (
          <div className="mt-4 flex items-start justify-between gap-4">
            <label htmlFor="orcamento-desconto" className="pt-1.5 text-sm font-medium">
              Desconto <Kbd>F3</Kbd>
              <span className="block text-[11px] font-normal text-muted-foreground">
                subtotal {moeda(subtotal)}
              </span>
            </label>
            <div className="w-40">
              <Input
                id="orcamento-desconto"
                ref={campoDesconto}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00 ou 10%"
                value={descontoTexto}
                onChange={(e) => setDescontoTexto(e.target.value)}
                className={cn(
                  "text-right font-mono tabular-nums",
                  erroDesconto && "border-destructive"
                )}
              />
              {erroDesconto ? (
                <p className="mt-1 text-right text-xs text-destructive">{erroDesconto}</p>
              ) : desconto > 0 ? (
                <p className="mt-1 text-right text-xs text-muted-foreground">
                  − {moeda(desconto)}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

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
            disabled={disponiveis.length === 0 || Boolean(erroDesconto)}
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

/**
 * O desconto digitado: o valor em reais, ou a mensagem de erro. Mesma regra do
 * F10 — reais ou percentual sobre o subtotal, e nunca mais que o subtotal.
 */
function lerDesconto(texto: string, subtotal: number): number | string {
  const limpo = texto.trim()
  if (limpo === "") return 0
  const percentual = limpo.endsWith("%")
  const numero = interpretarValor(percentual ? limpo.slice(0, -1) : limpo)
  if (numero === null || numero < 0) return "Desconto inválido"
  const valor = percentual ? Math.round(subtotal * numero) / 100 : Math.round(numero * 100) / 100
  if (valor > subtotal) return `Maior que o subtotal (${moeda(subtotal)})`
  return valor
}
