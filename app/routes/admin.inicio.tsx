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
import { Campo, ESTILO_CAMPO } from "~/components/pdv/filtros"
import { depoisDoDia, diaAtras, diaDeHoje, diaEmTexto, emDia, inicioDoDia } from "~/lib/dia"
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

const DIA = /^\d{4}-\d{2}-\d{2}$/
/** Um ano e um dia: o gráfico diário desenha uma barra por dia do período. */
const MAIOR_PERIODO = 366

/**
 * Os períodos prontos, calculados no servidor para a tela e o loader
 * concordarem sobre qual está escolhido. "30 dias" abre: é o mês de trabalho.
 */
function atalhos() {
  const hoje = new Date()
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1)
  const fimMesPassado = new Date(hoje.getFullYear(), hoje.getMonth(), 0)
  const inicioMesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)
  return [
    { rotulo: "Hoje", de: diaDeHoje(), ate: diaDeHoje() },
    { rotulo: "Ontem", de: diaAtras(1), ate: diaAtras(1) },
    { rotulo: "7 dias", de: diaAtras(6), ate: diaDeHoje() },
    { rotulo: "30 dias", de: diaAtras(29), ate: diaDeHoje() },
    { rotulo: "90 dias", de: diaAtras(89), ate: diaDeHoje() },
    { rotulo: "Este mês", de: emDia(inicioMes), ate: diaDeHoje() },
    { rotulo: "Mês passado", de: emDia(inicioMesPassado), ate: emDia(fimMesPassado) },
  ]
}

/** Quantos dias o período cobre, contando as duas pontas. */
function diasNoPeriodo(de: string, ate: string) {
  return Math.round((depoisDoDia(ate).getTime() - inicioDoDia(de).getTime()) / 86_400_000)
}

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

  /*
   * O período vive na URL (`de` e `ate`), como nas outras telas de escritório:
   * dá para recarregar e mandar o link. Faltando uma ponta, vale a outra — um
   * dia só. Invertido, desinverte. Sem nada, os últimos 30 dias.
   */
  const url = new URL(request.url)
  const deBruto = url.searchParams.get("de") ?? ""
  const ateBruto = url.searchParams.get("ate") ?? ""
  const temDe = DIA.test(deBruto)
  const temAte = DIA.test(ateBruto)
  let de = temDe ? deBruto : temAte ? ateBruto : diaAtras(29)
  let ate = temAte ? ateBruto : temDe ? deBruto : diaDeHoje()
  if (ate < de) [de, ate] = [ate, de]
  // Mais de um ano vira um gráfico ilegível e uma consulta pesada: o período
  // é encurtado a partir do fim, e a tela diz que foi.
  let encurtado = false
  if (diasNoPeriodo(de, ate) > MAIOR_PERIODO) {
    const inicio = inicioDoDia(ate)
    inicio.setDate(inicio.getDate() - (MAIOR_PERIODO - 1))
    de = emDia(inicio)
    encurtado = true
  }
  const periodo = { de, ate }

  /*
   * A ordem das lojas vem do cadastro (matriz, filial, depois as outras), e é
   * ela que fixa a cor de cada uma. Ordenar por faturamento faria a cor seguir
   * o ranking — e a mesma loja mudaria de cor de um mês para o outro.
   */
  const todas = await listarLojas()
  const lojas = todas.map((l) => l.codigo).filter((c) => eu.lojasPermitidas.includes(c))

  const [resumo, diario, abc, rankings] = await Promise.all([
    resumoDoMes(lojas),
    faturamentoDiario(periodo, lojas),
    curvaAbc(10),
    rankingsDoPdv(periodo, lojas),
  ])

  return { eu, periodo, encurtado, atalhos: atalhos(), lojas, resumo, diario, abc, rankings }
}

