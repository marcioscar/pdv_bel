import { useEffect, useState } from "react"
import { Link, redirect, useSearchParams } from "react-router"
import { ArrowDownRight, ArrowUpRight, Table2, TrendingUp } from "lucide-react"

import type { Route } from "./+types/admin.inicio"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  GraficoAbc,
  GraficoDiario,
  GraficoRanking,
  TabelaAbc,
} from "~/components/painel/graficos"
import { configDasLojas } from "~/components/painel/paleta"
import { listarLojas } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { ehGerente, secoesAdminDoPapel } from "~/lib/permissoes"
import {
  curvaAbc,
  faturamentoDiario,
  rankingsDoPdv,
  resumoDoMes,
} from "~/lib/painel.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Painel — BrasSaco" }]
}

/** Períodos que o painel oferece. 30 dias abre: é o mês de trabalho. */
const PERIODOS = [
  { dias: 7, rotulo: "7 dias" },
  { dias: 30, rotulo: "30 dias" },
  { dias: 90, rotulo: "90 dias" },
] as const

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  /*
   * O painel é faturamento da rede: coisa de gerente. Mas "Adm" na barra aponta
   * para cá também para o operador, que tem Clientes e Entradas no escritório —
   * então ele é levado para a primeira tela dele, em vez de dar com um 403 ao
   * clicar num botão que a barra lhe oferece. Antes das consultas: o layout
   * cobra permissão, mas os loaders filhos rodam em paralelo com o dele.
   */
  if (!ehGerente(eu.papel)) {
    throw redirect(secoesAdminDoPapel(eu.papel)[0]?.para ?? "/")
  }

  const pedido = Number(new URL(request.url).searchParams.get("dias"))
  const dias = PERIODOS.some((p) => p.dias === pedido) ? pedido : 30

  /*
   * A ordem das lojas vem do cadastro (matriz, filial, depois as outras), e é
   * ela que fixa a cor de cada uma. Ordenar por faturamento faria a cor seguir
   * o ranking — e a mesma loja mudaria de cor de um mês para o outro.
   */
  const todas = await listarLojas()
  const lojas = todas.map((l) => l.codigo).filter((c) => eu.lojasPermitidas.includes(c))

  const [resumo, diario, abc, rankings] = await Promise.all([
    resumoDoMes(lojas),
    faturamentoDiario(dias, lojas),
    curvaAbc(10),
    rankingsDoPdv(dias, lojas),
  ])

  return { eu, dias, lojas, resumo, diario, abc, rankings }
}

