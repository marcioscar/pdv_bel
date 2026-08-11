import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"

const GRUPOS = [
  {
    titulo: "Lançar produtos",
    itens: [
      { tecla: "141 ⏎", texto: "adiciona 1 unidade do código 141" },
      { tecla: "3*141 ⏎", texto: "adiciona 3 unidades do código 141" },
      { tecla: "3*papel", texto: "busca “papel” e adiciona 3 do escolhido" },
      { tecla: "↑ ↓", texto: "navega os resultados da busca" },
      { tecla: "Esc", texto: "limpa a entrada / cancela o modo atual" },
    ],
  },
  {
    titulo: "Editar a venda",
    itens: [
      { tecla: "↑ ↓", texto: "com a busca vazia, move o item ativo" },
      { tecla: "+ −", texto: "ajusta a quantidade do item ativo" },
      { tecla: "F5", texto: "digita a quantidade exata" },
      { tecla: "F4 / Del", texto: "remove o item ativo" },
      { tecla: "F3", texto: "desconto em reais sobre o subtotal" },
      { tecla: "F6", texto: "vincula cliente (F7 cadastra um novo)" },
      { tecla: "F9", texto: "cancela a venda inteira" },
    ],
  },
  {
    titulo: "Fechar a venda",
    itens: [
      { tecla: "F8", texto: "alterna a forma de pagamento" },
      { tecla: "⇧F1 … ⇧F5", texto: "escolhe a forma direto" },
      { tecla: "⇧F5", texto: "a prazo — pede cliente e vencimento" },
      { tecla: "F10", texto: "abre o pagamento e conclui" },
      { tecla: "F2", texto: "volta o foco para a busca" },
    ],
  },
  {
    titulo: "Trocar de tela",
    itens: [
      { tecla: "Ctrl F1", texto: "Caixa" },
      { tecla: "Ctrl F2", texto: "Estoque — entrada e inventário" },
      { tecla: "Ctrl F3", texto: "Vendas — histórico e cancelamento" },
      { tecla: "Ctrl F6", texto: "alterna tema claro / escuro" },
    ],
  },
]

export function AjudaAtalhos({ onFechar }: { onFechar: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Atalhos do teclado"
      className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-8 backdrop-blur-sm"
      onClick={onFechar}
    >
      <div
        className="w-full max-w-5xl rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={(evento) => evento.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Atalhos do teclado</h2>
          <span className="text-xs text-muted-foreground">
            <Kbd>Esc</Kbd> ou <Kbd>F1</Kbd> para fechar
          </span>
        </div>

        <Separator className="my-4" />

        <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          {GRUPOS.map((grupo) => (
            <div key={grupo.titulo}>
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {grupo.titulo}
              </h3>
              <ul className="space-y-2.5">
                {grupo.itens.map((item) => (
                  <li key={item.tecla} className="flex items-start gap-2 text-xs">
                    <Kbd className="mt-px shrink-0 font-mono">{item.tecla}</Kbd>
                    <span className="text-muted-foreground">{item.texto}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
