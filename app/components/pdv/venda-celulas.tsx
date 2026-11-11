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
  forma,
}: {
  cobrancas: {
    parcela: number
    parcelas: number
    situacao: string
    tipo?: string | null
    recebidoEm?: Date | string | null
  }[]
  /** A forma da venda: só para dizer "sem Pix" em vez de "sem boleto". */
  forma?: string
}) {
  if (cobrancas.length === 0) {
    return (
      <span className="text-xs text-destructive">
        {forma === "entrega" ? "sem Pix" : "sem boleto"}
      </span>
    )
  }

  // Pix da entrega: uma cobrança só, e a pergunta do vendedor é "o cliente já
  // pagou?" — que o código cru do Inter ("A_RECEBER") não responde de relance.
  if (cobrancas.length === 1 && cobrancas[0].tipo === "pix") {
    return <SituacaoDoPix cobranca={cobrancas[0]} />
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

const ROTULO_DO_PIX: Record<string, string> = {
  A_RECEBER: "Pix a receber",
  ATRASADO: "Pix atrasado",
  RECEBIDO: "Pix pago",
  EM_PROCESSAMENTO: "Emitindo Pix",
  CANCELADO: "Pix cancelado",
  EXPIRADO: "Pix expirado",
}

/**
 * O Pix da entrega em palavras, e com a hora em que o cliente pagou.
 *
 * Verde pago, âmbar esperando, vermelho o que deu errado — as mesmas cores do
 * aviso do topo, para quem vê as duas coisas entender que falam do mesmo Pix.
 * A hora só existe nos Pix vistos pagos depois que o sistema passou a guardá-la;
 * nos de antes aparece só "Pix pago".
 */
function SituacaoDoPix({
  cobranca,
}: {
  cobranca: { situacao: string; recebidoEm?: Date | string | null }
}) {
  const pago = cobranca.situacao === "RECEBIDO"
  const ruim = ["ATRASADO", "CANCELADO", "EXPIRADO"].includes(cobranca.situacao)

  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge
        variant="outline"
        className={
          pago
            ? "border-emerald-400 bg-emerald-100 text-[10px] text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/20 dark:text-emerald-200"
            : ruim
              ? "border-destructive/50 bg-destructive/10 text-[10px] text-destructive"
              : "border-amber-400 bg-amber-100 text-[10px] text-amber-950 dark:border-amber-500/50 dark:bg-amber-500/20 dark:text-amber-200"
        }
      >
        {ROTULO_DO_PIX[cobranca.situacao] ?? cobranca.situacao}
      </Badge>
      {pago && cobranca.recebidoEm ? (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {new Date(cobranca.recebidoEm).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      ) : null}
    </span>
  )
}