export default function AdminInicio({ loaderData }: Route.ComponentProps) {
  const { eu, dias, lojas, resumo, diario, abc, rankings } = loaderData
  const [params, setParams] = useSearchParams()
  const [tabelaAbc, setTabelaAbc] = useState(false)

  /*
   * Uma cor por loja, com o par claro/escuro dentro. O componente de chart
   * injeta a variável certa por tema, então nenhum gráfico precisa saber qual
   * tema está ativo — e os passos do escuro são outros, não os claros
   * invertidos.
   */
  const configLojas = configDasLojas(lojas)

  const totalPeriodo = diario.reduce((s, p) => s + p.total, 0)
  const porLojaNoPeriodo = lojas
    .map((loja) => ({
      loja,
      total: diario.reduce((s, p) => s + (p.porLoja[loja] ?? 0), 0),
    }))
    .sort((a, b) => b.total - a.total)
  const maiorLoja = Math.max(...porLojaNoPeriodo.map((l) => l.total), 1)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <TrendingUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Painel</h1>
        <span className="text-xs text-muted-foreground">
          {lojas.length === 1 ? `loja ${lojas[0]}` : `${lojas.length} lojas`} · faturamento
          da rede, do sistema de contas
        </span>

        <div className="ml-auto flex gap-1">
          {PERIODOS.map((p) => (
            <Button
              key={p.dias}
              type="button"
              size="xs"
              variant={dias === p.dias ? "default" : "outline"}
              onClick={() => {
                const novos = new URLSearchParams(params)
                novos.set("dias", String(p.dias))
                setParams(novos, { preventScrollReset: true })
              }}
              className="rounded-lg"
            >
              {p.rotulo}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* ---- Os números do mês ---- */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Ficha
            rotulo="Faturamento do mês"
            valor={moeda(resumo.faturamento)}
            apoio={`${resumo.diaDoMes} ${resumo.diaDoMes === 1 ? "dia" : "dias"} corridos · ${resumo.lancamentos} lançamentos`}
          />
          <Ficha
            rotulo="Ritmo por dia"
            valor={moeda(resumo.porDia)}
            apoio={`mês anterior fez ${moeda(resumo.porDiaAnterior)}/dia`}
            variacao={resumo.variacao}
          />
          <Ficha
            rotulo="Margem da operação"
            valor={`${resumo.margem.toFixed(1)}%`}
            apoio={`depois de ${resumo.pctFixas.toFixed(1)}% fixas e ${resumo.pctVariaveis.toFixed(1)}% variáveis`}
          />
          <Ficha
            rotulo={`Faturamento em ${dias} dias`}
            valor={moeda(totalPeriodo)}
            apoio={`${porLojaNoPeriodo[0]?.loja ?? "—"} lidera com ${moeda(porLojaNoPeriodo[0]?.total ?? 0)}`}
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[2fr_1fr]">
          {/* ---- Série diária ---- */}
          <Cartao
            titulo="Faturamento por dia"
            apoio="a altura é o grupo; as faixas são as lojas"
          >
            <GraficoDiario pontos={diario} lojas={lojas} config={configLojas} />
          </Cartao>

          {/* ---- Comparação entre lojas ---- */}
          <Cartao titulo="Por loja" apoio={`no período de ${dias} dias`}>
            <GraficoRanking
              config={configLojas}
              corPorNome
              linhas={porLojaNoPeriodo.map((l) => ({
                nome: l.loja,
                valor: l.total,
                apoio: `${totalPeriodo > 0 ? ((l.total / totalPeriodo) * 100).toFixed(1) : "0"}% do grupo`,
              }))}
            />
          </Cartao>
        </div>

        {/* ---- Curva ABC ---- */}
        {abc ? (
          <Cartao
            className="mt-4"
            titulo="Curva ABC — os 10 maiores por valor"
            apoio={`${abc.faixas.A.produtos} produtos fazem 80% do valor · ${abc.produtos} no total`}
            acao={
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setTabelaAbc((v) => !v)}
                className="rounded-lg"
              >
                <Table2 className="size-3.5" />
                {tabelaAbc ? "Ver gráfico" : "Ver tabela"}
              </Button>
            }
          >
            {tabelaAbc ? (
              <TabelaAbc linhas={abc.linhas} />
            ) : (
              <GraficoAbc linhas={abc.linhas} />
            )}

            {/*
              De onde vem e de quando é. Sem isto o painel passaria a impressão
              de série viva, e alguém tomaria decisão de compra em cima de um
              retrato de meses atrás sem saber.
            */}
            <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
              Retrato do histórico de vendas do sistema antigo —{" "}
              {abc.diasAnalisados} dias, calculado em{" "}
              {new Date(abc.calculadoEm).toLocaleDateString("pt-BR")}. Não muda sozinho:
              só quando a política de compra é recalculada. O valor é estimativa —
              quantidade vendida × preço de hoje, porque o preço praticado então não
              foi guardado.
              {abc.foraPorGrupo > 0 ? (
                <>
                  {" "}
                  Fora da conta: {abc.foraPorGrupo} produto
                  {abc.foraPorGrupo === 1 ? "" : "s"} de grupo que não é mercadoria de
                  prateleira — encomenda não volta a vender, e na curva empurraria para
                  a faixa A um item que ninguém vai recomprar.
                </>
              ) : null}
            </p>
          </Cartao>
        ) : null}

        {/* ---- Vendedor e cliente, do PDV ---- */}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Cartao titulo="Por vendedor" apoio={`vendas do PDV, ${dias} dias`}>
            {rankings.vendedores.length === 0 ? (
              <Vazio>Nenhuma venda com vendedor informado neste período.</Vazio>
            ) : (
              <GraficoRanking
                linhas={rankings.vendedores.map((v) => ({
                  nome: v.nome,
                  valor: v.total,
                  apoio: `${v.vendas} ${v.vendas === 1 ? "venda" : "vendas"}`,
                }))}
              />
            )}
            {rankings.semVendedor > 0 ? (
              <Rodape>
                {rankings.semVendedor} de {rankings.vendasConsideradas}{" "}
                {rankings.vendasConsideradas === 1 ? "venda" : "vendas"} sem vendedor — fora
                do ranking.
              </Rodape>
            ) : null}
          </Cartao>

          <Cartao titulo="Maiores clientes" apoio={`vendas do PDV, ${dias} dias`}>
            {rankings.clientes.length === 0 ? (
              <Vazio>Nenhuma venda com cliente vinculado neste período.</Vazio>
            ) : (
              <GraficoRanking
                linhas={rankings.clientes.map((c) => ({
                  nome: c.nome.length > 24 ? `${c.nome.slice(0, 23)}…` : c.nome,
                  valor: c.total,
                  apoio: `${c.vendas} ${c.vendas === 1 ? "compra" : "compras"}`,
                }))}
              />
            )}
            <Rodape>
              Consumidor final sem cadastro fica de fora — seria sempre a primeira linha,
              dizendo nada.
              {rankings.semCliente > 0
                ? ` São ${rankings.semCliente} de ${rankings.vendasConsideradas} aqui.`
                : ""}
            </Rodape>
          </Cartao>
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Faturamento e margem vêm de <b>receitas e despesas</b>, o sistema de contas que a
          rede alimenta — são os números do negócio inteiro. Vendedor e clientes vêm das
          vendas registradas <b>neste PDV</b>, que entrou em produção há pouco: enchem
          conforme ele chega às lojas.{" "}
          <Link to="/admin/relatorios/comissao" className="underline underline-offset-2">
            Comissão
          </Link>{" "}
          fecha o que cada um tem a receber.
        </p>
      </div>
    </div>
  )
}

/** Um número grande com o que ele significa embaixo. */
function Ficha({
  rotulo,
  valor,
  apoio,
  variacao,
}: {
  rotulo: string
  valor: string
  apoio: string
  variacao?: number | null
}) {
  const subiu = variacao != null && variacao > 0
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-2xl font-bold tracking-tight tabular-nums">
          {valor}
        </span>
        {/* A variação leva ícone e sinal junto da cor: cor sozinha não informa. */}
        {variacao != null ? (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium tabular-nums",
              subiu ? "text-[#006300] dark:text-[#0ca30c]" : "text-destructive"
            )}
          >
            {subiu ? (
              <ArrowUpRight className="size-3.5" aria-hidden />
            ) : (
              <ArrowDownRight className="size-3.5" aria-hidden />
            )}
            {subiu ? "+" : ""}
            {variacao.toFixed(1)}%
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{apoio}</div>
    </div>
  )
}

function Cartao({
  titulo,
  apoio,
  acao,
  className,
  children,
}: {
  titulo: string
  apoio?: string
  acao?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{titulo}</h2>
        {apoio ? <span className="text-[11px] text-muted-foreground">{apoio}</span> : null}
        {acao ? <div className="ml-auto">{acao}</div> : null}
      </div>
      {children}
    </section>
  )
}

function Vazio({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-xs text-muted-foreground">{children}</p>
}

function Rodape({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}
