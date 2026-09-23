import { useSearchParams } from "react-router"
import { ShieldAlert } from "lucide-react"

import type { Route } from "./+types/admin.relatorios.auditoria"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { auditoriaDoCaixa } from "~/lib/auditoria.server"
import { rotuloDoMovimento } from "~/lib/caixa"
import { depoisDoDia, diaAtras, diaDeHoje, diaEmTexto, inicioDoDia } from "~/lib/dia"
import { moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Auditoria do caixa — BrasSaco" }]
}

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * Onde o gerente procura desvio no caixa. A conta mora em `auditoria.server`,
 * que explica o que cada quadro denuncia; aqui é a tela.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verRelatorios")

  const params = new URL(request.url).searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  // Sete dias abre: é a janela em que o extrato da maquininha ainda está à mão.
  const de = DIA.test(texto("de")) ? texto("de") : diaAtras(6)
  const ateBruto = DIA.test(texto("ate")) ? texto("ate") : diaDeHoje()
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const pedidoLoja = texto("loja")
  const rede = pedidoLoja === "rede" || !eu.lojasPermitidas.includes(pedidoLoja)
  const lojas = rede ? eu.lojasPermitidas : [pedidoLoja]

  return {
    relatorio: await auditoriaDoCaixa(lojas, inicioDoDia(inicio), depoisDoDia(fim), inicio, fim),
    de: inicio,
    ate: fim,
    loja: rede ? "rede" : pedidoLoja,
    lojasPermitidas: eu.lojasPermitidas,
  }
}

