import { useState } from "react"
import { data, Form, useFetcher, useNavigation } from "react-router"
import { ChevronDown, ChevronRight, Loader2, Printer, RefreshCw, UserX } from "lucide-react"

import type { Route } from "./+types/admin.inadimplentes"
import { Numero } from "~/components/pdv/numero"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  baixarNaLoja,
  buscarBoletosNoInter,
  inadimplentes,
  pagamentosRecentes,
  resumoDosBoletos,
} from "~/lib/boletos-externos.server"
import { formatarCpfCnpj } from "~/lib/documento"
import { imprimirDocumento } from "~/lib/impressao"
import { interpretarValor, moeda } from "~/lib/moeda"
import { FORMAS_DA_BAIXA, rotuloDaSituacao } from "~/lib/recebiveis"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Inadimplentes — BrasSaco" }]
}

/**
 * Quem deve e o que entrou, somando os boletos do PDV e os do sistema antigo.
 *
 * A conta mora em `boletos-externos.server`. Aqui é a tela e o botão que traz
 * os boletos do Inter — a busca não roda sozinha: o pagamento de um boleto já
 * conhecido chega pelo webhook, e a busca é para trazer os que ainda não estão
 * aqui.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "verContasAReceber")

  const [devedores, resumo, pagamentos] = await Promise.all([
    inadimplentes(),
    resumoDosBoletos(),
    pagamentosRecentes(),
  ])
  return { devedores, resumo, pagamentos }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verContasAReceber")
  const form = await request.formData()

  // A baixa de quem pagou na loja. Vem por um fetcher, e por isso responde com
  // `baixa` em vez de `busca`: a faixa do resultado da busca não se confunde.
  if (form.get("intencao") === "baixar") {
    const r = await baixarNaLoja({
      origem: String(form.get("origem") ?? ""),
      id: String(form.get("id") ?? ""),
      forma: String(form.get("forma") ?? ""),
      valor: interpretarValor(String(form.get("valor") ?? "")) ?? 0,
      gerente: eu.nome,
    })
    return r.ok
      ? { ok: true as const, baixa: r.mensagem }
      : data({ ok: false as const, erro: r.erro }, { status: 400 })
  }

  try {
    return { ok: true as const, busca: await buscarBoletosNoInter() }
  } catch (erro) {
    return data(
      { ok: false as const, erro: erro instanceof Error ? erro.message : "Falha ao falar com o Inter" },
      { status: 502 }
    )
  }
}

function dataCurta(d: Date | string) {
  return new Date(d).toLocaleDateString("pt-BR")
}

export default function Inadimplentes({ loaderData, actionData }: Route.ComponentProps) {
  const { devedores, resumo, pagamentos } = loaderData
  const buscando = useNavigation().state === "submitting"
  const [aberto, setAberto] = useState<string | null>(null)
  const [gerando, setGerando] = useState(false)
  const [erroDaFolha, setErroDaFolha] = useState<string | null>(null)
  // O boleto com o formulário de baixa aberto — um de cada vez.
  const [baixando, setBaixando] = useState<string | null>(null)
  const baixa = useFetcher<typeof action>()
  const baixandoAgora = baixa.state !== "idle"

  // Abre a caixa de impressão do navegador — ali se escolhe a impressora ou
  // "Salvar como PDF".
  async function imprimir() {
    setGerando(true)
    setErroDaFolha(null)
    const problema = await imprimirDocumento("/admin/inadimplentes/impressao")
    setGerando(false)
    if (problema) setErroDaFolha(problema)
  }

  const vencidoTotal = resumo.vencido.pdv.valor + resumo.vencido.antigo.valor
  const aVencerTotal = resumo.aVencer.pdv.valor + resumo.aVencer.antigo.valor
  const recebidoTotal = resumo.recebido30.pdv.valor + resumo.recebido30.antigo.valor

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
        <UserX className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Inadimplentes</h1>
        <span className="text-xs text-muted-foreground">
          boletos do PDV e do sistema antigo, no Inter
        </span>
        <Form method="post" className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {resumo.ultimaBusca
              ? `boletos antigos conferidos em ${new Date(resumo.ultimaBusca).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
              : "boletos do sistema antigo ainda não trazidos"}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={gerando || devedores.length === 0}
            onClick={imprimir}
            className="rounded-lg"
          >
            {gerando ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
            {gerando ? "Gerando…" : "Imprimir por loja"}
          </Button>
          <Button type="submit" size="sm" disabled={buscando} className="rounded-lg">
            {buscando ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {buscando ? "Buscando no Inter…" : "Atualizar do Inter"}
          </Button>
        </Form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {baixa.data && baixa.state === "idle" ? (
          <div
            className={cn(
              "border-b border-border px-4 py-2.5 text-xs sm:px-5",
              baixa.data.ok ? "bg-muted/40" : "bg-destructive/10 text-destructive"
            )}
            role="status"
          >
            {baixa.data.ok && "baixa" in baixa.data
              ? baixa.data.baixa
              : "erro" in baixa.data
                ? baixa.data.erro
                : null}
          </div>
        ) : null}
        {erroDaFolha ? (
          <div className="border-b border-border bg-destructive/10 px-4 py-2.5 text-xs text-destructive sm:px-5">
            {erroDaFolha}
          </div>
        ) : null}
        {actionData && !("baixa" in actionData) ? (
          <div
            className={cn(
              "border-b border-border px-4 py-2.5 text-xs sm:px-5",
              actionData.ok ? "bg-muted/40" : "bg-destructive/10 text-destructive"
            )}
            role="status"
          >
            {actionData.ok && "busca" in actionData
              ? actionData.busca.contas.map((c) => (
                  <span key={c.conta} className="mr-4 inline-block">
                    <b className="font-semibold">{c.conta}</b>:{" "}
                    {c.erro
                      ? <span className="text-destructive">{c.erro}</span>
                      : `${c.trazidos} boletos · ${c.novos} novos · ${c.atualizados} mudaram de situação`}
                  </span>
                ))
              : "erro" in actionData
                ? actionData.erro
                : null}
            {actionData.ok && "busca" in actionData && actionData.busca.contas.length === 0
              ? "Nenhuma conta do Inter configurada neste ambiente."
              : null}
          </div>
        ) : null}

        <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-3 sm:px-5">
          <Numero
            rotulo="Vencido"
            valor={moeda(vencidoTotal)}
            detalhe={`PDV ${moeda(resumo.vencido.pdv.valor)} · antigo ${moeda(resumo.vencido.antigo.valor)} · ${devedores.length} ${devedores.length === 1 ? "devedor" : "devedores"}`}
            destaque
            alerta={vencidoTotal > 0}
          />
          <Numero
            rotulo="A vencer"
            valor={moeda(aVencerTotal)}
            detalhe={`${resumo.aVencer.pdv.quantidade + resumo.aVencer.antigo.quantidade} boletos em aberto`}
          />
          <Numero
            rotulo="Recebido em 30 dias"
            valor={moeda(recebidoTotal)}
            detalhe={`${resumo.recebido30.pdv.quantidade + resumo.recebido30.antigo.quantidade} boletos pagos`}
          />
        </div>

        <section className="border-b border-border">
          <h2 className="px-4 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:px-5">
            Quem está devendo — do maior para o menor
          </h2>
          {devedores.length === 0 ? (
            <p className="px-4 pb-6 text-sm text-muted-foreground sm:px-5">
              Nenhum boleto vencido em aberto.
              {!resumo.ultimaBusca ? " Os do sistema antigo ainda não foram trazidos — use Atualizar do Inter." : ""}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="w-8 px-2 py-2" />
                    <th className="px-2 py-2 font-semibold">Cliente</th>
                    <th className="px-2 py-2 font-semibold">Contato</th>
                    <th className="w-20 px-2 py-2 text-right font-semibold">Boletos</th>
                    <th className="w-24 px-2 py-2 text-right font-semibold">Atraso</th>
                    <th className="w-32 px-4 py-2 text-right font-semibold sm:px-5">Devendo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {devedores.map((d) => {
                    const chave = d.documento ?? d.nome
                    const expandido = aberto === chave
                    return [
                      <tr
                        key={chave}
                        className="cursor-pointer hover:bg-accent/40"
                        onClick={() => setAberto(expandido ? null : chave)}
                      >
                        <td className="px-2 py-2 text-muted-foreground">
                          {expandido ? (
                            <ChevronDown className="size-4" aria-hidden />
                          ) : (
                            <ChevronRight className="size-4" aria-hidden />
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <span className="font-medium">{d.nome}</span>
                          {d.nomeFantasia ? (
                            <span className="ml-2 text-xs text-muted-foreground">{d.nomeFantasia}</span>
                          ) : null}
                          <span className="block font-mono text-[11px] text-muted-foreground">
                            {d.documento ? formatarCpfCnpj(d.documento) : "sem documento"}
                            {d.documentos.length > 1 ? ` · ${d.documentos.length} filiais` : null}
                            {d.clienteId ? null : " · sem cadastro aqui"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {d.telefone ?? "—"}
                          {d.contato ? <span className="block">{d.contato}</span> : null}
                        </td>
                        <td className="px-2 py-2 text-right text-muted-foreground">{d.boletos.length}</td>
                        <td
                          className={cn(
                            "px-2 py-2 text-right",
                            d.diasAtraso > 30 ? "font-semibold text-destructive" : "text-muted-foreground"
                          )}
                        >
                          {d.diasAtraso} {d.diasAtraso === 1 ? "dia" : "dias"}
                        </td>
                        <td className="px-4 py-2 text-right font-semibold sm:px-5">{moeda(d.total)}</td>
                      </tr>,
                      expandido ? (
                        <tr key={`${chave}-boletos`} className="bg-muted/30">
                          <td />
                          <td colSpan={5} className="px-2 py-2 pr-4 sm:pr-5">
                            <table className="w-full text-xs">
                              <tbody>
                                {d.boletos.map((b) => [
                                  <tr key={b.id}>
                                    <td className="py-1 pr-2">
                                      <Badge
                                        variant={b.origem === "antigo" ? "secondary" : "outline"}
                                        className="text-[9px]"
                                      >
                                        {b.origem === "antigo" ? "sistema antigo" : "PDV"}
                                      </Badge>
                                    </td>
                                    <td className="py-1 pr-2">
                                      {b.referencia}
                                      {d.documentos.length > 1 ? (
                                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                                          {formatarCpfCnpj(b.documento)}
                                        </span>
                                      ) : null}
                                    </td>
                                    <td className="py-1 pr-2 font-mono text-muted-foreground">{b.conta}</td>
                                    <td className="py-1 pr-2">venceu {dataCurta(b.vencimento)}</td>
                                    <td className="py-1 pr-2 text-muted-foreground">
                                      {rotuloDaSituacao(b.situacao)}
                                    </td>
                                    <td className="max-w-56 truncate py-1 pr-2 font-mono text-[10px] text-muted-foreground">
                                      {b.linhaDigitavel ?? ""}
                                    </td>
                                    <td className="py-1 text-right font-medium">{moeda(b.valor)}</td>
                                    <td className="py-1 pl-3 text-right">
                                      <Button
                                        type="button"
                                        size="xs"
                                        variant="outline"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setBaixando(baixando === b.id ? null : b.id)
                                        }}
                                        className="rounded-lg whitespace-nowrap"
                                      >
                                        Recebido na loja
                                      </Button>
                                    </td>
                                  </tr>,
                                  baixando === b.id ? (
                                    <tr key={`${b.id}-baixa`}>
                                      <td colSpan={8} className="pb-2">
                                        <baixa.Form
                                          method="post"
                                          onSubmit={() => setBaixando(null)}
                                          className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-primary/40 bg-background p-2"
                                        >
                                          <input type="hidden" name="intencao" value="baixar" />
                                          <input type="hidden" name="origem" value={b.origem} />
                                          <input type="hidden" name="id" value={b.id} />
                                          <span className="text-xs">
                                            O cliente pagou na loja — o boleto é cancelado no Inter
                                            para não ser pago de novo.
                                          </span>
                                          <select
                                            name="forma"
                                            defaultValue="dinheiro"
                                            className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
                                          >
                                            {FORMAS_DA_BAIXA.map((f) => (
                                              <option key={f.id} value={f.id}>
                                                {f.rotulo}
                                              </option>
                                            ))}
                                          </select>
                                          <input
                                            name="valor"
                                            defaultValue={b.valor.toFixed(2).replace(".", ",")}
                                            inputMode="decimal"
                                            aria-label="Valor recebido"
                                            className="h-8 w-24 rounded-lg border border-border bg-background px-2 text-right font-mono text-xs"
                                          />
                                          <Button type="submit" size="xs" disabled={baixandoAgora}>
                                            {baixandoAgora ? "Baixando…" : "Confirmar baixa"}
                                          </Button>
                                          <Button
                                            type="button"
                                            size="xs"
                                            variant="ghost"
                                            onClick={() => setBaixando(null)}
                                          >
                                            Voltar
                                          </Button>
                                        </baixa.Form>
                                      </td>
                                    </tr>
                                  ) : null,
                                ])}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null,
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="px-4 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:px-5">
            Últimos pagamentos
          </h2>
          {pagamentos.length === 0 ? (
            <p className="px-4 pb-6 text-sm text-muted-foreground sm:px-5">Nenhum boleto pago ainda.</p>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <tbody className="divide-y divide-border">
                {pagamentos.map((p, i) => (
                  <tr key={i} className="hover:bg-accent/40">
                    <td className="w-28 px-4 py-2 text-xs text-muted-foreground sm:px-5">
                      {dataCurta(p.quando)}
                    </td>
                    <td className="px-2 py-2">
                      {p.nome}
                      <span className="ml-2 text-xs text-muted-foreground">{p.referencia}</span>
                    </td>
                    <td className="w-32 px-2 py-2">
                      <Badge
                        variant={p.origem === "antigo" ? "secondary" : "outline"}
                        className="text-[9px]"
                      >
                        {p.origem === "antigo" ? "sistema antigo" : "PDV"}
                      </Badge>
                    </td>
                    <td className="w-32 px-4 py-2 text-right font-medium sm:px-5">{moeda(p.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <p className="px-4 py-4 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          O devedor é agrupado pelo CPF/CNPJ do pagador, então o mesmo cliente com boleto
          no PDV e no sistema antigo aparece uma vez só. Boleto vencido de qualquer um dos
          dois trava a venda a prazo no caixa até o gerente liberar. Os pagamentos chegam
          sozinhos pelo aviso do Inter; o botão traz os boletos novos do sistema antigo.
        </p>
      </div>
    </div>
  )
}
