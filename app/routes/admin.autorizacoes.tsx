import { useEffect, useState } from "react"
import { data, Form, useNavigation, useRevalidator } from "react-router"
import { Check, ShieldCheck, X } from "lucide-react"

import type { Route } from "./+types/admin.autorizacoes"
import { ItensDaVenda } from "~/components/pdv/venda-celulas"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  DESCONTO_MAXIMO_PERCENTUAL,
  HORAS_DE_VALIDADE,
  rotuloDaSituacao,
  rotuloDoMotivo,
} from "~/lib/autorizacao"
import {
  decidirAutorizacao,
  listarDecididas,
  listarPendentes,
  type AutorizacaoListada,
} from "~/lib/autorizacao.server"
import { moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Autorizações — BrasSaco" }]
}

/**
 * A fila do gerente: o que está travado no balcão esperando a decisão dele.
 *
 * O vendedor não espera parado — ele larga a venda e atende outro cliente —, mas
 * do outro lado tem um cliente que já escolheu a mercadoria. Por isso a tela se
 * atualiza sozinha e mostra há quanto tempo cada pedido está esperando: uma fila
 * que só aparece quando alguém lembra de abri-la é uma fila que não existe.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "decidirAutorizacoes")

  const [pendentes, decididas] = await Promise.all([
    listarPendentes(eu.lojasPermitidas),
    listarDecididas(eu.lojasPermitidas),
  ])

  return { pendentes, decididas, agora: Date.now() }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "decidirAutorizacoes")

  const formulario = await request.formData()
  const id = String(formulario.get("id") ?? "")
  const decisao = String(formulario.get("decisao") ?? "")

  if (decisao !== "aprovada" && decisao !== "negada") {
    return data({ ok: false as const, erro: "Decisão inválida" }, { status: 400 })
  }

  const resultado = await decidirAutorizacao({
    id,
    decisao,
    quem: { id: eu.id, nome: eu.nome },
    onde: "app",
    observacao: String(formulario.get("observacao") ?? ""),
    linkPagamento: String(formulario.get("linkPagamento") ?? ""),
  })

  if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 409 })
  return { ok: true as const, decisao }
}

/** De quanto em quanto tempo a fila se atualiza sozinha. */
const INTERVALO = 15_000