export default function RelatorioAuditoria({ loaderData }: Route.ComponentProps) {
  const { relatorio, de, ate, loja, lojasPermitidas } = loaderData
  const { formasPorDia, descontos, sangrias, cancelados, totais } = relatorio

  const [, setParams] = useSearchParams()
  function trocar(valores: Record<string, string>) {
    setParams((atuais) => {
      const novos = new URLSearchParams(atuais)
      for (const [chave, valor] of Object.entries(valores)) novos.set(chave, valor)
      return novos
    })
  }

  const ATALHOS = [
    { rotulo: "Hoje", de: diaDeHoje(), ate: diaDeHoje() },
    { rotulo: "7 dias", de: diaAtras(6), ate: diaDeHoje() },
    { rotulo: "30 dias", de: diaAtras(29), ate: diaDeHoje() },
  ]

  // A média da rede é a régua: o operador fora dela é que merece a pergunta.
  const vendasComDesconto = descontos.reduce((s, l) => s + l.comDesconto, 0)
  const vendasTotais = descontos.reduce((s, l) => s + l.vendas, 0)
  const fracaoMedia = vendasTotais > 0 ? vendasComDesconto / vendasTotais : 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:gap-3 sm:px-5">
        <ShieldAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Auditoria do caixa</h1>

        <div className="flex gap-1">
          <Button
            type="button"
            size="xs"
            variant={loja === "rede" ? "secondary" : "ghost"}
            onClick={() => trocar({ loja: "rede" })}
            className="rounded-lg"
          >
            Rede
          </Button>
          {lojasPermitidas.map((l) => (
            <Button
              key={l}
              type="button"
              size="xs"
              variant={loja === l ? "secondary" : "ghost"}
              onClick={() => trocar({ loja: l })}
              className="rounded-lg font-mono"
            >
              {l}
            </Button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {ATALHOS.map((a) => (
            <Button
              key={a.rotulo}
              type="button"
              size="xs"
              variant={de === a.de && ate === a.ate ? "secondary" : "ghost"}
              onClick={() => trocar({ de: a.de, ate: a.ate })}
              className="rounded-lg"
            >
              {a.rotulo}
            </Button>
          ))}
          <Input
            type="date"
            value={de}
            onChange={(e) => trocar({ de: e.target.value })}
            aria-label="Início do período"
            className="h-9 w-36 rounded-lg"
          />
          <Input
            type="date"
            value={ate}
            onChange={(e) => trocar({ ate: e.target.value })}
            aria-label="Fim do período"
            className="h-9 w-36 rounded-lg"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-2 lg:grid-cols-4 sm:px-5">
          <Numero
            rotulo="Cartão no período"
            valor={moeda(totais.cartao)}
            apoio="débito + crédito — confira com a maquininha"
          />
          <Numero
            rotulo="Desconto dado"
            valor={moeda(totais.desconto)}
            apoio={`${vendasComDesconto} de ${vendasTotais} vendas com desconto`}
          />
          <Numero
            rotulo="Sangria"
            valor={moeda(totais.sangria)}
            apoio={`${diaEmTexto(de)} a ${diaEmTexto(ate)}`}
          />
          <Numero
            rotulo="Lançamentos cancelados"
            valor={String(totais.cancelados)}
            apoio="abertura, reforço, sangria ou devolução desfeitos"
            alerta={totais.cancelados > 0}
          />
        </div>

        <Quadro
          titulo="Cartão e Pix por dia"
          explica="Some o extrato da maquininha do mesmo dia e loja e compare com débito e crédito. Cartão aqui acima do extrato é venda paga em dinheiro lançada como cartão — o dinheiro saiu da conta da gaveta. O Pix já vem conferido com o Inter."
        >
          {formasPorDia.length === 0 ? (
            <Vazio>Nenhuma venda no período.</Vazio>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-semibold sm:px-5">Dia</th>
                  <th className="w-16 px-2 py-2 font-semibold">Loja</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Débito</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Crédito</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Pix</th>
                  <th className="w-28 px-4 py-2 text-right font-semibold sm:px-5">Dinheiro</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {formasPorDia.map((l) => (
                  <tr key={`${l.loja}-${l.dia}`} className="hover:bg-accent/40">
                    <td className="px-4 py-2 sm:px-5">{diaEmTexto(l.dia)}</td>
                    <td className="px-2 py-2 font-mono text-xs">{l.loja}</td>
                    <td className="px-2 py-2 text-right font-medium">{moeda(l.debito)}</td>
                    <td className="px-2 py-2 text-right font-medium">{moeda(l.credito)}</td>
                    <td className="px-2 py-2 text-right text-muted-foreground">{moeda(l.pix)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground sm:px-5">
                      {moeda(l.dinheiro)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Quadro>

        <Quadro
          titulo="Desconto por operador"
          explica="Quem lançou a venda no caixa. Desconto até o teto não pede gerente; se o cliente pagou o preço cheio em dinheiro, a diferença fica na gaveta e o caixa fecha batendo. Olhe quem foge da média da rede, sobretudo na coluna em dinheiro."
        >
          {descontos.length === 0 ? (
            <Vazio>Nenhuma venda no período.</Vazio>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-semibold sm:px-5">Operador</th>
                  <th className="w-20 px-2 py-2 text-right font-semibold">Vendas</th>
                  <th className="w-32 px-2 py-2 text-right font-semibold">Com desconto</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Desconto</th>
                  <th className="w-24 px-2 py-2 text-right font-semibold">% do vendido</th>
                  <th className="w-36 px-4 py-2 text-right font-semibold sm:px-5">Em dinheiro</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {descontos.map((l) => {
                  // O dobro da média, com volume para não acusar quem fez três vendas.
                  const foraDaMedia =
                    l.vendas >= 10 && fracaoMedia > 0 && l.fracaoComDesconto > fracaoMedia * 2
                  return (
                    <tr key={l.operador} className="hover:bg-accent/40">
                      <td className="px-4 py-2 font-medium sm:px-5">{l.operador}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{l.vendas}</td>
                      <td
                        className={cn(
                          "px-2 py-2 text-right",
                          foraDaMedia ? "font-semibold text-destructive" : "text-muted-foreground"
                        )}
                        title={foraDaMedia ? "Mais que o dobro da média da rede" : undefined}
                      >
                        {l.comDesconto} · {Math.round(l.fracaoComDesconto * 100)}%
                      </td>
                      <td className="px-2 py-2 text-right font-medium">{moeda(l.desconto)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">
                        {l.percentual.toLocaleString("pt-BR")}%
                      </td>
                      <td className="px-4 py-2 text-right sm:px-5">
                        {l.descontoEmDinheiro > 0 ? (
                          <>
                            {moeda(l.descontoEmDinheiro)}
                            <span className="block text-[10px] text-muted-foreground">
                              {l.vendasEmDinheiroComDesconto}{" "}
                              {l.vendasEmDinheiroComDesconto === 1 ? "venda" : "vendas"}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Quadro>

        <Quadro
          titulo="Sangria por operador"
          explica="A conferência do fim do dia não pega sangria indevida: o esperado cai junto com o dinheiro que saiu. Cada sangria tem que ter um destino — depósito, cofre, pagamento — que alguém confira fora do sistema."
        >
          {sangrias.length === 0 ? (
            <Vazio>Nenhuma sangria no período.</Vazio>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-semibold sm:px-5">Operador</th>
                  <th className="w-24 px-2 py-2 text-right font-semibold">Sangrias</th>
                  <th className="w-32 px-2 py-2 text-right font-semibold">Sem gerente</th>
                  <th className="w-32 px-2 py-2 text-right font-semibold">Com gerente</th>
                  <th className="w-32 px-4 py-2 text-right font-semibold sm:px-5">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sangrias.map((l) => (
                  <tr key={l.operador} className="hover:bg-accent/40">
                    <td className="px-4 py-2 font-medium sm:px-5">{l.operador}</td>
                    <td className="px-2 py-2 text-right text-muted-foreground">{l.sangrias}</td>
                    <td className="px-2 py-2 text-right">{moeda(l.semGerente)}</td>
                    <td className="px-2 py-2 text-right text-muted-foreground">
                      {moeda(l.comGerente)}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold sm:px-5">{moeda(l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Quadro>

        <Quadro
          titulo="Lançamentos de gaveta cancelados"
          explica="Cancelar abertura ou reforço baixa o que a gaveta deve ter no fim do dia — por isso passou a pedir gerente. Os cancelamentos de antes disso aparecem aqui também."
        >
          {cancelados.length === 0 ? (
            <Vazio>Nenhum lançamento cancelado no período.</Vazio>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-semibold sm:px-5">Dia</th>
                  <th className="w-16 px-2 py-2 font-semibold">Loja</th>
                  <th className="px-2 py-2 font-semibold">Lançamento</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Valor</th>
                  <th className="px-2 py-2 font-semibold">Lançado por</th>
                  <th className="px-4 py-2 font-semibold sm:px-5">Cancelado por</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {cancelados.map((c) => (
                  <tr key={c.id} className="hover:bg-accent/40">
                    <td className="px-4 py-2 sm:px-5">{diaEmTexto(c.dia)}</td>
                    <td className="px-2 py-2 font-mono text-xs">{c.loja}</td>
                    <td className="px-2 py-2">{rotuloDoMovimento(c.tipo)}</td>
                    <td className="px-2 py-2 text-right">{moeda(c.valor)}</td>
                    <td className="px-2 py-2 text-muted-foreground">{c.lancadoPor}</td>
                    <td className="px-4 py-2 text-muted-foreground sm:px-5">
                      {c.canceladoPor}
                      <span className="block font-mono text-[10px]">
                        {new Date(c.canceladoEm).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Quadro>
      </div>
    </div>
  )
}

function Quadro({
  titulo,
  explica,
  children,
}: {
  titulo: string
  explica: string
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-border">
      <div className="px-4 pt-4 pb-2 sm:px-5">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {titulo}
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{explica}</p>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function Vazio({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pb-4 text-sm text-muted-foreground sm:px-5">{children}</p>
}

function Numero({
  rotulo,
  valor,
  apoio,
  alerta = false,
}: {
  rotulo: string
  valor: string
  apoio: string
  alerta?: boolean
}) {
  return (
    <div className="rounded-xl border border-border px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </p>
      <p
        className={cn(
          "mt-1 font-mono text-xl font-semibold tabular-nums",
          alerta && "text-destructive"
        )}
      >
        {valor}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{apoio}</p>
    </div>
  )
}
