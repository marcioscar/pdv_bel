import { data, Form, useNavigation } from "react-router"
import { PackageX } from "lucide-react"

import type { Route } from "./+types/admin.perdas"
import { CabecalhoDaTransferencia } from "~/components/pdv/transferencia-celulas"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { quantidade as formatarQuantidade } from "~/lib/moeda"
import { cn } from "~/lib/utils"
import { exigirGerente } from "~/lib/sessao.server"
import { faltaDoItem, faltaEmAberto } from "~/lib/transferencias"
import {
  listarTransferencias,
  perdasNoTransporte,
  resolverFalta,
  type PerdaNoTransporte,
  type TransferenciaListada,
} from "~/lib/transferencias.server"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Perdas no transporte — BrasSaco" }]
}

/**
 * O que saiu de uma loja e não chegou na outra.
 *
 * Mora na administração, e não na tela de transferências, porque são dois
 * trabalhos diferentes: quem despacha e quem confere está de pé no estoque com
 * a carga na frente; quem investiga o que sumiu está sentado, olhando semanas
 * para trás. Misturar os dois faria o operador percorrer o histórico de perdas
 * da rede toda vez que fosse mandar uma caixa para a loja vizinha.
 *
 * Decidir o destino da falta também é daqui: é o gerente que responde pelo
 * buraco, e a decisão precisa do contexto que só esta tela reúne.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "resolverFaltaDeTransferencia")

  const [perdas, transferencias] = await Promise.all([
    perdasNoTransporte(eu.lojasPermitidas),
    listarTransferencias(eu.lojasPermitidas),
  ])

  return { perdas, aResolver: transferencias.filter(faltaEmAberto) }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "resolverFaltaDeTransferencia")

  const formulario = await request.formData()
  const decisao = String(formulario.get("decisao") ?? "")
  if (decisao !== "perda" && decisao !== "apareceu") {
    return data({ ok: false as const, erro: "Decisão inválida" }, { status: 400 })
  }

  const resultado = await resolverFalta({
    id: String(formulario.get("id") ?? ""),
    decisao,
    operador: eu.nome,
    observacao: String(formulario.get("observacao") ?? ""),
  })
  if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 400 })

  return {
    ok: true as const,
    mensagem:
      decisao === "perda"
        ? "Registrado como perda no transporte"
        : "A mercadoria apareceu e entrou no estoque do destino",
  }
}

export default function AdminPerdas({ loaderData, actionData }: Route.ComponentProps) {
  const { perdas, aResolver } = loaderData

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <PackageX className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Perdas no transporte</h1>
        {perdas.ocorrencias.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {perdas.ocorrencias.length}{" "}
            {perdas.ocorrencias.length === 1 ? "remessa" : "remessas"} com falta
          </span>
        ) : null}
      </div>

      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        Quando falta mercadoria, o saldo já está certo sozinho: a origem baixou tudo o
        que despachou e o destino recebeu só o que contou. O que se decide aqui não é
        o número — é o que aconteceu, e isso fica registrado para depois.
      </p>

      {actionData ? (
        <p
          role="alert"
          className={cn(
            "mt-3 rounded-lg px-3 py-2 text-sm",
            actionData.ok ? "bg-primary/10 text-foreground" : "bg-destructive/10 text-destructive"
          )}
        >
          {actionData.ok ? actionData.mensagem : actionData.erro}
        </p>
      ) : null}

      {aResolver.length > 0 ? (
        <section className="mt-7">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
            Esperando sua decisão
          </h2>
          <div className="mt-3 grid gap-3">
            {aResolver.map((t) => (
              <Falta key={t.id} transferencia={t} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-7">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Histórico
        </h2>
        <div className="mt-3">
          {perdas.ocorrencias.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-16 text-center">
              <PackageX className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
              <p className="mt-3 text-sm text-muted-foreground">
                Nenhuma mercadoria sumiu entre as lojas. Ainda.
              </p>
            </div>
          ) : (
            <Perdas perdas={perdas} />
          )}
        </div>
      </section>
    </div>
  )
}

/**
 * O rastro das faltas, para responder "o que aconteceu com a mercadoria".
 *
 * Primeiro o resumo por rota, porque é ele que revela o padrão — perder de vez
 * em quando é transporte, perder sempre no mesmo trecho é outra coisa. Depois
 * caso a caso, com os nomes de quem despachou, quem contou e quem decidiu: uma
 * perda sem pessoas associadas é um número que ninguém investiga.
 */
