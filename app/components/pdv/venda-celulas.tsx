import { Badge } from "~/components/ui/badge"
import { quantidade as formatarQuantidade } from "~/lib/moeda"

/**
 * As células que aparecem em toda tabela de vendas — a do turno (/vendas) e a da
 * rede (/admin/vendas). Ficam aqui porque duas cópias divergiriam: a regra de
 * "quantas parcelas já foram recebidas" é a mesma pergunta nas duas telas.
 */

/** Quantos itens cabem na linha antes de virar "+N". */
const ITENS_VISIVEIS = 3

/**
 * Os produtos da venda, um por linha.
 *
 * Antes era tudo numa frase separada por vírgula, com `truncate` num `<span>`
 * inline — onde `truncate` não faz nada. O texto crescia, quebrava em duas linhas
 * e invadia a coluna da forma de pagamento.
 *
 * O teto de três linhas existe para a altura da linha não depender do tamanho da
 * venda: uma compra de vinte itens deixaria a tabela impossível de percorrer. O
 * resto vira "+N", e quem precisa do detalhe abre o cupom.
 */
export function ItensDaVenda({
  itens,
}: {
  itens: { descricao: string; quantidade: number; unidade: string }[]
}) {
  const restantes = itens.length - ITENS_VISIVEIS

  return (
    <div className="max-w-[26rem] text-xs text-muted-foreground">
      {itens.slice(0, ITENS_VISIVEIS).map((item, i) => (
        <div key={i} className="flex gap-1.5">
          <span className="shrink-0 font-mono tabular-nums">
            {formatarQuantidade(item.quantidade)}×
          </span>
          {/* `truncate` precisa de elemento de bloco com largura limitada — era
              justamente o que faltava e fazia o texto vazar para a coluna vizinha. */}
          <span className="truncate">{item.descricao}</span>
        </div>
      ))}
      {restantes > 0 ? (
        <div className="font-medium">
          + {restantes} {restantes === 1 ? "produto" : "produtos"}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Situação da venda a prazo. Com parcelamento não há uma situação só: mostra a
 * das parcelas quando coincidem e, quando não, quantas já foram recebidas — o
 * que o operador precisa saber é se o cliente ainda deve algo.
 */
export function SituacaoCobrancas({
  cobrancas,
}: {
  cobrancas: { parcela: number; parcelas: number; situacao: string }[]
}) {
  if (cobrancas.length === 0) {
    return <span className="text-xs text-destructive">sem boleto</span>
  }

  const recebidas = cobrancas.filter((c) => c.situacao === "RECEBIDO").length
  const situacoes = new Set(cobrancas.map((c) => c.situacao))
  const comum = situacoes.size === 1 ? cobrancas[0].situacao : "PARCIAL"

  return (
    <span className="flex items-center gap-1.5">
      <Badge
        variant={
          recebidas === cobrancas.length
            ? "default"
            : comum === "CANCELADO" || comum === "EXPIRADO"
              ? "destructive"
              : "secondary"
        }
        className="font-mono text-[10px]"
      >
        {comum}
      </Badge>
      {cobrancas.length > 1 ? (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {recebidas}/{cobrancas.length} pagas
        </span>
      ) : null}
    </span>
  )
}