export default function AdminInicio({ loaderData }: Route.ComponentProps) {
  const { eu, periodo, encurtado, atalhos, lojas, resumo, diario, abc, rankings } = loaderData
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

  /** "03/11/2026", ou "01/11/2026 a 03/11/2026" — o que os cartões repetem. */
  const textoPeriodo =
    periodo.de === periodo.ate
      ? diaEmTexto(periodo.de)
      : `${diaEmTexto(periodo.de)} a ${diaEmTexto(periodo.ate)}`
  const atalhoAtivo = atalhos.find((a) => a.de === periodo.de && a.ate === periodo.ate)

  function mudarPeriodo(mudanca: { de?: string; ate?: string }) {
    const novos = new URLSearchParams(params)
    novos.delete("dias")
    const de = mudanca.de ?? periodo.de
    const ate = mudanca.ate ?? periodo.ate
    if (!de || !ate) return
    novos.set("de", de)
    novos.set("ate", ate)
    setParams(novos, { preventScrollReset: true })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <TrendingUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Painel</h1>
        <span className="text-xs text-muted-foreground">
          {lojas.length === 1 ? `loja ${lojas[0]}` : `${lojas.length} lojas`} · só as vendas
          registradas neste PDV
        </span>

        <div className="ml-auto flex flex-wrap items-end gap-2">
          <Campo rotulo="De">
            <input
              type="date"
              value={periodo.de}
              max={periodo.ate}
              onChange={(e) => mudarPeriodo({ de: e.target.value })}
              className={ESTILO_CAMPO}
            />
          </Campo>
          <Campo rotulo="Até">
            <input
              type="date"
              value={periodo.ate}
              min={periodo.de}
              onChange={(e) => mudarPeriodo({ ate: e.target.value })}
              className={ESTILO_CAMPO}
            />
          </Campo>
          <div className="flex flex-wrap gap-1">
            {atalhos.map((a) => (
              <Button
                key={a.rotulo}
                type="button"
                size="sm"
                variant={atalhoAtivo?.rotulo === a.rotulo ? "default" : "outline"}
                onClick={() => mudarPeriodo({ de: a.de, ate: a.ate })}
                className="rounded-lg"
              >
                {a.rotulo}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {encurtado ? (
        <p className="border-b border-border bg-amber-500/5 px-5 py-1.5 text-xs text-amber-700 dark:text-amber-500">
          O painel mostra no máximo {MAIOR_PERIODO} dias — o período começa em{" "}
          {diaEmTexto(periodo.de)}.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* ---- Os números do mês ---- */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Ficha
            rotulo="Faturamento do mês"
            valor={moeda(resumo.faturamento)}
            apoio={`${resumo.diaDoMes} ${resumo.diaDoMes === 1 ? "dia" : "dias"} corridos · ${resumo.vendas} ${resumo.vendas === 1 ? "venda" : "vendas"}`}
          />
          <Ficha
            rotulo="Ritmo por dia"
            valor={moeda(resumo.porDia)}
            apoio={`mês anterior fez ${moeda(resumo.porDiaAnterior)}/dia`}
            variacao={resumo.variacao}
          />
          <Ficha
            rotulo="Ticket médio do mês"
            valor={moeda(resumo.ticketMedio)}
            apoio="faturamento ÷ vendas do PDV"
          />
          <Ficha
            rotulo="Faturamento no período"
            valor={moeda(totalPeriodo)}
            apoio={`${textoPeriodo} · ${porLojaNoPeriodo[0]?.loja ?? "—"} lidera com ${moeda(porLojaNoPeriodo[0]?.total ?? 0)}`}
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[2fr_1fr]">
          {/* ---- Série diária ---- */}
          <Cartao
            titulo="Faturamento por dia"
            apoio={`${textoPeriodo} · a altura é o grupo; as faixas são as lojas`}
          >
            <GraficoDiario pontos={diario} lojas={lojas} config={configLojas} />
          </Cartao>

          {/* ---- Comparação entre lojas ---- */}
          <Cartao titulo="Por loja" apoio={textoPeriodo}>
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
            titulo="Curva ABC — os 10 maiores por valor · sistema antigo"
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
              A única parte do painel que não vem do PDV — e por isso diz de onde
              vem e de quando é, para ninguém ler como série viva.
            */}
            <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
              <b className="font-medium text-foreground">
                Esta curva não vem do PDV: é do histórico do sistema antigo
              </b>{" "}
              — {abc.diasAnalisados} dias, calculado em{" "}
              {new Date(abc.calculadoEm).toLocaleDateString("pt-BR")}. Fica aqui por
              enquanto, até o PDV ter vendas que bastem. Não muda sozinha, e o valor é
              estimativa: quantidade vendida × preço de hoje. Não muda com o período
              escolhido acima.
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
          <Cartao titulo="Por vendedor" apoio={`vendas do PDV, ${textoPeriodo}`}>
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

          <Cartao titulo="Maiores clientes" apoio={`vendas do PDV, ${textoPeriodo}`}>
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
          Tudo aqui vem das vendas registradas <b>neste PDV</b> — sem cancelada e sem
          transferência entre lojas —, menos a curva ABC, que por enquanto é do sistema
          antigo. Enquanto o caixa novo não estiver em todas as lojas,
          os números são só do que passou por ele.{" "}
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
