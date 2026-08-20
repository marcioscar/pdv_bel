import { data, Form, useNavigation } from "react-router"
import { Banknote, TriangleAlert, Unlock } from "lucide-react"

import type { Route } from "./+types/admin.caixas"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { diferencaRelevante } from "~/lib/caixa"
import { diasSemFechamento, listarFechamentos, reabrirCaixa } from "~/lib/caixa.server"
import { diaAtras, diaEmTexto } from "~/lib/dia"
import { moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Fechamentos de caixa — BrasSaco" }]
}

/** Quanto para trás procurar dia que ninguém fechou. Um mês cobre o esquecido
 *  sem transformar a tela num histórico de tudo. */
const DIAS_VIGIADOS = 30

/**
 * Os fechamentos da rede, do ponto de vista de quem cobra.
 *
 * Duas perguntas, nesta ordem: que dia ficou sem fechar (porque caixa não
 * fechado é dinheiro sem conferência, e ninguém lembra sozinho) e onde as
 * diferenças estão aparecendo. Um caixa que erra R$ 2 todo dia não é o mesmo
 * problema que um que erra R$ 200 uma vez, e o total sozinho esconde os dois.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "reabrirCaixa")

  const [fechamentos, semFechar] = await Promise.all([
    listarFechamentos(eu.lojasPermitidas),
    diasSemFechamento(eu.lojasPermitidas, diaAtras(DIAS_VIGIADOS)),
  ])

  return { fechamentos, semFechar }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "reabrirCaixa")

  const formulario = await request.formData()
  const loja = String(formulario.get("loja") ?? "")
  const dia = String(formulario.get("dia") ?? "")

  if (!eu.lojasPermitidas.includes(loja)) {
    return data({ ok: false as const, erro: "Loja fora do seu alcance" }, { status: 403 })
  }

  const reaberto = await reabrirCaixa(loja, dia)
  if (!reaberto) {
    return data({ ok: false as const, erro: "Este dia não estava fechado" }, { status: 400 })
  }
  return {
    ok: true as const,
    mensagem: `${loja} de ${diaEmTexto(dia)} reaberto — o papel já impresso deixa de valer`,
  }
}

export default function AdminCaixas({ loaderData, actionData }: Route.ComponentProps) {
  const { fechamentos, semFechar } = loaderData
  const navegacao = useNavigation()

  const comDiferenca = fechamentos.filter((f) => diferencaRelevante(f.diferenca))
  const somaDasDiferencas = comDiferenca.reduce((a, f) => a + f.diferenca, 0)

  /** Onde a diferença se concentra. Um caixa que erra todo dia é outro problema
   *  — e outro tipo de conversa — que um que errou muito uma vez só. */
  const porLoja = new Map<string, { dias: number; soma: number; pior: number }>()
  for (const f of comDiferenca) {
    const atual = porLoja.get(f.loja) ?? { dias: 0, soma: 0, pior: 0 }
    atual.dias += 1
    atual.soma += f.diferenca
    if (Math.abs(f.diferenca) > Math.abs(atual.pior)) atual.pior = f.diferenca
    porLoja.set(f.loja, atual)
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Banknote className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Fechamentos de caixa</h1>
        <span className="text-xs text-muted-foreground">
          {fechamentos.length} {fechamentos.length === 1 ? "fechamento" : "fechamentos"} ·{" "}
          {comDiferenca.length} com diferença
        </span>
      </div>

      {actionData ? (
        <p
          role="alert"
          className={cn(
            "mt-3 max-w-2xl rounded-lg px-3 py-2 text-sm",
            actionData.ok
              ? "bg-primary/10 text-foreground"
              : "bg-destructive/10 text-destructive"
          )}
        >
          {actionData.ok ? actionData.mensagem : actionData.erro}
        </p>
      ) : null}

      {semFechar.length > 0 ? (
        <section className="mt-6">
          <h2 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-destructive">
            <TriangleAlert className="size-3.5" aria-hidden />
            Dias com venda que ninguém fechou
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Houve movimento e o caixa não foi conferido. Quanto mais tempo passa, menos
            alguém lembra do que aconteceu naquele dia.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {semFechar.map((d) => (
              <li
                key={`${d.loja}|${d.dia}`}
                className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-sm"
              >
                <span className="font-mono font-semibold">{d.loja}</span>
                <span className="ml-2 font-mono tabular-nums">{diaEmTexto(d.dia)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {porLoja.size > 0 ? (
        <section className="mt-6">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Onde as diferenças aparecem
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {[...porLoja.entries()].map(([loja, r]) => (
              <div key={loja} className="rounded-xl border border-border p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {loja}
                </div>
                <div
                  className={cn(
                    "mt-0.5 font-mono text-lg font-bold tabular-nums",
                    r.soma < 0 && "text-destructive"
                  )}
                >
                  {r.soma > 0 ? "+" : ""}
                  {moeda(r.soma)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  em {r.dias} {r.dias === 1 ? "dia" : "dias"} · pior {moeda(r.pior)}
                </div>
              </div>
            ))}
            <div className="rounded-xl border border-border bg-muted/40 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Soma da rede
              </div>
              <div
                className={cn(
                  "mt-0.5 font-mono text-lg font-bold tabular-nums",
                  somaDasDiferencas < 0 && "text-destructive"
                )}
              >
                {somaDasDiferencas > 0 ? "+" : ""}
                {moeda(somaDasDiferencas)}
              </div>
              <div className="text-[11px] text-muted-foreground">
                sobras e faltas se anulando
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-7">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Histórico
        </h2>
        {fechamentos.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-border py-16 text-center">
            <Banknote className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum caixa foi fechado ainda.
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2.5 text-left font-semibold">Dia</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Loja</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Deve haver</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Contado</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Diferença</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Vendido</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Quem fechou</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold" />
                </tr>
              </thead>
              <tbody>
                {fechamentos.map((f) => {
                  const grave = diferencaRelevante(f.diferenca)
                  const enviando = navegacao.formData?.get("dia") === f.dia
                  return (
                    <tr
                      key={f.id}
                      className={cn("border-b border-border", grave && "bg-destructive/5")}
                    >
                      <td className="whitespace-nowrap py-2.5 font-mono tabular-nums">
                        {diaEmTexto(f.dia)}
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {f.loja}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                        {moeda(f.esperado)}
                      </td>
                      <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                        {moeda(f.contado)}
                      </td>
                      <td
                        className={cn(
                          "px-2 py-2.5 text-right font-mono font-semibold tabular-nums",
                          grave && "text-destructive"
                        )}
                      >
                        {f.diferenca > 0 ? "+" : ""}
                        {moeda(f.diferenca)}
                      </td>
                      <td className="px-2 py-2.5 text-right font-mono text-xs text-muted-foreground tabular-nums">
                        {moeda(f.totalVendido)}
                      </td>
                      <td className="px-2 py-2.5 text-xs">
                        <span className="block">{f.fechadoPor}</span>
                        {f.observacao ? (
                          <span className="block max-w-[16rem] text-[11px] text-muted-foreground">
                            {f.observacao}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2.5">
                        <span className="flex items-center gap-1">
                          <a
                            href={`/fechamento/${f.id}/papel`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs underline"
                          >
                            papel
                          </a>
                          <Form method="post">
                            <input type="hidden" name="loja" value={f.loja} />
                            <input type="hidden" name="dia" value={f.dia} />
                            <Button
                              type="submit"
                              size="sm"
                              variant="ghost"
                              disabled={enviando}
                              className="rounded-lg text-muted-foreground"
                              title="Apaga o fechamento e libera o dia para ser conferido de novo"
                            >
                              <Unlock className="size-3.5" aria-hidden /> reabrir
                            </Button>
                          </Form>
                        </span>
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
  )
}
