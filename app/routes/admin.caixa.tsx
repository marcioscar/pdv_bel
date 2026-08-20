import { useState } from "react"
import { Link } from "react-router"
import { ArrowLeft, Banknote, Loader2, Printer } from "lucide-react"

import type { Route } from "./+types/admin.caixa"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { diferencaRelevante, rotuloDoMovimento } from "~/lib/caixa"
import { fechamentoDetalhado } from "~/lib/caixa.server"
import { diaEmTexto } from "~/lib/dia"
import { imprimirDocumento } from "~/lib/impressao"
import { moeda } from "~/lib/moeda"
import { FORMAS_PAGAMENTO } from "~/lib/pdv"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `Caixa ${loaderData.fechamento.loja} · ${diaEmTexto(loaderData.fechamento.dia)} — BrasSaco`
        : "Caixa — BrasSaco",
    },
  ]
}

/**
 * O descritivo de um fechamento, para conferir na tela.
 *
 * Existe porque conferir no papel é conferir no que já foi impresso: se a
 * pergunta é "de onde saíram esses R$ 40 a menos", o documento assinado não
 * ajuda — ele repete o mesmo total. Aqui as vendas aparecem uma a uma, e é entre
 * elas que a resposta costuma estar.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "reabrirCaixa")

  const detalhe = await fechamentoDetalhado(params.fechamentoId)
  if (!detalhe) throw new Response("Fechamento não encontrado", { status: 404 })
  if (!eu.lojasPermitidas.includes(detalhe.fechamento.loja)) {
    throw new Response(`Caixa da loja ${detalhe.fechamento.loja}`, { status: 403 })
  }

  return detalhe
}

export default function AdminCaixa({ loaderData }: Route.ComponentProps) {
  const { fechamento: f, movimentos, vendas } = loaderData

  const validas = vendas.filter((v) => !v.canceladaEm)
  const emDinheiro = validas.filter((v) => v.forma === "dinheiro")
  const grave = diferencaRelevante(f.diferenca)

  return (
    <div className="p-4 sm:p-6">
      <Button
        render={<Link to="/admin/caixas" />}
        nativeButton={false}
        size="sm"
        variant="ghost"
        className="rounded-lg text-muted-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Fechamentos
      </Button>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Banknote className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">
          Caixa de {diaEmTexto(f.dia)}
        </h1>
        <Badge variant="outline" className="font-mono text-[10px]">{f.loja}</Badge>
        <span className="text-xs text-muted-foreground">
          fechado por {f.fechadoPor} em {new Date(f.fechadoEm).toLocaleString("pt-BR")}
        </span>
        <BotaoPapel id={f.id} />
      </div>

      {f.observacao ? (
        <p className="mt-3 max-w-2xl rounded-lg bg-muted/50 px-3 py-2 text-sm">
          {f.observacao}
        </p>
      ) : null}

      {/*
        * As contagens desfeitas por reabertura.
        *
        * É a informação que a reabertura escondia quando apagava o fechamento:
        * um caixa que precisou de três tentativas até bater conta uma história
        * diferente de um que fechou certo na primeira.
        */}
      {f.tentativas.length > 0 ? (
        <section className="mt-4 max-w-2xl rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
            Fechado {f.tentativas.length + 1}× · contagens desfeitas
          </h2>
          <ul className="mt-2 space-y-2">
            {f.tentativas.map((t, i) => (
              <li key={i} className="text-xs">
                <span className="font-mono tabular-nums">
                  {new Date(t.fechadoEm).toLocaleString("pt-BR")}
                </span>{" "}
                · {t.fechadoPor} contou{" "}
                <b className="font-mono">{moeda(t.contado)}</b> para{" "}
                <span className="font-mono">{moeda(t.esperado)}</span> esperados
                {" "}
                <b className={cn("font-mono", diferencaRelevante(t.diferenca) && "text-destructive")}>
                  ({t.diferenca > 0 ? "+" : ""}
                  {moeda(t.diferenca)})
                </b>
                {t.observacao ? <span className="block text-muted-foreground">“{t.observacao}”</span> : null}
                <span className="block text-muted-foreground">
                  reaberto por {t.reabertoPor} em{" "}
                  {new Date(t.reabertoEm).toLocaleString("pt-BR")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-5 grid max-w-5xl gap-5 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <section>
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            A conta do dinheiro
          </h2>
          <dl className="mt-3 rounded-xl border border-border p-4 text-sm">
            <Linha rotulo="Troco da abertura" valor={f.abertura} />
            <Linha rotulo="Vendas em dinheiro" valor={f.vendasDinheiro} />
            {f.suprimentos > 0 ? <Linha rotulo="Reforços" valor={f.suprimentos} /> : null}
            {f.sangrias > 0 ? <Linha rotulo="Sangrias" valor={-f.sangrias} /> : null}

            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
              <dt className="text-muted-foreground">Deve haver</dt>
              <dd className="font-mono text-lg font-semibold tabular-nums">
                {moeda(f.esperado)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-muted-foreground">Contado</dt>
              <dd className="font-mono text-lg font-semibold tabular-nums">
                {moeda(f.contado)}
              </dd>
            </div>
            <div
              className={cn(
                "mt-2 flex items-baseline justify-between border-t-2 border-border pt-2",
                grave && "text-destructive"
              )}
            >
              <dt className="text-[10px] font-semibold uppercase tracking-wider">
                {f.diferenca > 0 ? "Sobra" : f.diferenca < 0 ? "Falta" : "Diferença"}
              </dt>
              <dd className="font-mono text-2xl font-bold tabular-nums">
                {moeda(Math.abs(f.diferenca))}
              </dd>
            </div>
          </dl>

          <h2 className="mt-6 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Vendas por forma
          </h2>
          <dl className="mt-3 rounded-xl border border-border p-4 text-sm">
            <Linha rotulo="Dinheiro" valor={f.vendasDinheiro} />
            <Linha rotulo="Pix" valor={f.vendasPix} />
            <Linha rotulo="Débito" valor={f.vendasDebito} />
            <Linha rotulo="Crédito" valor={f.vendasCredito} />
            <Linha rotulo="A prazo" valor={f.vendasPrazo} />
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
              <dt className="font-semibold">Total vendido</dt>
              <dd className="font-mono text-lg font-bold tabular-nums">
                {moeda(f.totalVendido)}
              </dd>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {f.quantidadeVendas} {f.quantidadeVendas === 1 ? "venda" : "vendas"}
              {f.canceladas > 0
                ? ` · ${f.canceladas} cancelada${f.canceladas === 1 ? "" : "s"}, fora da conta`
                : ""}
            </p>
          </dl>

          {movimentos.length > 0 ? (
            <>
              <h2 className="mt-6 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Lançamentos na gaveta
              </h2>
              <ul className="mt-3 divide-y divide-border rounded-xl border border-border px-4">
                {movimentos.map((m) => (
                  <li key={m.id} className="flex items-baseline gap-2 py-2 text-sm">
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {new Date(m.criadoEm).toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs">{rotuloDoMovimento(m.tipo)}</span>
                      {m.observacao ? (
                        <span className="block text-[11px] text-muted-foreground">
                          {m.observacao} · {m.operador}
                        </span>
                      ) : (
                        <span className="block text-[11px] text-muted-foreground">
                          {m.operador}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono tabular-nums",
                        m.tipo === "sangria" && "text-destructive"
                      )}
                    >
                      {m.tipo === "sangria" ? "−" : "+"}
                      {moeda(m.valor)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <section>
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Venda a venda
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {/* O destaque das em dinheiro é o ponto da tela: são as únicas que
                passaram pela gaveta, e é entre elas que uma diferença se explica. */}
            As <b>{emDinheiro.length}</b> em dinheiro estão destacadas — são as que
            entraram na gaveta, somando {moeda(f.vendasDinheiro)}.
          </p>

          {vendas.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Nenhuma venda neste dia.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="py-2 text-left font-semibold">Hora</th>
                    <th scope="col" className="px-2 py-2 text-left font-semibold">Venda</th>
                    <th scope="col" className="px-2 py-2 text-left font-semibold">Operador</th>
                    <th scope="col" className="px-2 py-2 text-left font-semibold">Cliente</th>
                    <th scope="col" className="px-2 py-2 text-left font-semibold">Forma</th>
                    <th scope="col" className="px-2 py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {vendas.map((v) => {
                    const cancelada = Boolean(v.canceladaEm)
                    const dinheiro = v.forma === "dinheiro" && !cancelada
                    return (
                      <tr
                        key={v.id}
                        className={cn(
                          "border-b border-border",
                          dinheiro && "bg-primary/5",
                          cancelada && "opacity-50"
                        )}
                      >
                        <td className="py-2 font-mono text-xs text-muted-foreground tabular-nums">
                          {new Date(v.criadaEm).toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs font-semibold tabular-nums">
                          #{v.numero}
                        </td>
                        <td className="px-2 py-2 text-xs">{v.operador}</td>
                        <td className="max-w-[10rem] truncate px-2 py-2 text-xs text-muted-foreground">
                          {v.clienteNome ?? "Consumidor Final"}
                        </td>
                        <td className="px-2 py-2 text-xs">
                          {cancelada ? (
                            <Badge variant="destructive" className="text-[10px]">
                              cancelada
                            </Badge>
                          ) : (
                            <span className={cn(dinheiro && "font-semibold")}>
                              {FORMAS_PAGAMENTO.find((x) => x.id === v.forma)?.rotulo ??
                                v.forma}
                            </span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2 text-right font-mono tabular-nums",
                            dinheiro && "font-semibold",
                            cancelada && "line-through"
                          )}
                        >
                          {moeda(v.total)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border font-semibold">
                    <td colSpan={5} className="py-2 text-xs">
                      Soma das vendas em dinheiro
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {moeda(emDinheiro.reduce((a, v) => a + v.total, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Linha({ rotulo, valor }: { rotulo: string; valor: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-muted-foreground">{rotulo}</dt>
      <dd className={cn("font-mono tabular-nums", valor < 0 && "text-destructive")}>
        {valor < 0 ? "− " : ""}
        {moeda(Math.abs(valor))}
      </dd>
    </div>
  )
}

function BotaoPapel({ id }: { id: string }) {
  const [gerando, setGerando] = useState(false)

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={gerando}
      className="ml-auto rounded-lg"
      onClick={async () => {
        setGerando(true)
        await imprimirDocumento(`/fechamento/${id}/papel`)
        setGerando(false)
      }}
    >
      {gerando ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Printer className="size-4" aria-hidden />
      )}
      Imprimir
    </Button>
  )
}
