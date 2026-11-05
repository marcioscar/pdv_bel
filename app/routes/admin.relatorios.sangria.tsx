import type { ReactNode } from "react"
import { useSearchParams } from "react-router"
import { Banknote, Printer } from "lucide-react"

import type { Route } from "./+types/admin.relatorios.sangria"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { sangriasDoPeriodo } from "~/lib/caixa.server"
import { diaAtras, diaDeHoje, diaEmTexto } from "~/lib/dia"
import { moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Sangrias — BrasSaco" }]
}

const DIA = /^\d{4}-\d{2}-\d{2}$/

/** O filtro é pelo dia do caixa, o mesmo do fechamento em que a sangria entrou. */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verRelatorios")

  const params = new URL(request.url).searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const de = DIA.test(texto("de")) ? texto("de") : diaAtras(6)
  const ateBruto = DIA.test(texto("ate")) ? texto("ate") : diaDeHoje()
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const pedidoLoja = texto("loja")
  const rede = pedidoLoja === "rede" || !eu.lojasPermitidas.includes(pedidoLoja)
  const lojas = rede ? eu.lojasPermitidas : [pedidoLoja]

  return {
    relatorio: await sangriasDoPeriodo(lojas, inicio, fim),
    de: inicio,
    ate: fim,
    loja: rede ? "rede" : pedidoLoja,
    lojasPermitidas: eu.lojasPermitidas,
  }
}

export default function RelatorioSangria({ loaderData }: Route.ComponentProps) {
  const { relatorio, de, ate, loja, lojasPermitidas } = loaderData
  const { sangrias, total, quantidade, canceladas, porLoja } = relatorio

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:gap-3 sm:px-5">
        <Banknote className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Sangrias</h1>

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
        <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-3 sm:px-5">
          <Numero
            rotulo="Total de sangrias"
            valor={moeda(total)}
            apoio={`${diaEmTexto(de)} a ${diaEmTexto(ate)}`}
          />
          <Numero
            rotulo="Lançamentos"
            valor={String(quantidade)}
            apoio={quantidade === 1 ? "sangria válida" : "sangrias válidas"}
          />
          <Numero
            rotulo="Canceladas"
            valor={String(canceladas)}
            apoio="ficam na lista, fora do total"
            alerta={canceladas > 0}
          />
        </div>

        {porLoja.length > 1 ? (
          <section className="border-b border-border">
            <h2 className="px-4 pt-4 text-sm font-semibold sm:px-5">Por loja</h2>
            <table className="mt-2 w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-semibold sm:px-5">Loja</th>
                  <th className="w-28 px-2 py-2 text-right font-semibold">Lançamentos</th>
                  <th className="w-32 px-4 py-2 text-right font-semibold sm:px-5">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {porLoja.map((linha) => (
                  <tr key={linha.loja}>
                    <td className="px-4 py-2 font-mono text-xs sm:px-5">{linha.loja}</td>
                    <td className="px-2 py-2 text-right">{linha.quantidade}</td>
                    <td className="px-4 py-2 text-right font-medium sm:px-5">{moeda(linha.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <section>
          <h2 className="px-4 pt-4 text-sm font-semibold sm:px-5">Lançamentos</h2>
          {sangrias.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              Nenhuma sangria no período.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm tabular-nums">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="w-36 px-4 py-2 font-semibold sm:px-5">Dia</th>
                    <th className="w-16 px-2 py-2 font-semibold">Loja</th>
                    <th className="w-28 px-2 py-2 text-right font-semibold">Valor</th>
                    <th className="px-2 py-2 font-semibold">Motivo</th>
                    <th className="w-40 px-2 py-2 font-semibold">Lançado por</th>
                    <th className="w-28 px-4 py-2 text-right font-semibold sm:px-5">Comprovante</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sangrias.map((s) => {
                    const cancelada = Boolean(s.canceladoEm)
                    return (
                      <tr key={s.id} className={cn(cancelada && "text-muted-foreground")}>
                        <td className="px-4 py-2 sm:px-5">
                          {diaEmTexto(s.dia)}{" "}
                          <span className="text-xs text-muted-foreground">
                            {new Date(s.criadoEm).toLocaleTimeString("pt-BR", {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZone: "America/Sao_Paulo",
                            })}
                          </span>
                        </td>
                        <td className="px-2 py-2 font-mono text-xs">{s.loja}</td>
                        <td className={cn("px-2 py-2 text-right font-medium", cancelada && "line-through")}>
                          {moeda(s.valor)}
                        </td>
                        <td className="px-2 py-2">
                          {s.observacao || <span className="text-muted-foreground">—</span>}
                          {cancelada ? (
                            <span className="ml-2 text-xs text-destructive">
                              cancelada{s.canceladoPor ? ` por ${s.canceladoPor}` : ""}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-2 text-xs">
                          {s.operador}
                          {s.autorizadaPor ? (
                            <span className="block text-muted-foreground">
                              liberada por {s.autorizadaPor}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 text-right sm:px-5">
                          {cancelada ? null : (
                            <a
                              href={`/sangria/${s.id}/comprovante`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                            >
                              <Printer className="size-3.5" aria-hidden /> Abrir
                            </a>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  apoio,
  alerta = false,
}: {
  rotulo: string
  valor: ReactNode
  apoio: string
  alerta?: boolean
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{rotulo}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums", alerta && "text-destructive")}>{valor}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{apoio}</p>
    </div>
  )
}