export default function AdminAutorizacoes({ loaderData, actionData }: Route.ComponentProps) {
  const { pendentes, decididas } = loaderData
  const navegacao = useNavigation()
  const revalidador = useRevalidator()

  /**
   * A fila se atualiza sozinha, mas nunca no meio de uma decisão: revalidar
   * enquanto o gerente digita a observação trocaria a lista sob o cursor dele.
   */
  useEffect(() => {
    const relogio = setInterval(() => {
      if (revalidador.state === "idle" && navegacao.state === "idle") {
        revalidador.revalidate()
      }
    }, INTERVALO)
    return () => clearInterval(relogio)
  }, [navegacao.state, revalidador])

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Autorizações</h1>
        <span className="text-xs text-muted-foreground">
          {pendentes.length === 0
            ? "nada esperando"
            : `${pendentes.length} ${pendentes.length === 1 ? "venda travada" : "vendas travadas"} no balcão`}
        </span>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        A venda trava quando o cliente tem boleto vencido ou o desconto passa de{" "}
        {DESCONTO_MAXIMO_PERCENTUAL}%. A aprovação vale por {HORAS_DE_VALIDADE} horas e
        serve para uma venda só.
      </p>

      {actionData && !actionData.ok ? (
        <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionData.erro}
        </p>
      ) : null}

      {pendentes.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border py-16 text-center">
          <ShieldCheck className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhuma venda esperando liberação.
          </p>
        </div>
      ) : (
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {pendentes.map((pedido) => (
            <Pedido key={pedido.id} pedido={pedido} />
          ))}
        </div>
      )}

      {decididas.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Decididas recentemente
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2.5 text-left font-semibold">Quando</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Loja</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Vendedor</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Cliente</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Motivo</th>
                  <th scope="col" className="px-2 py-2.5 text-right font-semibold">Total</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Decisão</th>
                </tr>
              </thead>
              <tbody>
                {decididas.map((pedido) => (
                  <tr key={pedido.id} className="border-b border-border">
                    <td className="whitespace-nowrap py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                      {new Date(pedido.criadaEm).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-2 py-2.5">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {pedido.loja}
                      </Badge>
                    </td>
                    <td className="px-2 py-2.5 text-xs">{pedido.solicitante}</td>
                    <td className="max-w-[12rem] px-2 py-2.5">
                      <span className="block truncate text-xs">
                        {pedido.clienteNome ?? "Consumidor Final"}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-xs">
                      {pedido.motivos.map(rotuloDoMotivo).join(" · ")}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                      {moeda(pedido.total)}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className="flex flex-col gap-0.5">
                        <Badge
                          variant={
                            pedido.situacao === "negada"
                              ? "destructive"
                              : pedido.situacao === "cancelada"
                                ? "outline"
                                : "default"
                          }
                          className="w-fit text-[10px]"
                        >
                          {rotuloDaSituacao(pedido.situacao)}
                        </Badge>
                        {pedido.decididaPor ? (
                          <span className="text-[11px] text-muted-foreground">
                            {pedido.decididaPor}
                            {/* Onde foi decidido importa: liberar tudo pelo celular
                                sem olhar é diferente de liberar no caixa, com o
                                cliente na frente. */}
                            {pedido.decididaOnde === "caixa" ? " · no caixa" : ""}
                          </span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function esperaEmTexto(desde: Date | string) {
  const minutos = Math.floor((Date.now() - new Date(desde).getTime()) / 60_000)
  if (minutos < 1) return "agora"
  if (minutos < 60) return `há ${minutos} min`
  const horas = Math.floor(minutos / 60)
  return horas < 24 ? `há ${horas}h` : `há ${Math.floor(horas / 24)}d`
}

function Pedido({ pedido }: { pedido: AutorizacaoListada }) {
  const navegacao = useNavigation()
  const enviando =
    navegacao.state !== "idle" && navegacao.formData?.get("id") === pedido.id

  const [observacao, setObservacao] = useState("")
  const [link, setLink] = useState("")

  // Pedido de link não é liberação de risco: o gerente gera o link por fora,
  // manda ao cliente e só libera quando o pagamento cai.
  const porLink = pedido.motivos.includes("link")

  // Meia hora esperando é uma venda que provavelmente já foi embora.
  const minutos = Math.floor((Date.now() - new Date(pedido.criadaEm).getTime()) / 60_000)
  const demorando = minutos >= 15

  return (
    <article
      className={cn(
        "rounded-xl border p-4",
        demorando ? "border-destructive/50 bg-destructive/5" : "border-border"
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          {pedido.loja}
        </Badge>
        <span className="text-sm font-semibold">
          {pedido.clienteNome ?? "Consumidor Final"}
        </span>
        {pedido.clienteCpfCnpj ? (
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {pedido.clienteCpfCnpj}
          </span>
        ) : null}
        <span
          className={cn(
            // `basis-full` no celular: o nome do vendedor cai para a linha de
            // baixo inteira em vez de espremer o nome do cliente até truncar.
            "basis-full text-xs sm:ml-auto sm:basis-auto",
            demorando ? "font-semibold text-destructive" : "text-muted-foreground"
          )}
        >
          {pedido.solicitante} · {esperaEmTexto(pedido.criadaEm)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {pedido.motivos.map((motivo) => (
          <Badge key={motivo} variant="destructive" className="text-[10px]">
            {rotuloDoMotivo(motivo)}
          </Badge>
        ))}
      </div>

      {/* O retrato da dívida no instante do pedido: é com este número que ele
          decide, e é ele que o histórico vai guardar. */}
      {pedido.dividaParcelas > 0 ? (
        <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">
          Deve <strong className="font-mono">{moeda(pedido.dividaValor)}</strong> em{" "}
          {pedido.dividaParcelas}{" "}
          {pedido.dividaParcelas === 1 ? "parcela vencida" : "parcelas vencidas"} — a mais
          velha há {pedido.dividaDiasAtraso}{" "}
          {pedido.dividaDiasAtraso === 1 ? "dia" : "dias"}.
        </p>
      ) : null}

      <div className="mt-3">
        <ItensDaVenda itens={pedido.itens} />
      </div>

      <dl className="mt-3 space-y-0.5 border-t border-border pt-2 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="font-mono tabular-nums">{moeda(pedido.subtotal)}</dd>
        </div>
        {pedido.desconto > 0 ? (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              Desconto{" "}
              <span
                className={cn(
                  "font-mono",
                  pedido.descontoPercentual > DESCONTO_MAXIMO_PERCENTUAL &&
                    "font-semibold text-destructive"
                )}
              >
                {pedido.descontoPercentual.toFixed(1)}%
              </span>
            </dt>
            <dd className="font-mono tabular-nums">− {moeda(pedido.desconto)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t border-border pt-1">
          <dt className="font-semibold">Total</dt>
          <dd className="font-mono text-base font-bold tabular-nums">
            {moeda(pedido.total)}
          </dd>
        </div>
      </dl>

      <Form method="post" className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={pedido.id} />
        {porLink ? (
          <Input
            name="linkPagamento"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="Cole aqui o link que você gerou e mandou ao cliente"
            autoComplete="off"
            className="h-10 w-full min-w-0 rounded-lg border-border bg-background text-sm sm:h-9"
          />
        ) : null}
        <Input
          name="observacao"
          value={observacao}
          onChange={(e) => setObservacao(e.target.value)}
          placeholder="Observação (opcional) — o vendedor lê"
          autoComplete="off"
          className="h-10 w-full min-w-0 rounded-lg border-border bg-background text-sm sm:h-9 sm:w-auto sm:flex-1"
        />
        {/* Altura de dedo no celular, e cada um com metade da largura: decidir
            errado por causa de um botão pequeno é caro dos dois lados. */}
        <Button
          type="submit"
          name="decisao"
          value="negada"
          variant="outline"
          disabled={enviando}
          className="h-11 flex-1 rounded-lg sm:h-9 sm:flex-none"
        >
          <X className="size-4" aria-hidden /> Negar
        </Button>
        <Button
          type="submit"
          name="decisao"
          value="aprovada"
          disabled={enviando}
          className="h-11 flex-1 rounded-lg sm:h-9 sm:flex-none"
        >
          <Check className="size-4" aria-hidden />
          {/* "Aprovar" descreveria mal o que ele está fazendo: aqui ele afirma
              que o dinheiro caiu, e é isso que solta a mercadoria. */}
          {porLink ? "Pago, liberar" : "Aprovar"}
        </Button>
      </Form>
    </article>
  )
}
