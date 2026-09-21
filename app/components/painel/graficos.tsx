import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart"
import { CONFIG_VALOR, CORES_ABC } from "~/components/painel/paleta"
import { moeda } from "~/lib/moeda"

/**
 * Os gráficos do painel, sobre o componente de chart do shadcn (Recharts).
 *
 * A cor vem do `ChartConfig`, com um par claro/escuro por série — o próprio
 * componente injeta a variável certa por tema, então nenhum gráfico aqui
 * precisa saber qual tema está ativo.
 */

export type PontoDiario = { dia: string; porLoja: Record<string, number>; total: number }

/** "2026-09-21" -> "21/09". O ano não cabe e não ajuda num eixo de 30 dias. */
function diaCurto(dia: string) {
  const [, m, d] = dia.split("-")
  return `${d}/${m}`
}

/**
 * Faturamento dia a dia, empilhado por loja.
 *
 * Barra empilhada, e não quatro linhas sobrepostas, por causa do formato do
 * dado: as receitas são lançadas em lote, não venda a venda, então a série real
 * pula de R$ 3 mil para R$ 46 mil de um dia para o outro. Quatro linhas assim
 * viram um novelo. Empilhada, a altura responde "quanto a rede fez no dia" e as
 * faixas respondem "de quem foi" — que são as duas perguntas do painel.
 *
 * Dia sem lançamento aparece como coluna vazia, e não é omitido: pular o dia
 * faria dois pontos vizinhos no desenho estarem a uma semana um do outro.
 */
