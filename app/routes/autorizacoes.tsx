import { useEffect } from "react"
import { data, Form, Link, useNavigation, useRevalidator } from "react-router"
import { Check, Clock, ShoppingCart, X } from "lucide-react"

import type { Route } from "./+types/autorizacoes"
import { Topo } from "~/components/pdv/topo"
import { ItensDaVenda } from "~/components/pdv/venda-celulas"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { aprovacaoValida, HORAS_DE_VALIDADE, rotuloDoMotivo } from "~/lib/autorizacao"
import { cancelarAutorizacao, listarDoOperador } from "~/lib/autorizacao.server"
import { moeda } from "~/lib/moeda"
import { exigirUsuario } from "~/lib/sessao.server"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Minhas autorizações — BrasSaco" }]
}

/**
 * O que o vendedor pediu ao gerente e em que pé está.
 *
 * Existe porque ele NÃO espera parado: pede a liberação, larga a venda e atende
 * o próximo da fila. Sem uma tela para voltar, o carrinho gravado seria um
 * carrinho perdido — ele teria de bipar tudo de novo, e ninguém faz isso duas
 * vezes: passaria a vender sem pedir.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)
  return { eu, pedidos: await listarDoOperador(eu.id) }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)
  const formulario = await request.formData()

  const cancelada = await cancelarAutorizacao(String(formulario.get("id") ?? ""), eu.id)
  if (!cancelada) {
    return data(
      { ok: false as const, erro: "O pedido já foi decidido — atualize a tela" },
      { status: 409 }
    )
  }
  return { ok: true as const }
}

const INTERVALO = 10_000

export default function Autorizacoes({ loaderData, actionData }: Route.ComponentProps) {
  const { eu, pedidos } = loaderData
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  const revalidador = useRevalidator()
  const navegacao = useNavigation()

  // Mais rápido que a fila do gerente: aqui tem alguém olhando a tela à espera
  // da resposta, com o cliente por perto.
  useEffect(() => {
    const t = setInterval(() => {
      if (revalidador.state === "idle" && navegacao.state === "idle") {
        revalidador.revalidate()
      }
    }, INTERVALO)
    return () => clearInterval(t)
  }, [navegacao.state, revalidador])

  const esperando = pedidos.filter((p) => p.situacao === "pendente")
  const liberadas = pedidos.filter((p) => aprovacaoValida(p))
  const negadas = pedidos.filter((p) => p.situacao === "negada")

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        loja={eu.loja}
        lojasPermitidas={eu.lojasPermitidas.length}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      />

      <section className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-base font-semibold">Minhas autorizações</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          A liberação vale por {HORAS_DE_VALIDADE} horas e serve para uma venda só. Ao
          retomar, o carrinho volta como estava — os preços são recalculados na hora de
          fechar.
        </p>

        {actionData && !actionData.ok ? (
          <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {actionData.erro}
          </p>
        ) : null}

        {pedidos.length === 0 ? (
          <div className="mt-8 rounded-xl border border-dashed border-border py-16 text-center">
            <Check className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum pedido de autorização nas últimas 24 horas.
            </p>
            <Button
              render={<Link to="/" />}
              nativeButton={false}
              size="sm"
              variant="outline"
              className="mt-4 rounded-lg"
            >
              Voltar ao caixa
            </Button>
          </div>
        ) : (
          <div className="mt-5 grid max-w-4xl gap-4 md:grid-cols-2">
            {[...liberadas, ...esperando, ...negadas].map((pedido) => {
              const liberada = aprovacaoValida(pedido)
              const negada = pedido.situacao === "negada"

              return (
                <article
                  key={pedido.id}
                  className={cn(
                    "rounded-xl border p-4",
                    liberada && "border-primary bg-primary/5",
                    negada && "border-destructive/40 bg-destructive/5",
                    !liberada && !negada && "border-border"
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    <Badge
                      variant={liberada ? "default" : negada ? "destructive" : "secondary"}
                      className="text-[10px]"
                    >
                      {liberada ? "Liberada" : negada ? "Negada" : "Aguardando"}
                    </Badge>
                    <span className="text-sm font-semibold">
                      {pedido.clienteNome ?? "Consumidor Final"}
                    </span>
                    <span className="ml-auto font-mono text-sm font-bold tabular-nums">
                      {moeda(pedido.total)}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {pedido.motivos.map((motivo) => (
                      <Badge key={motivo} variant="outline" className="text-[10px]">
                        {rotuloDoMotivo(motivo)}
                      </Badge>
                    ))}
                  </div>

                  <div className="mt-3">
                    <ItensDaVenda itens={pedido.itens} />
                  </div>

                  {pedido.observacao ? (
                    <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                      <strong>{pedido.decididaPor}:</strong> {pedido.observacao}
                    </p>
                  ) : null}

                  <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                    {liberada ? (
                      <Button
                        render={<Link to={`/?retomar=${pedido.id}`} />}
                        nativeButton={false}
                        size="sm"
                        className="rounded-lg"
                      >
                        <ShoppingCart className="size-4" aria-hidden /> Retomar no caixa
                      </Button>
                    ) : negada ? (
                      <span className="text-xs text-muted-foreground">
                        {pedido.decididaPor
                          ? `Negada por ${pedido.decididaPor}`
                          : "Negada"}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="size-3.5 animate-pulse" aria-hidden />
                        Esperando o gerente
                      </span>
                    )}

                    {pedido.situacao === "pendente" ? (
                      <Form method="post" className="ml-auto">
                        <input type="hidden" name="id" value={pedido.id} />
                        <Button
                          type="submit"
                          size="sm"
                          variant="ghost"
                          className="rounded-lg text-muted-foreground"
                        >
                          <X className="size-4" aria-hidden /> Desistir
                        </Button>
                      </Form>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}