function Perdas({ perdas }: { perdas: PerdaNoTransporte }) {
  const totalUnidades = perdas.porRota.reduce((a, r) => a + r.unidades, 0)

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-lg font-bold tabular-nums text-destructive">
          {formatarQuantidade(totalUnidades)}
        </span>
        <span className="text-xs text-muted-foreground">
          unidades sumiram em {perdas.ocorrencias.length}{" "}
          {perdas.ocorrencias.length === 1 ? "remessa" : "remessas"}
        </span>
      </div>

      {perdas.porRota.length > 1 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {perdas.porRota.map((r) => (
            <li
              key={r.rota}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs"
              title={r.produtos.join(", ")}
            >
              <span className="font-mono font-semibold">{r.rota}</span>
              <span className="ml-2 text-muted-foreground">
                {formatarQuantidade(r.unidades)} un em {r.ocorrencias}{" "}
                {r.ocorrencias === 1 ? "vez" : "vezes"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-3 divide-y divide-border border-t border-border">
        {perdas.ocorrencias.map((o) => (
          <li key={o.id} className="py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <a
                href={`/transferencias/${o.id}/romaneio`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm font-semibold underline"
              >
                #{o.numero}
              </a>
              <span className="font-mono">{o.rota}</span>
              <span className="text-muted-foreground">
                {new Date(o.criadaEm).toLocaleDateString("pt-BR")}
              </span>
              {o.resolvidaEm ? (
                <Badge variant="outline" className="text-[10px]">resolvida</Badge>
              ) : (
                <Badge variant="destructive" className="text-[10px]">sem decisão</Badge>
              )}
            </div>

            <ul className="mt-1.5">
              {o.faltantes.map((f) => (
                <li key={f.codigo} className="text-sm">
                  <b className="font-mono text-destructive">
                    −{formatarQuantidade(f.falta)} {f.unidade}
                  </b>{" "}
                  {f.descricao}
                  <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                    (saiu {formatarQuantidade(f.enviada)}, chegou {formatarQuantidade(f.recebida)})
                  </span>
                </li>
              ))}
            </ul>

            {/* As pessoas: é por elas que a investigação anda. */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              despachou <b>{o.enviadaPor}</b>
              {o.recebidaPor ? (
                <>
                  {" "}· conferiu <b>{o.recebidaPor}</b>
                  {o.recebidaEm
                    ? ` em ${new Date(o.recebidaEm).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`
                    : ""}
                </>
              ) : null}
              {o.resolvidaPor ? <> · decidiu <b>{o.resolvidaPor}</b></> : null}
            </p>

            {o.observacao ? (
              <p className="mt-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs">
                {o.observacao}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Falta({ transferencia: t }: { transferencia: TransferenciaListada }) {
  const navegacao = useNavigation()
  const enviando = navegacao.formData?.get("id") === t.id
  const faltantes = t.itens.filter((i) => faltaDoItem(i) > 0)

  return (
    <article className="rounded-xl border border-destructive/50 p-4">
      <CabecalhoDaTransferencia transferencia={t} />
      <p className="mt-1 text-xs text-muted-foreground">
        conferida por {t.recebidaPor}
      </p>

      <ul className="mt-3 space-y-1">
        {faltantes.map((i) => (
          <li key={i.produtoId} className="text-sm">
            <b className="font-mono text-destructive">
              faltaram {formatarQuantidade(faltaDoItem(i))} {i.unidade}
            </b>{" "}
            de {i.descricao}
            <span className="ml-1 font-mono text-[11px] text-muted-foreground">
              (saiu {formatarQuantidade(i.enviada)}, chegou {formatarQuantidade(i.recebida ?? 0)})
            </span>
          </li>
        ))}
      </ul>

      <Form method="post" className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="intencao" value="resolver" />
          <input type="hidden" name="id" value={t.id} />
          <Input
            name="observacao"
            placeholder="O que houve (opcional)"
            autoComplete="off"
            className="h-10 w-full min-w-0 rounded-lg border-border bg-background text-sm sm:w-auto sm:flex-1"
          />
          <Button
            type="submit"
            name="decisao"
            value="apareceu"
            variant="outline"
            disabled={enviando}
            className="h-11 flex-1 rounded-lg sm:h-9 sm:flex-none"
          >
            Apareceu depois
          </Button>
          <Button
            type="submit"
            name="decisao"
            value="perda"
            variant="outline"
            disabled={enviando}
            className="h-11 flex-1 rounded-lg text-destructive sm:h-9 sm:flex-none"
          >
            Perdeu no caminho
          </Button>
      </Form>
    </article>
  )
}
