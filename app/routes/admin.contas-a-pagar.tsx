import { useEffect, useState } from "react"
import { data, Link, useFetcher, useNavigation, useSearchParams } from "react-router"
import { Check, Loader2, Receipt, Search, Undo2 } from "lucide-react"

import type { Route } from "./+types/admin.contas-a-pagar"
import { Atalho, Campo, ESTILO_CAMPO } from "~/components/pdv/filtros"
import { Numero } from "~/components/pdv/numero"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { SITUACOES_A_PAGAR, type FiltroAPagar } from "~/lib/contas-a-pagar"
import {
  consultarContasAPagar,
  desfazerPagamento,
  lerFiltroAPagar,
  marcarPaga,
  type ContaAPagar,
} from "~/lib/contas-a-pagar.server"
import { diaAdiante, diaAtras, diaDeHoje, diaEmTexto, PRIMEIRO_DIA } from "~/lib/dia"
import { listarLojas } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Contas a pagar — BrasSaco" }]
}

/**
 * O que a empresa deve aos fornecedores, título a título, por vencimento.
 *
 * O espelho do Contas a receber. Os títulos nascem das duplicatas das notas de
 * entrada (e das AFs), em "Gerar despesas" na própria nota; aqui se acompanha
 * o vencimento e se marca o que foi pago. Marcar como pago é o que leva a
 * despesa para o resultado do mês no brassacoAdm (ver contas-a-pagar.server).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verContasAPagar")
  const filtro = lerFiltroAPagar(new URL(request.url), eu.lojasPermitidas)
  const [consulta, lojas] = await Promise.all([consultarContasAPagar(filtro), listarLojas()])
  return {
    filtro,
    lojas: lojas.filter((loja) => eu.lojasPermitidas.includes(loja.codigo)),
    hoje: diaDeHoje(),
    ...consulta,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verContasAPagar")
  const form = await request.formData()
  const id = String(form.get("id") ?? "")
  const intencao = form.get("intencao")

  const r =
    intencao === "pagar"
      ? await marcarPaga(id, String(form.get("dia") ?? ""), eu.nome)
      : intencao === "desfazer"
        ? await desfazerPagamento(id)
        : { ok: false as const, erro: "Ação desconhecida" }

  return r.ok ? r : data(r, { status: 400 })
}

export default function AdminContasAPagar({ loaderData }: Route.ComponentProps) {
  const { filtro, lojas, hoje, contas, total, limite, resumo } = loaderData
  const [, setParams] = useSearchParams()
  const consultando = useNavigation().state === "loading"

  const [campos, setCampos] = useState(filtro)
  useEffect(() => setCampos(filtro), [filtro])

  function aplicar(mudanca: Partial<FiltroAPagar>) {
    const proximo = { ...campos, ...mudanca }
    setCampos(proximo)
    const novos = new URLSearchParams()
    novos.set("de", proximo.de)
    novos.set("ate", proximo.ate)
    if (proximo.loja !== "todas") novos.set("loja", proximo.loja)
    if (proximo.fornecedor) novos.set("fornecedor", proximo.fornecedor)
    if (proximo.situacao !== "abertas") novos.set("situacao", proximo.situacao)
    setParams(novos)
  }

  const periodo =
    filtro.de === PRIMEIRO_DIA
      ? `até ${diaEmTexto(filtro.ate)}`
      : filtro.de === filtro.ate
        ? diaEmTexto(filtro.de)
        : `${diaEmTexto(filtro.de)} a ${diaEmTexto(filtro.ate)}`

  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <Receipt className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Contas a pagar</h1>
        <span className="text-xs text-muted-foreground">vence {periodo}</span>
        {consultando ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(evento) => {
          evento.preventDefault()
          aplicar({})
        }}
      >
        <Campo rotulo="Vence de">
          <input
            type="date"
            value={campos.de}
            max={campos.ate}
            onChange={(e) => aplicar({ de: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>
        <Campo rotulo="Até">
          <input
            type="date"
            value={campos.ate}
            min={campos.de}
            onChange={(e) => aplicar({ ate: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>
        <div className="flex gap-1 pb-0.5">
          <Atalho
            rotulo="Vencidas"
            onClick={() => aplicar({ de: PRIMEIRO_DIA, ate: diaAtras(1), situacao: "abertas" })}
          />
          <Atalho rotulo="Hoje" onClick={() => aplicar({ de: diaDeHoje(), ate: diaDeHoje() })} />
          <Atalho rotulo="7 dias" onClick={() => aplicar({ de: diaDeHoje(), ate: diaAdiante(6) })} />
          <Atalho rotulo="30 dias" onClick={() => aplicar({ de: diaDeHoje(), ate: diaAdiante(29) })} />
        </div>

        <Campo rotulo="Loja">
          <select
            value={campos.loja}
            onChange={(e) => aplicar({ loja: e.target.value })}
            className={cn(ESTILO_CAMPO, "w-40")}
          >
            <option value="todas">Todas</option>
            {lojas.map((loja) => (
              <option key={loja.codigo} value={loja.codigo}>
                {loja.codigo} · {loja.nome}
              </option>
            ))}
          </select>
        </Campo>

        <Campo rotulo="Fornecedor">
          <Input
            value={campos.fornecedor}
            onChange={(e) => setCampos({ ...campos, fornecedor: e.target.value })}
            placeholder="Nome"
            type="search"
            autoComplete="off"
            className="h-9 w-56 rounded-lg border-border bg-background"
          />
        </Campo>

        <Campo rotulo="Situação">
          <select
            value={campos.situacao}
            onChange={(e) => aplicar({ situacao: e.target.value as FiltroAPagar["situacao"] })}
            className={cn(ESTILO_CAMPO, "w-36")}
          >
            {SITUACOES_A_PAGAR.map((s) => (
              <option key={s.id} value={s.id}>
                {s.rotulo}
              </option>
            ))}
          </select>
        </Campo>

        <Button type="submit" size="sm" className="rounded-lg">
          <Search className="size-4" aria-hidden /> Filtrar
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setParams(new URLSearchParams())}
          className="rounded-lg"
        >
          Limpar
        </Button>
      </form>

      <div className="mt-5 grid max-w-3xl gap-3 sm:grid-cols-3">
        <Numero
          rotulo="A pagar"
          valor={moeda(resumo.aberto.valor)}
          detalhe={`${resumo.aberto.quantidade} ${resumo.aberto.quantidade === 1 ? "título em aberto" : "títulos em aberto"}`}
          destaque
        />
        <Numero
          rotulo="Vencido"
          valor={moeda(resumo.vencido.valor)}
          detalhe={`${resumo.vencido.quantidade} ${resumo.vencido.quantidade === 1 ? "título passou do dia" : "títulos passaram do dia"}`}
          alerta={resumo.vencido.valor > 0}
        />
        <Numero
          rotulo="Pago"
          valor={moeda(resumo.pago.valor)}
          detalhe={`${resumo.pago.quantidade} ${resumo.pago.quantidade === 1 ? "título pago" : "títulos pagos"} no período`}
        />
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="w-28 py-2.5 text-left font-semibold">Vencimento</th>
              <th className="px-2 py-2.5 text-left font-semibold">Fornecedor</th>
              <th className="px-2 py-2.5 text-left font-semibold">Descrição</th>
              <th className="w-16 px-2 py-2.5 text-left font-semibold">Loja</th>
              <th className="w-32 px-2 py-2.5 text-left font-semibold">Conta</th>
              <th className="w-28 px-2 py-2.5 text-right font-semibold">Valor</th>
              <th className="w-72 px-2 py-2.5 text-right font-semibold">Situação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {contas.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  Nenhuma conta neste filtro. Os títulos nascem em{" "}
                  <Link to="/admin/notas-de-entrada" className="underline">
                    Notas de entrada
                  </Link>
                  , no "Gerar despesas" de cada nota, a partir das duplicatas.
                </td>
              </tr>
            ) : (
              contas.map((conta) => <Linha key={conta.id} conta={conta} hoje={hoje} />)
            )}
          </tbody>
        </table>
      </div>

      {total > limite ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Mostrando as {limite} primeiras de {total} contas. Estreite o período ou o fornecedor.
        </p>
      ) : null}
    </div>
  )
}

function Linha({ conta, hoje }: { conta: ContaAPagar; hoje: string }) {
  const fetcher = useFetcher<typeof action>()
  const [pagando, setPagando] = useState(false)
  const [dia, setDia] = useState(hoje)
  const gravando = fetcher.state !== "idle"

  const vencimento = new Date(conta.vencimento)
  const venceu = !conta.pago && vencimento.toISOString().slice(0, 10) < hoje
  const erro = fetcher.data && !fetcher.data.ok ? fetcher.data.erro : null

  return (
    <tr className={cn("align-top", conta.pago && "text-muted-foreground")}>
      <td className={cn("py-2.5 tabular-nums", venceu && "font-semibold text-destructive")}>
        {vencimento.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}
      </td>
      <td className="px-2 py-2.5 font-medium">{conta.fornecedor}</td>
      <td className="px-2 py-2.5 text-xs">{conta.descricao}</td>
      <td className="px-2 py-2.5 font-mono text-xs">{conta.loja ?? "—"}</td>
      <td className="px-2 py-2.5 text-xs">{conta.conta}</td>
      <td className="px-2 py-2.5 text-right font-medium tabular-nums">{moeda(conta.valor)}</td>
      <td className="px-2 py-2.5 text-right">
        {conta.pago ? (
          <div className="flex items-center justify-end gap-2">
            <Badge variant="secondary" className="text-[10px]">
              pago
              {conta.pagoEm
                ? ` em ${new Date(conta.pagoEm).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
                : ""}
              {conta.pagoPor ? ` · ${conta.pagoPor}` : ""}
            </Badge>
            {conta.desfazivel ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={gravando}
                title="Desfazer o pagamento marcado por engano"
                onClick={() =>
                  fetcher.submit({ intencao: "desfazer", id: conta.id }, { method: "post" })
                }
              >
                <Undo2 className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ) : pagando ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-xs text-muted-foreground">pago em</span>
            <input
              type="date"
              value={dia}
              max={hoje}
              onChange={(e) => setDia(e.target.value)}
              className={cn(ESTILO_CAMPO, "h-8 w-36")}
            />
            <Button
              type="button"
              size="xs"
              disabled={gravando || !dia}
              onClick={() =>
                fetcher.submit({ intencao: "pagar", id: conta.id, dia }, { method: "post" })
              }
            >
              {gravando ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Confirmar
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setPagando(false)}>
              Cancelar
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Badge variant={venceu ? "destructive" : "outline"} className="text-[10px]">
              {venceu ? "vencida" : "a pagar"}
            </Badge>
            <Button type="button" size="xs" variant="outline" onClick={() => setPagando(true)}>
              Marcar como paga
            </Button>
          </div>
        )}
        {erro ? <div className="mt-1 text-xs text-destructive">{erro}</div> : null}
      </td>
    </tr>
  )
}
