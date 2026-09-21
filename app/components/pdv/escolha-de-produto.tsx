import { useEffect, useMemo, useRef, useState } from "react"
import { Search } from "lucide-react"

import { buscarProdutos, type EntradaIndice } from "~/lib/pdv"
import { cn } from "~/lib/utils"

export type ProdutoDoCatalogo = {
  id: string
  codigo: string
  descricao: string
  unidade: string
  /** O preço de venda de hoje. Opcional: nem toda tela que escolhe produto o carrega. */
  preco?: number
}

/**
 * Escolhe o produto do catálogo digitando, em vez de rolar mil opções.
 *
 * Era um `<select>`: com mais de mil produtos de nomes quase iguais ("SACO PEBD
 * SL ME 05x25x0.006"), achar o certo ali é garimpo — e a nota tem dezenas de
 * linhas para parear.
 *
 * A busca roda no cliente, sobre o catálogo que o loader já mandou: o índice é o
 * MESMO da barra de comando do caixa (`criarIndice`/`buscarProdutos`), então
 * procurar aqui e procurar no PDV acham as mesmas coisas com as mesmas palavras.
 */
export function EscolhaDeProduto({
  escolhido,
  destacados,
  rotuloDoDestaque = "do pedido",
  indice,
  onEscolher,
}: {
  escolhido: ProdutoDoCatalogo | null
  /**
   * Os produtos que vêm primeiro e aparecem sem digitar nada — os do pedido de
   * compra, em geral. Vazio quando não há pedido: aí só se acha digitando.
   */
  destacados: string[]
  rotuloDoDestaque?: string
  indice: EntradaIndice<ProdutoDoCatalogo>[]
  onEscolher: (produtoId: string) => void
}) {
  const [aberta, setAberta] = useState(false)
  const [termo, setTermo] = useState("")
  const caixa = useRef<HTMLDivElement>(null)
  const botao = useRef<HTMLButtonElement>(null)

  /**
   * Onde a lista aparece na tela, em coordenadas de viewport.
   *
   * A lista é `fixed`, e não `absolute`, porque as duas telas que usam isto
   * põem a tabela dentro de um `overflow-x-auto` (para a tabela larga poder
   * rolar de lado) — e um contêiner com overflow em um eixo recorta o outro
   * também. Posicionada dentro dele, a lista aparecia cortada logo abaixo do
   * campo de busca: parecia que procurar produto simplesmente não funcionava.
   *
   * `fixed` escapa do recorte, mas paga o preço de não acompanhar rolagem
   * sozinha — daí o reposicionamento abaixo.
   */
  const [posicao, setPosicao] = useState<{ topo: number; esquerda: number } | null>(null)

  const LARGURA = 320
  const ALTURA_ESTIMADA = 300

  function posicionar() {
    const retangulo = botao.current?.getBoundingClientRect()
    if (!retangulo) return
    // Abre para cima quando não cabe embaixo: na última linha da tabela, que é
    // justo onde se acrescenta item, embaixo quase nunca cabe.
    const cabeEmbaixo = window.innerHeight - retangulo.bottom > ALTURA_ESTIMADA
    setPosicao({
      topo: cabeEmbaixo ? retangulo.bottom + 4 : Math.max(8, retangulo.top - ALTURA_ESTIMADA - 4),
      // Sem deixar sair pela direita da janela.
      esquerda: Math.min(retangulo.left, window.innerWidth - LARGURA - 8),
    })
  }

  const idsDoPedido = useMemo(() => new Set(destacados), [destacados])

  /**
   * Sem termo, só os itens do PEDIDO — é o pareamento esperado na maioria das
   * linhas. Despejar o catálogo inteiro aqui devolveria ao problema do
   * `<select>`: mil linhas para rolar antes de digitar qualquer coisa.
   *
   * Com termo, o catálogo todo, mas com os do pedido na frente: quando o nome
   * casa nos dois, o que foi comprado é quase sempre o certo.
   */
  const achados = useMemo(() => {
    if (!termo.trim()) {
      return indice
        .filter((e) => idsDoPedido.has(e.produto.id))
        .map((e) => e.produto)
        .slice(0, 12)
    }
    return buscarProdutos(indice, termo, 12).sort(
      (a, b) => Number(idsDoPedido.has(b.id)) - Number(idsDoPedido.has(a.id))
    )
  }, [termo, indice, idsDoPedido])

  // Clicar fora fecha; sem isso a lista fica sobre as linhas de baixo.
  //
  // A rolagem reposiciona em vez de fechar: quem rola a página com a lista
  // aberta está procurando, não desistindo. `capture` porque quem rola pode ser
  // o contêiner da tabela, e evento de rolagem de elemento não borbulha.
  useEffect(() => {
    if (!aberta) return
    function aoClicar(evento: MouseEvent) {
      if (!caixa.current?.contains(evento.target as Node)) setAberta(false)
    }
    function aoMover() {
      posicionar()
    }
    document.addEventListener("mousedown", aoClicar)
    window.addEventListener("scroll", aoMover, true)
    window.addEventListener("resize", aoMover)
    return () => {
      document.removeEventListener("mousedown", aoClicar)
      window.removeEventListener("scroll", aoMover, true)
      window.removeEventListener("resize", aoMover)
    }
  }, [aberta])

  return (
    <div ref={caixa} className="relative">
      <button
        ref={botao}
        type="button"
        onClick={() => {
          setTermo("")
          posicionar()
          setAberta((v) => !v)
        }}
        className={cn(
          "flex h-7 w-56 items-center gap-1 rounded border bg-background px-1.5 text-left text-xs",
          escolhido ? "border-border" : "border-destructive/50 text-destructive"
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {escolhido ? `${escolhido.codigo} — ${escolhido.descricao}` : "Escolher…"}
        </span>
        <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {aberta && posicao ? (
        <div
          style={{ top: posicao.topo, left: posicao.esquerda, width: LARGURA }}
          className="fixed z-50 rounded-lg border border-border bg-popover shadow-lg"
        >
          <input
            autoFocus
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAberta(false)
              // Um resultado só e Enter escolhe: é o caso de quem digitou o
              // código exato e não quer tirar a mão do teclado.
              if (e.key === "Enter" && achados.length === 1) {
                onEscolher(achados[0].id)
                setAberta(false)
              }
            }}
            placeholder="código ou descrição…"
            className="h-8 w-full border-b border-border bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          <ul className="max-h-60 overflow-y-auto py-1">
            {achados.length === 0 ? (
              <li className="px-2.5 py-2 text-[11px] text-muted-foreground">
                {termo.trim()
                  ? "Nada com esse termo."
                  : "Digite para procurar no catálogo."}
              </li>
            ) : (
              achados.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onEscolher(p.id)
                      setAberta(false)
                    }}
                    className={cn(
                      "flex w-full items-baseline gap-1.5 px-2.5 py-1 text-left text-xs hover:bg-accent",
                      escolhido?.id === p.id && "bg-accent"
                    )}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {p.codigo}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{p.descricao}</span>
                    {idsDoPedido.has(p.id) ? (
                      <span className="shrink-0 rounded bg-primary/10 px-1 text-[9px] text-primary">
                        {rotuloDoDestaque}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
