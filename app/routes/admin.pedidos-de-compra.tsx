import { useEffect, useState } from "react"
import { data, Link, useFetcher, useNavigation, useSearchParams } from "react-router"
import { ClipboardList, GitCompare, Printer, Search, ShoppingBag } from "lucide-react"

import type { Route } from "./+types/admin.pedidos-de-compra"
import { Atalho, Campo, ESTILO_CAMPO, Pagina } from "~/components/pdv/filtros"
import { Numero } from "~/components/pdv/numero"
import { ReceberPedido } from "~/components/pdv/pedido-compra"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { diaAdiante, diaAtras, diaDeHoje, diaEmTexto } from "~/lib/dia"
import { moeda } from "~/lib/moeda"
import {
  PERIODO_TODO,
  SITUACOES_PEDIDO,
  rotuloDaSituacaoPedido,
  type FiltroPedidos,
  type SituacaoPedido,
} from "~/lib/pedidos-compra"
import {
  aplicarSituacao,
  consultarPedidos,
  lerFiltroPedidos,
  type PedidoDaConsulta,
} from "~/lib/pedidos-compra.server"
import { listarLojas } from "~/lib/lojas.server"
import { pedidosComNotaDisponivel } from "~/lib/conciliacao.server"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Pedidos de compra — BrasSaco" }]
}

