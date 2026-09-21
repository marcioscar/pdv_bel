import { useEffect, useRef, useState } from "react"
import { data, Link, useFetcher, useSearchParams } from "react-router"
import { BadgePercent, Check, Pencil, Users, X } from "lucide-react"

import type { Route } from "./+types/admin.relatorios.comissao"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  comissaoPorVendedor,
  definirTaxa,
  historicoDeTaxas,
  taxaVigenteEm,
} from "~/lib/comissao.server"
import { depoisDoDia, diaAtras, diaDeHoje, diaEmTexto, inicioDoDia } from "~/lib/dia"
import { interpretarValor, moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Comissão — BrasSaco" }]
}

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * Quanto cada vendedor tem a receber no período.
 *
 * É a folha do mês antes de virar folha: quem vendeu, quanto, o que voltou, e
 * quanto disso é comissão. A conta mora em `comissao.server` — aqui é a tela.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verRelatorios")

  const params = new URL(request.url).searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  // Sem período pedido, o mês corrente: comissão se fecha por mês, e abrir em
  // "últimos sete dias" daria um número que não serve para pagar ninguém.
  const hoje = new Date()
  const primeiroDoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-01`

  const de = DIA.test(texto("de")) ? texto("de") : primeiroDoMes
  const ateBruto = DIA.test(texto("ate")) ? texto("ate") : diaDeHoje()
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const pedidoLoja = texto("loja")
  const rede = pedidoLoja === "rede" || !eu.lojasPermitidas.includes(pedidoLoja)
  const lojas = rede ? eu.lojasPermitidas : [pedidoLoja]

  const [relatorio, taxa, historico] = await Promise.all([
    comissaoPorVendedor(lojas, inicioDoDia(inicio), depoisDoDia(fim)),
    taxaVigenteEm(new Date()),
    historicoDeTaxas(),
  ])

  return {
    relatorio,
    taxa,
    historico,
    de: inicio,
    ate: fim,
    loja: rede ? "rede" : pedidoLoja,
    lojasPermitidas: eu.lojasPermitidas,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verRelatorios")

  const form = await request.formData()
  const percentual = interpretarValor(String(form.get("percentual") ?? ""))
  const desde = String(form.get("vigenteDesde") ?? "")

  if (percentual === null) return data({ ok: false as const, erro: "Percentual inválido" }, { status: 400 })
  if (!DIA.test(desde)) return data({ ok: false as const, erro: "Data inválida" }, { status: 400 })

  const resultado = await definirTaxa(percentual, inicioDoDia(desde), {
    nome: eu.nome,
    id: eu.id,
  })
  if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 400 })

  return { ok: true as const, mensagem: resultado.mensagem }
}

export default function RelatorioComissao({ loaderData }: Route.ComponentProps) {
  const { relatorio, taxa, historico, de, ate, loja, lojasPermitidas } = loaderData
  const { linhas, totais, taxas, semVendedor } = relatorio

  const [, setParams] = useSearchParams()
  const [editandoTaxa, setEditandoTaxa] = useState(false)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const ultimaResposta = useRef<unknown>(null)
  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data

    if (fetcher.data.ok) {
      setAviso({ texto: fetcher.data.mensagem, tipo: "sucesso" })
      setEditandoTaxa(false)
    } else {
      setAviso({ texto: fetcher.data.erro, tipo: "erro" })
    }
  }, [fetcher.state, fetcher.data])

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 6000)
    return () => clearTimeout(id)
  }, [aviso])

  function trocar(valores: Record<string, string>) {
    setParams((atuais) => {
      const novos = new URLSearchParams(atuais)
      for (const [chave, valor] of Object.entries(valores)) novos.set(chave, valor)
      return novos
    })
  }

  const hoje = new Date()
  const primeiroDoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-01`
  const mesPassadoFim = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-01`
  const anterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)
  const primeiroDoAnterior = `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, "0")}-01`
  const ultimoDoAnterior = new Date(hoje.getFullYear(), hoje.getMonth(), 0)
  const fimDoAnterior = `${ultimoDoAnterior.getFullYear()}-${String(ultimoDoAnterior.getMonth() + 1).padStart(2, "0")}-${String(ultimoDoAnterior.getDate()).padStart(2, "0")}`

  const ATALHOS = [
    { rotulo: "Este mês", de: primeiroDoMes, ate: diaDeHoje() },
    { rotulo: "Mês passado", de: primeiroDoAnterior, ate: fimDoAnterior },
    { rotulo: "30 dias", de: diaAtras(29), ate: diaDeHoje() },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:gap-3 sm:px-5">
        <BadgePercent className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Comissão por vendedor</h1>

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
        {/* ---- A taxa, que é a premissa de tudo o que vem abaixo ---- */}
        <div className="border-b border-border bg-muted/30 px-4 py-2.5 sm:px-5">
          {editandoTaxa ? (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor="taxa-percentual"
                  className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Novo percentual
                </label>
                <Input
                  id="taxa-percentual"
                  name="percentual"
                  defaultValue={taxa.percentual.toLocaleString("pt-BR")}
                  autoComplete="off"
                  className="h-9 w-28 rounded-lg"
                />
              </div>
              <div>
                <label
                  htmlFor="taxa-desde"
                  className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Vigente a partir de
                </label>
                <Input
                  id="taxa-desde"
                  name="vigenteDesde"
                  type="date"
                  defaultValue={primeiroDoMes}
                  className="h-9 w-40 rounded-lg"
                />
              </div>
              <Button
                type="button"
                size="sm"
                disabled={gravando}
                onClick={() => {
                  const percentual = (document.getElementById("taxa-percentual") as HTMLInputElement)?.value
                  const vigenteDesde = (document.getElementById("taxa-desde") as HTMLInputElement)?.value
                  fetcher.submit({ percentual, vigenteDesde }, { method: "post" })
                }}
                className="h-9 rounded-lg"
              >
                <Check className="size-4" />
                {gravando ? "Salvando…" : "Salvar"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditandoTaxa(false)}
                className="h-9 rounded-lg"
              >
                <X className="size-4" />
              </Button>
              <p className="w-full text-[11px] text-muted-foreground">
                A taxa antiga continua valendo para o que veio antes da data escolhida — a
                comissão de um mês já pago não muda porque o percentual mudou depois.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-medium">
                Taxa da rede: {taxa.percentual.toLocaleString("pt-BR")}%
              </span>
              {taxa.padrao ? (
                // Não é lacuna: 1,5% é a regra da rede. O que a linha diz é que
                // ninguém precisou registrar mudança ainda.
                <span className="text-muted-foreground">
                  a mesma desde sempre — nenhuma mudança registrada
                </span>
              ) : (
                <span className="text-muted-foreground">
                  desde {new Date(taxa.vigenteDesde).toLocaleDateString("pt-BR")}, por{" "}
                  {taxa.definidaPor}
                </span>
              )}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setEditandoTaxa(true)}
                className="rounded-lg"
              >
                <Pencil className="size-3.5" />
                Alterar
              </Button>
              {historico.length > 1 ? (
                <span className="text-muted-foreground">
                  {historico.length} mudanças registradas
                </span>
              ) : null}
              {aviso ? (
                <span
                  className={cn(
                    "font-medium",
                    aviso.tipo === "erro" ? "text-destructive" : "text-foreground"
                  )}
                  role="status"
                >
                  {aviso.texto}
                </span>
              ) : null}
            </div>
          )}
        </div>

        {/* ---- Os números do período ---- */}
        <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-2 lg:grid-cols-4 sm:px-5">
          <Numero
            rotulo="A pagar no período"
            valor={moeda(totais.comissao)}
            apoio={`${diaEmTexto(de)} a ${diaEmTexto(ate)}`}
            destaque
          />
          <Numero
            rotulo="Base de cálculo"
            valor={moeda(totais.base)}
            apoio={
              totais.devolvido > 0
                ? `${moeda(totais.vendido)} vendidos − ${moeda(totais.devolvido)} devolvidos`
                : `${moeda(totais.vendido)} vendidos, nada devolvido`
            }
          />
          <Numero
            rotulo="Vendas"
            valor={totais.vendas.toLocaleString("pt-BR")}
            apoio={`${linhas.length} vendedor${linhas.length === 1 ? "" : "es"} com venda`}
          />
          <Numero
            rotulo="Taxa aplicada"
            valor={
              taxas.length === 1
                ? `${taxas[0].percentual.toLocaleString("pt-BR")}%`
                : taxas.map((t) => `${t.percentual.toLocaleString("pt-BR")}%`).join(" · ")
            }
            apoio={
              taxas.length === 1
                ? "a mesma em todo o período"
                : "o período atravessa mudança de taxa"
            }
          />
        </div>

        {linhas.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Users className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhuma venda com vendedor neste período.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-semibold sm:px-5">
                  Vendedor
                </th>
                <th scope="col" className="w-20 px-2 py-2 text-right font-semibold">
                  Vendas
                </th>
                <th scope="col" className="w-32 px-2 py-2 text-right font-semibold">
                  Vendido
                </th>
                <th scope="col" className="w-32 px-2 py-2 text-right font-semibold">
                  Devolvido
                </th>
                <th scope="col" className="w-32 px-2 py-2 text-right font-semibold">
                  Base
                </th>
                <th scope="col" className="w-32 px-4 py-2 text-right font-semibold sm:px-5">
                  Comissão
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {linhas.map((l) => (
                <tr key={l.vendedorId ?? l.nome} className="hover:bg-accent/40">
                  <td className="px-4 py-2 font-medium sm:px-5">
                    {/* Daqui se vai conferir venda por venda — é o que uma
                        pergunta sobre comissão vira quando alguém discorda. */}
                    {l.vendedorId ? (
                      <Link
                        to={`/admin/vendas?de=${de}&ate=${ate}&vendedor=${l.vendedorId}${loja === "rede" ? "" : `&loja=${loja}`}`}
                        className="underline decoration-dotted decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground"
                      >
                        {l.nome}
                      </Link>
                    ) : (
                      l.nome
                    )}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">{l.vendas}</td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {moeda(l.vendido)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right",
                      l.devolvido > 0 ? "text-destructive" : "text-muted-foreground/40"
                    )}
                  >
                    {l.devolvido > 0 ? `− ${moeda(l.devolvido)}` : "—"}
                    {l.devolucoes > 0 ? (
                      <div className="text-[10px] text-muted-foreground">
                        {l.devolucoes} devolução{l.devolucoes === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-right">{moeda(l.base)}</td>
                  <td className="px-4 py-2 text-right font-semibold sm:px-5">
                    {moeda(l.comissao)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="px-4 py-2 sm:px-5">Total</td>
                <td className="px-2 py-2 text-right">{totais.vendas}</td>
                <td className="px-2 py-2 text-right">{moeda(totais.vendido)}</td>
                <td className="px-2 py-2 text-right">
                  {totais.devolvido > 0 ? `− ${moeda(totais.devolvido)}` : "—"}
                </td>
                <td className="px-2 py-2 text-right">{moeda(totais.base)}</td>
                <td className="px-4 py-2 text-right sm:px-5">{moeda(totais.comissao)}</td>
              </tr>
            </tfoot>
          </table>
        )}

        <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          Transferência entre lojas não entra: a nota que uma loja emite para outra da rede
          acompanha a mercadoria e não é venda de ninguém. Venda cancelada também não —
          o cancelamento estorna estoque e dinheiro, e a comissão vai junto. Devolução abate
          no período em que ela aconteceu, não no da venda original: abater no da venda
          mudaria a comissão de um mês já pago.
          {semVendedor.vendas > 0 ? (
            <>
              {" "}
              <b className="font-medium text-foreground">
                {semVendedor.vendas} venda{semVendedor.vendas === 1 ? "" : "s"} do período,
                somando {moeda(semVendedor.vendido)}, não {semVendedor.vendas === 1 ? "tem" : "têm"}{" "}
                vendedor
              </b>{" "}
              e não {semVendedor.vendas === 1 ? "gera" : "geram"} comissão para ninguém — são
              anteriores ao campo de vendedor no caixa.
            </>
          ) : null}
        </p>
      </div>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  apoio,
  destaque,
}: {
  rotulo: string
  valor: string
  apoio: string
  destaque?: boolean
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3",
        destaque ? "border-primary/40 bg-primary/5" : "border-border"
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{valor}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{apoio}</div>
    </div>
  )
}