export function GraficoDiario({
  pontos,
  lojas,
  config,
}: {
  pontos: PontoDiario[]
  lojas: string[]
  config: ChartConfig
}) {
  const dados = pontos.map((p) => ({ dia: diaCurto(p.dia), ...p.porLoja }))

  return (
    <ChartContainer config={config} className="h-56 w-full">
      <BarChart data={dados} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        {/* Só as horizontais: as verticais não ajudam a ler altura. */}
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="dia"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          className="text-[10px]"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
          className="text-[10px]"
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => `Dia ${v}`}
              formatter={(valor, nome) => (
                <div className="flex w-full items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: `var(--color-${nome})` }}
                  />
                  <span className="text-muted-foreground">{nome}</span>
                  <span className="ml-auto font-mono tabular-nums">
                    {moeda(Number(valor))}
                  </span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {lojas.map((loja, i) => (
          <Bar
            isAnimationActive={false}
            key={loja}
            dataKey={loja}
            stackId="dia"
            fill={`var(--color-${loja})`}
            // Canto arredondado só no topo da pilha — a ponta do dado.
            radius={i === lojas.length - 1 ? [3, 3, 0, 0] : 0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

export type LinhaAbc = {
  produtoId: string
  codigo: string
  descricao: string
  quantidade: number
  valor: number
  participacao: number
  acumulado: number
  faixa: "A" | "B" | "C"
}

/**
 * A curva ABC dos dez maiores, por valor.
 *
 * Barras horizontais, e não o Pareto clássico de barras com a linha de
 * acumulado por cima. O Pareto clássico precisa de DOIS eixos y — reais à
 * esquerda, percentual à direita — e dois eixos no mesmo desenho é a maneira
 * mais comum de um gráfico mentir: a altura em que as duas escalas se cruzam é
 * escolha de quem desenha, e ela muda a história que o desenho conta.
 *
 * O acumulado vai como texto na tabela ao lado. Perde-se a curva bonita e
 * ganha-se um número que não depende de onde alguém pôs a segunda escala.
 *
 * A cor é a faixa A/B/C: um tom só, do escuro ao claro, porque é magnitude
 * ordenada e não identidade. E a faixa vem escrita ao lado — cor sozinha nunca
 * carrega o significado.
 */
/**
 * O valor da ponta da barra, curto o bastante para caber ao lado dela.
 *
 * Tem três faixas porque um "k" arredondado só serve nos milhares grandes: na
 * faixa C toda linha vale entre mil e dois mil, e `Math.round(v / 1000)`
 * escrevia "1k" em todas as dez — dez barras de tamanhos visivelmente
 * diferentes com o mesmo número ao lado.
 */
function emMilhares(valor: number) {
  if (valor >= 10_000) return `${Math.round(valor / 1000)}k`
  if (valor >= 1_000) return `${(valor / 1000).toFixed(1).replace(".", ",")}k`
  return String(Math.round(valor))
}

/**
 * O rótulo de cada barra da ABC: descrição em cima, código embaixo.
 *
 * Duas linhas porque é o código que se digita no caixa e se procura no
 * fornecedor — ele precisa estar ali, mas não pode competir com o nome pelo
 * primeiro olhar. Por isso sai menor, em monoespaçada e apagado.
 *
 * As props `x`, `y` e `payload` são injetadas pelo Recharts quando clona o
 * elemento; só `codigos` vem de quem monta o gráfico.
 */
function TickDoProduto({
  x,
  y,
  payload,
  codigos,
}: {
  x?: number
  y?: number
  payload?: { value?: string }
  codigos: Map<string, string>
}) {
  const nome = payload?.value ?? ""
  const codigo = codigos.get(nome)

  return (
    <text x={x} y={y} textAnchor="end">
      <tspan x={x} dy={-2} className="fill-foreground text-[10px]">
        {nome}
      </tspan>
      {codigo ? (
        <tspan x={x} dy={11} className="fill-muted-foreground font-mono text-[9px]">
          {codigo}
        </tspan>
      ) : null}
    </text>
  )
}

export function GraficoAbc({ linhas }: { linhas: LinhaAbc[] }) {
  const config = {
    valor: { label: "Valor" },
    A: { label: "Faixa A", theme: CORES_ABC.A },
    B: { label: "Faixa B", theme: CORES_ABC.B },
    C: { label: "Faixa C", theme: CORES_ABC.C },
  } satisfies ChartConfig

  const dados = linhas.map((l) => ({
    nome: l.descricao.length > 30 ? `${l.descricao.slice(0, 29)}…` : l.descricao,
    codigo: l.codigo,
    valor: l.valor,
    faixa: l.faixa,
    participacao: l.participacao,
    acumulado: l.acumulado,
  }))

  /*
   * O eixo do Recharts recebe só o valor da categoria, que aqui é a descrição.
   * O código vem por fora, por este mapa — e não colado na descrição, que
   * viraria "8298 Alcool Liquido 1 L…" numa linha só e gastaria com o código o
   * espaço que falta para o nome.
   */
  const codigoPorNome = new Map(dados.map((d) => [d.nome, d.codigo]))

  return (
    <ChartContainer config={config} className="h-[22rem] w-full">
      <BarChart
        data={dados}
        layout="vertical"
        margin={{ top: 0, right: 56, left: 4, bottom: 0 }}
      >
        <CartesianGrid horizontal={false} strokeDasharray="2 4" />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="nome"
          tickLine={false}
          axisLine={false}
          width={200}
          tick={<TickDoProduto codigos={codigoPorNome} />}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideIndicator
              formatter={(valor, _n, item) => (
                <div className="space-y-0.5">
                  <div className="font-mono font-medium tabular-nums">
                    {moeda(Number(valor))}
                  </div>
                  <div className="text-muted-foreground tabular-nums">
                    faixa {item.payload.faixa} · {item.payload.participacao.toFixed(1)}% do
                    total · acumulado {item.payload.acumulado.toFixed(0)}%
                  </div>
                </div>
              )}
            />
          }
        />
        <Bar dataKey="valor" radius={[0, 3, 3, 0]} barSize={14} isAnimationActive={false}>
          {dados.map((d) => (
            <Cell key={d.nome} fill={`var(--color-${d.faixa})`} />
          ))}
          {/* Rótulo direto na ponta: quem lê a barra não precisa ir ao eixo. */}
          <LabelList
            dataKey="valor"
            position="right"
            offset={6}
            className="fill-muted-foreground text-[10px] tabular-nums"
            formatter={(v) => emMilhares(Number(v))}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

/**
 * Uma comparação simples de magnitude — lojas, vendedores, clientes.
 *
 * A altura acompanha o número de linhas em vez de ser fixa: com uma linha só,
 * uma caixa de 200px deixa a barra flutuando no meio de um vazio que parece
 * defeito. `config` é opcional e serve às lojas, que têm cor própria — a mesma
 * loja precisa ter a mesma cor nos dois gráficos da tela, senão a cor deixa de
 * significar quem é e passa a significar em qual gráfico se está olhando.
 */
export function GraficoRanking({
  linhas,
  config,
  corPorNome,
}: {
  linhas: { nome: string; valor: number; apoio?: string }[]
  config?: ChartConfig
  /** Quando dado, cada barra usa a cor da sua entidade em vez do azul único. */
  corPorNome?: boolean
}) {
  const altura = Math.max(linhas.length * 34 + 24, 88)

  return (
    <ChartContainer
      config={config ?? CONFIG_VALOR}
      className="w-full"
      style={{ height: altura }}
    >
      <BarChart
        data={linhas}
        layout="vertical"
        margin={{ top: 0, right: 56, left: 4, bottom: 0 }}
      >
        <CartesianGrid horizontal={false} strokeDasharray="2 4" />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="nome"
          tickLine={false}
          axisLine={false}
          width={132}
          className="text-[10px]"
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideIndicator
              formatter={(valor, _n, item) => (
                <div className="space-y-0.5">
                  <div className="font-mono font-medium tabular-nums">
                    {moeda(Number(valor))}
                  </div>
                  {item.payload.apoio ? (
                    <div className="text-muted-foreground">{item.payload.apoio}</div>
                  ) : null}
                </div>
              )}
            />
          }
        />
        <Bar
          dataKey="valor"
          fill="var(--color-valor)"
          radius={[0, 3, 3, 0]}
          barSize={14}
          isAnimationActive={false}
        >
          {corPorNome
            ? linhas.map((l) => <Cell key={l.nome} fill={`var(--color-${l.nome})`} />)
            : null}
          <LabelList
            dataKey="valor"
            position="right"
            offset={6}
            className="fill-muted-foreground text-[10px] tabular-nums"
            formatter={(v) =>
              Number(v) >= 1000 ? `${Math.round(Number(v) / 1000)}k` : moeda(Number(v))
            }
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

/**
 * A mesma curva em números — o caminho de quem não lê a cor, e o lugar onde o
 * acumulado aparece por extenso em vez de virar um segundo eixo no desenho.
 */
export function TabelaAbc({ linhas }: { linhas: LinhaAbc[] }) {
  return (
    <div className="max-h-[22rem] overflow-y-auto">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="py-1 pr-2 font-semibold">Produto</th>
            <th className="py-1 pr-2 text-right font-semibold">Valor</th>
            <th className="py-1 pr-2 text-right font-semibold">Part.</th>
            <th className="py-1 pr-2 text-right font-semibold">Acum.</th>
            <th className="py-1 text-right font-semibold">Faixa</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {linhas.map((l) => (
            <tr key={l.produtoId}>
              <td className="py-1 pr-2">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {l.codigo}
                </span>{" "}
                {l.descricao}
              </td>
              <td className="py-1 pr-2 text-right font-medium">{moeda(l.valor)}</td>
              <td className="py-1 pr-2 text-right text-muted-foreground">
                {l.participacao.toFixed(1)}%
              </td>
              <td className="py-1 pr-2 text-right text-muted-foreground">
                {l.acumulado.toFixed(0)}%
              </td>
              <td className="py-1 text-right font-semibold">{l.faixa}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