/**
 * Todo pedido de compra, com filtro — o histórico completo, ao contrário dos
 * "recentes" na própria tela de Compras, que existem só para o gerente
 * conferir o que acabou de gerar sem sair da tela.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const filtro = lerFiltroPedidos(new URL(request.url))
  const [consulta, lojas] = await Promise.all([consultarPedidos(filtro), listarLojas()])
  const comNota = await pedidosComNotaDisponivel(consulta.pedidos)

  return {
    filtro,
    lojas: lojas.map((l) => l.codigo),
    pedidosComNota: [...comNota],
    ...consulta,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "verRelatorios")
  const form = await request.formData()

  const resultado = await aplicarSituacao(form, eu.nome)
  const loja = String(form.get("loja") ?? "")
  const passo = String(form.get("passo") ?? "")

  return resultado.ok
    ? {
        ok: true as const,
        mensagem: passo === "receber" ? `Estoque de ${loja} atualizado` : "Atualizado",
      }
    : data({ ok: false as const, erro: resultado.erro }, { status: 400 })
}

export default function AdminPedidosDeCompra({ loaderData }: Route.ComponentProps) {
  const { filtro, lojas, pedidos, pedidosComNota, total, foraDoPeriodo, paginas, resumo } = loaderData

  const [params, setParams] = useSearchParams()
  const navegacao = useNavigation()
  const consultando = navegacao.state === "loading"

  const [campos, setCampos] = useState(filtro)
  useEffect(() => setCampos(filtro), [filtro])

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  function aplicar(mudanca: Partial<FiltroPedidos>) {
    const proximo = { ...campos, ...mudanca }
    setCampos(proximo)

    const novos = new URLSearchParams()
    novos.set("de", proximo.de)
    novos.set("ate", proximo.ate)
    if (proximo.numero) novos.set("numero", proximo.numero)
    if (proximo.fornecedor) novos.set("fornecedor", proximo.fornecedor)
    if (proximo.situacao !== "todas") novos.set("situacao", proximo.situacao)
    setParams(novos)
  }

  const tudo = () => aplicar(PERIODO_TODO)

  function mudarSituacao(id: string, passo: "enviar" | "cancelar") {
    fetcher.submit({ intencao: "situacao", id, passo }, { method: "post" })
  }
  function receberPedido(id: string, loja: string) {
    fetcher.submit({ intencao: "situacao", id, passo: "receber", loja }, { method: "post" })
  }

  const periodo =
    filtro.de === filtro.ate
      ? diaEmTexto(filtro.de)
      : `${diaEmTexto(filtro.de)} a ${diaEmTexto(filtro.ate)}`

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <ClipboardList className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Pedidos de compra</h1>
        <span className="text-xs text-muted-foreground">gerados entre {periodo}</span>

        <Link
          to="/admin/pedido-novo"
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-accent"
        >
          <ShoppingBag className="size-3.5" aria-hidden />
          Novo pedido
        </Link>
      </div>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(evento) => {
          evento.preventDefault()
          aplicar({})
        }}
      >
        <Campo rotulo="De">
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
          <Atalho rotulo="Hoje" onClick={() => aplicar({ de: diaDeHoje(), ate: diaDeHoje() })} />
          <Atalho
            rotulo="7 dias"
            onClick={() => aplicar({ de: diaAtras(6), ate: diaDeHoje() })}
          />
          <Atalho
            rotulo="30 dias"
            onClick={() => aplicar({ de: diaAtras(29), ate: diaDeHoje() })}
          />
          <Atalho rotulo="Tudo" onClick={tudo} />
        </div>

        <Campo rotulo="Pedido nº">
          <Input
            value={campos.numero}
            inputMode="numeric"
            onChange={(e) =>
              setCampos({ ...campos, numero: e.target.value.replace(/\D/g, "") })
            }
            placeholder="12"
            type="search"
            autoComplete="off"
            className="h-9 w-20 rounded-lg border-border bg-background font-mono tabular-nums"
          />
        </Campo>

        <Campo rotulo="Fornecedor">
          <Input
            value={campos.fornecedor}
            onChange={(e) => setCampos({ ...campos, fornecedor: e.target.value })}
            placeholder="Nome"
            type="search"
            autoComplete="off"
            className="h-9 w-48 rounded-lg border-border bg-background"
          />
        </Campo>

        <Campo rotulo="Situação">
          <select
            value={campos.situacao}
            onChange={(e) => aplicar({ situacao: e.target.value as SituacaoPedido })}
            className={cn(ESTILO_CAMPO, "w-32")}
          >
            {SITUACOES_PEDIDO.map((s) => (
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
          rotulo="Em aberto"
          valor={moeda(resumo.aberto)}
          detalhe={`${resumo.abertoQuantidade} ${resumo.abertoQuantidade === 1 ? "pedido" : "pedidos"} rascunho ou enviado`}
          destaque
        />
        <Numero
          rotulo="Recebido"
          valor={moeda(resumo.recebido)}
          detalhe={`${resumo.recebidoQuantidade} ${resumo.recebidoQuantidade === 1 ? "pedido" : "pedidos"}`}
        />
        <Numero
          rotulo="Cancelado"
          valor={moeda(resumo.cancelado)}
          detalhe={`${resumo.canceladoQuantidade} ${resumo.canceladoQuantidade === 1 ? "pedido" : "pedidos"}`}
        />
      </div>

      {fetcher.data && !fetcher.data.ok ? (
        <p role="alert" className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {fetcher.data.erro}
        </p>
      ) : null}

      <div className={cn("mt-6", consultando && "opacity-50")}>
        {pedidos.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-16 text-center">
            <ClipboardList className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum pedido gerado entre {periodo}
              {filtro.fornecedor ? ` com "${filtro.fornecedor}"` : ""}.
            </p>
            {foraDoPeriodo > 0 ? (
              <>
                <p className="mt-1 text-xs text-muted-foreground">
                  {foraDoPeriodo}{" "}
                  {foraDoPeriodo === 1
                    ? "pedido casa com a busca fora deste período"
                    : "pedidos casam com a busca fora deste período"}
                  .
                </p>
                <Button type="button" size="sm" variant="outline" onClick={tudo} className="mt-3 rounded-lg">
                  Procurar em todo o histórico
                </Button>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Amplie o período ou limpe os filtros acima.
              </p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {pedidos.map((p) => (
              <LinhaPedido
                key={p.id}
                pedido={p}
                lojas={lojas}
                gravando={gravando}
                temNota={pedidosComNota.includes(p.id)}
                onMudarSituacao={mudarSituacao}
                onReceber={receberPedido}
              />
            ))}
          </ul>
        )}
      </div>

      {paginas > 1 ? (
        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          <Pagina params={params} para={filtro.pagina - 1} ativa={filtro.pagina > 1}>
            ‹ Anteriores
          </Pagina>
          <span className="font-mono tabular-nums">
            página {filtro.pagina} de {paginas} · {total} pedidos
          </span>
          <Pagina params={params} para={filtro.pagina + 1} ativa={filtro.pagina < paginas}>
            Próximos ›
          </Pagina>
        </div>
      ) : total > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {total} {total === 1 ? "pedido" : "pedidos"} no filtro
        </p>
      ) : null}
    </div>
  )
}

function LinhaPedido({
  pedido: p,
  lojas,
  gravando,
  temNota,
  onMudarSituacao,
  onReceber,
}: {
  pedido: PedidoDaConsulta
  lojas: string[]
  gravando: boolean
  temNota: boolean
  onMudarSituacao: (id: string, passo: "enviar" | "cancelar") => void
  onReceber: (id: string, loja: string) => void
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <span className="font-mono text-sm font-semibold tabular-nums">#{p.numero}</span>
      <span className="text-sm">{p.fornecedorNome}</span>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">{moeda(p.total)}</span>
      <span className="text-xs text-muted-foreground">
        {p.itens.length} {p.itens.length === 1 ? "item" : "itens"} ·{" "}
        {new Date(p.criadoEm).toLocaleDateString("pt-BR")} · {p.criadoPor}
      </span>
      <Badge variant={p.situacao === "cancelado" ? "destructive" : "outline"} className="text-[10px]">
        {rotuloDaSituacaoPedido(p.situacao)}
      </Badge>
      {p.situacao === "recebido" && p.recebidoEm ? (
        <span className="text-[11px] text-muted-foreground">
          recebido {new Date(p.recebidoEm).toLocaleDateString("pt-BR")}
          {p.recebidoPor ? ` por ${p.recebidoPor}` : ""}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        <a
          href={`/pedidos-de-compra/${p.id}/impressao`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Printer className="size-3.5" aria-hidden />
          Imprimir
        </a>
        {p.situacao === "enviado" || p.situacao === "parcial" || p.situacao === "recebido" ? (
          <Link
            to={`/admin/pedidos-de-compra/${p.id}/conciliacao`}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <GitCompare className="size-3.5" aria-hidden />
            Conciliar NF
          </Link>
        ) : null}
        {p.situacao === "rascunho" ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={gravando}
              onClick={() => onMudarSituacao(p.id, "enviar")}
            >
              Enviado
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={gravando}
              onClick={() => onMudarSituacao(p.id, "cancelar")}
              className="text-destructive"
            >
              Cancelar
            </Button>
          </>
        ) : null}
        {p.situacao === "enviado" ? (
          temNota ? (
            <span
              className="text-xs text-muted-foreground"
              title="Já tem nota do fornecedor sincronizada — receba pela conciliação, com quantidade e custo reais"
            >
              receber pela conciliação →
            </span>
          ) : (
            <ReceberPedido lojas={lojas} gravando={gravando} onReceber={(loja) => onReceber(p.id, loja)} />
          )
        ) : null}
      </div>
    </li>
  )
}
