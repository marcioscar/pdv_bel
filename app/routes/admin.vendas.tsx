import { useEffect, useState } from "react"
import { Link, useNavigation, useSearchParams } from "react-router"
import { FileText, Receipt, Search, X } from "lucide-react"

import type { Route } from "./+types/admin.vendas"
import { Numero } from "~/components/pdv/numero"
import { ItensDaVenda, SituacaoCobrancas } from "~/components/pdv/venda-celulas"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { diaAtras, diaDeHoje, diaEmTexto, PRIMEIRO_DIA } from "~/lib/dia"
import { listarLojas } from "~/lib/lojas.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { CONDICOES_PAGAMENTO, FORMAS_PAGAMENTO } from "~/lib/pdv"
import { exigirGerente } from "~/lib/sessao.server"
import {
  consultarVendas,
  lerFiltroVendas,
  type FiltroVendas,
  type VendaConsultada,
} from "~/lib/vendas.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Vendas da rede — BrasSaco" }]
}

/**
 * A venda a venda de TODAS as lojas.
 *
 * /vendas é a tela do turno: só a loja da sessão, as cem últimas, com cancelar e
 * emitir boleto ao alcance da tecla. Esta é a do escritório — não vende nem
 * cancela nada, e em troca enxerga a rede inteira e procura no passado. As duas
 * separadas porque acumular filtro e histórico na tela do balcão é o caminho
 * mais curto para o operador demorar no cliente errado.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verVendasDaRede")

  const filtro = lerFiltroVendas(new URL(request.url), eu.lojasPermitidas)
  const [consulta, lojas] = await Promise.all([consultarVendas(filtro), listarLojas()])

  return {
    filtro,
    // Só as lojas onde ele opera: o seletor não deve nem sugerir o que a consulta
    // recusaria.
    lojas: lojas.filter((loja) => eu.lojasPermitidas.includes(loja.codigo)),
    ...consulta,
  }
}

const SITUACOES = [
  { id: "todas", rotulo: "Todas" },
  { id: "validas", rotulo: "Só válidas" },
  { id: "canceladas", rotulo: "Só canceladas" },
] as const

const ESTILO_CAMPO =
  "h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring"

export default function AdminVendas({ loaderData }: Route.ComponentProps) {
  const { filtro, lojas, vendas, total, foraDoPeriodo, paginas, resumo } = loaderData

  const [params, setParams] = useSearchParams()
  const navegacao = useNavigation()
  const consultando = navegacao.state === "loading"

  // Os campos digitados vivem em estado porque os atalhos de período os alteram;
  // o `useEffect` os traz de volta ao que a URL diz depois de cada navegação,
  // inclusive a do botão "voltar" do navegador.
  const [campos, setCampos] = useState(filtro)
  useEffect(() => setCampos(filtro), [filtro])

  const [aberta, setAberta] = useState<string | null>(null)
  const detalhe = vendas.find((venda) => venda.id === aberta) ?? null

  function aplicar(mudanca: Partial<FiltroVendas>) {
    const proximo = { ...campos, ...mudanca }
    setCampos(proximo)

    const novos = new URLSearchParams()
    novos.set("de", proximo.de)
    novos.set("ate", proximo.ate)
    if (proximo.loja !== "todas") novos.set("loja", proximo.loja)
    if (proximo.numero) novos.set("numero", proximo.numero)
    if (proximo.cliente) novos.set("cliente", proximo.cliente)
    if (proximo.forma) novos.set("forma", proximo.forma)
    if (proximo.situacao !== "todas") novos.set("situacao", proximo.situacao)
    // Filtrar sempre volta para a primeira página: a terceira página do filtro
    // anterior quase nunca existe no novo, e a tela viria vazia sem dizer por quê.
    setParams(novos)
    setAberta(null)
  }

  const tudo = () => aplicar({ de: PRIMEIRO_DIA, ate: diaDeHoje() })

  const nomeDaLoja = (codigo: string) =>
    lojas.find((loja) => loja.codigo === codigo)?.nome ?? codigo

  const periodo =
    filtro.de === filtro.ate
      ? diaEmTexto(filtro.de)
      : `${diaEmTexto(filtro.de)} a ${diaEmTexto(filtro.ate)}`

  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <Receipt className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Vendas da rede</h1>
        <span className="text-xs text-muted-foreground">
          {periodo} ·{" "}
          {filtro.loja === "todas"
            ? `${lojas.length} ${lojas.length === 1 ? "loja" : "lojas"}`
            : nomeDaLoja(filtro.loja)}
        </span>
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
          <Atalho rotulo="Ontem" onClick={() => aplicar({ de: diaAtras(1), ate: diaAtras(1) })} />
          <Atalho rotulo="7 dias" onClick={() => aplicar({ de: diaAtras(6), ate: diaDeHoje() })} />
          <Atalho rotulo="30 dias" onClick={() => aplicar({ de: diaAtras(29), ate: diaDeHoje() })} />
          <Atalho rotulo="Tudo" onClick={tudo} />
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

        <Campo rotulo="Venda nº">
          <Input
            value={campos.numero}
            inputMode="numeric"
            onChange={(e) =>
              setCampos({ ...campos, numero: e.target.value.replace(/\D/g, "") })
            }
            placeholder="1234"
            type="search"
            autoComplete="off"
            className="h-9 w-24 rounded-lg border-border bg-background font-mono tabular-nums"
          />
        </Campo>

        <Campo rotulo="Cliente">
          <Input
            value={campos.cliente}
            onChange={(e) => setCampos({ ...campos, cliente: e.target.value })}
            placeholder="Nome ou CPF/CNPJ"
            type="search"
            autoComplete="off"
            className="h-9 w-56 rounded-lg border-border bg-background"
          />
        </Campo>

        <Campo rotulo="Forma">
          <select
            value={campos.forma}
            onChange={(e) => aplicar({ forma: e.target.value })}
            className={cn(ESTILO_CAMPO, "w-32")}
          >
            <option value="">Todas</option>
            {FORMAS_PAGAMENTO.map((forma) => (
              <option key={forma.id} value={forma.id}>
                {forma.rotulo}
              </option>
            ))}
          </select>
        </Campo>

        <Campo rotulo="Situação">
          <select
            value={campos.situacao}
            onChange={(e) =>
              aplicar({ situacao: e.target.value as FiltroVendas["situacao"] })
            }
            className={cn(ESTILO_CAMPO, "w-36")}
          >
            {SITUACOES.map((situacao) => (
              <option key={situacao.id} value={situacao.id}>
                {situacao.rotulo}
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
        <Numero rotulo="Faturamento" valor={moeda(resumo.faturamento)} destaque />
        <Numero
          rotulo="Vendas"
          valor={String(resumo.vendas)}
          detalhe={total !== resumo.vendas ? `${total} na lista` : undefined}
        />
        <Numero
          rotulo="Canceladas"
          valor={String(resumo.canceladas)}
          alerta={resumo.canceladas > 0}
        />
      </div>

      <div className={cn("mt-6 grid gap-6", detalhe && "lg:grid-cols-[1fr_22rem]")}>
        <div className="min-w-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="w-20 py-2.5 text-left font-semibold">Venda</th>
                  <th scope="col" className="w-16 px-2 py-2.5 text-left font-semibold">Loja</th>
                  <th scope="col" className="w-36 px-2 py-2.5 text-left font-semibold">Quando</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Cliente</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Itens</th>
                  <th scope="col" className="w-20 px-2 py-2.5 text-left font-semibold">Forma</th>
                  <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">Total</th>
                  <th scope="col" className="w-40 px-2 py-2.5 text-left font-semibold">Pagamento</th>
                </tr>
              </thead>
              <tbody className={cn(consultando && "opacity-50")}>
                {vendas.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-16 text-center">
                      <Receipt
                        className="mx-auto size-10 text-muted-foreground/40"
                        aria-hidden
                      />
                      <p className="mt-3 text-sm text-muted-foreground">
                        Nenhuma venda em {periodo}
                        {filtro.loja === "todas" ? "" : ` na ${nomeDaLoja(filtro.loja)}`}.
                      </p>
                      {foraDoPeriodo > 0 ? (
                        <>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {foraDoPeriodo}{" "}
                            {foraDoPeriodo === 1
                              ? "venda casa com a busca fora deste período"
                              : "vendas casam com a busca fora deste período"}
                            .
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={tudo}
                            className="mt-3 rounded-lg"
                          >
                            Procurar em todo o histórico
                          </Button>
                        </>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Amplie o período ou limpe os filtros acima.
                        </p>
                      )}
                    </td>
                  </tr>
                ) : (
                  vendas.map((venda) => {
                    const cancelada = Boolean(venda.canceladaEm)
                    const selecionada = venda.id === aberta
                    return (
                      <tr
                        key={venda.id}
                        onClick={() => setAberta(selecionada ? null : venda.id)}
                        aria-current={selecionada ? "true" : undefined}
                        className={cn(
                          "cursor-pointer border-b border-border transition-colors",
                          selecionada
                            ? "bg-accent shadow-[inset_3px_0_0_var(--primary)]"
                            : "hover:bg-muted/40",
                          cancelada && "opacity-60"
                        )}
                      >
                        <td className="py-2.5 pl-3 font-mono font-semibold tabular-nums">
                          #{venda.numero}
                        </td>
                        <td className="px-2 py-2.5">
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {venda.loja}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                          {new Date(venda.criadaEm).toLocaleString("pt-BR", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </td>
                        <td className="max-w-[14rem] px-2 py-2.5">
                          {venda.clienteNome ? (
                            <span className="truncate text-xs">{venda.clienteNome}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Consumidor Final
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <ItensDaVenda itens={venda.itens} />
                        </td>
                        <td className="px-2 py-2.5 text-xs">
                          {FORMAS_PAGAMENTO.find((f) => f.id === venda.forma)?.rotulo ??
                            venda.forma}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right font-mono font-medium tabular-nums",
                            cancelada && "line-through"
                          )}
                        >
                          {moeda(venda.total)}
                        </td>
                        <td className="px-2 py-2.5">
                          <Pagamento venda={venda} />
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {paginas > 1 ? (
            <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
              <Pagina params={params} para={filtro.pagina - 1} ativa={filtro.pagina > 1}>
                ‹ Anteriores
              </Pagina>
              <span className="font-mono tabular-nums">
                página {filtro.pagina} de {paginas} · {total} vendas
              </span>
              <Pagina
                params={params}
                para={filtro.pagina + 1}
                ativa={filtro.pagina < paginas}
              >
                Próximas ›
              </Pagina>
            </div>
          ) : total > 0 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              {total} {total === 1 ? "venda" : "vendas"} no filtro · clique numa linha
              para ver o detalhe
            </p>
          ) : null}
        </div>

        {detalhe ? (
          <Detalhe
            venda={detalhe}
            loja={nomeDaLoja(detalhe.loja)}
            onFechar={() => setAberta(null)}
          />
        ) : null}
      </div>
    </div>
  )
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </span>
      {children}
    </label>
  )
}

function Atalho({ rotulo, onClick }: { rotulo: string; onClick: () => void }) {
  return (
    <Button type="button" size="sm" variant="outline" onClick={onClick} className="rounded-lg">
      {rotulo}
    </Button>
  )
}

function Pagina({
  params,
  para,
  ativa,
  children,
}: {
  params: URLSearchParams
  para: number
  ativa: boolean
  children: React.ReactNode
}) {
  if (!ativa) {
    return <span className="text-muted-foreground/40">{children}</span>
  }
  // Preserva o filtro inteiro e troca só a página — montar a URL do zero perderia
  // o período e traria a página 2 de outra consulta.
  const proximos = new URLSearchParams(params)
  proximos.set("pagina", String(para))
  return (
    <Link to={{ search: `?${proximos}` }} className="underline">
      {children}
    </Link>
  )
}

/**
 * Distingue pagamento CONFIRMADO pelo banco de pagamento apenas declarado no
 * caixa. Sem isso, uma venda em Pix verificada fica igual a uma só marcada como Pix.
 */
function Pagamento({ venda }: { venda: VendaConsultada }) {
  if (venda.forma === "pix") {
    return venda.pixPagoEm ? (
      <span className="flex items-center gap-1.5">
        <Badge className="text-[10px]">pago</Badge>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {new Date(venda.pixPagoEm).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </span>
    ) : (
      <span
        className="text-xs text-muted-foreground"
        title="Registrada como Pix sem confirmação do banco"
      >
        não confirmado
      </span>
    )
  }

  if (venda.forma !== "prazo") {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  return <SituacaoCobrancas cobrancas={venda.cobrancas} />
}

function Detalhe({
  venda,
  loja,
  onFechar,
}: {
  venda: VendaConsultada
  loja: string
  onFechar: () => void
}) {
  const forma = FORMAS_PAGAMENTO.find((f) => f.id === venda.forma)?.rotulo ?? venda.forma
  const condicao = CONDICOES_PAGAMENTO.find((c) => c.id === venda.condicao)

  return (
    <aside className="h-fit rounded-xl border border-border p-4 lg:sticky lg:top-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-mono text-base font-semibold">#{venda.numero}</h2>
          <p className="text-xs text-muted-foreground">
            {loja} · {new Date(venda.criadaEm).toLocaleString("pt-BR")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onFechar}
          aria-label="Fechar detalhe"
          className="rounded-lg"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {venda.canceladaEm ? (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Cancelada em {new Date(venda.canceladaEm).toLocaleString("pt-BR")}
          {venda.canceladaPor ? ` por ${venda.canceladaPor}` : ""} — os itens voltaram
          para o estoque.
        </p>
      ) : null}

      <dl className="mt-3 space-y-1 text-xs">
        <Linha rotulo="Operador" valor={venda.operador} />
        <Linha rotulo="Caixa" valor={venda.caixa} />
        <Linha
          rotulo="Cliente"
          valor={venda.clienteNome ?? "Consumidor Final"}
          detalhe={venda.clienteCpfCnpj ?? undefined}
        />
        <Linha rotulo="Forma" valor={condicao ? `${forma} · ${condicao.rotulo}` : forma} />
      </dl>

      <h3 className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {venda.itens.length} {venda.itens.length === 1 ? "item" : "itens"}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {venda.itens.map((item, i) => (
          <li key={i} className="flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0">
              <span className="font-mono text-muted-foreground">{item.codigo}</span>{" "}
              <span className="break-words">{item.descricao}</span>
              <span className="block font-mono text-[11px] text-muted-foreground tabular-nums">
                {formatarQuantidade(item.quantidade)} {item.unidade} × {moeda(item.preco)}
              </span>
            </span>
            <span className="shrink-0 font-mono tabular-nums">{moeda(item.subtotal)}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-4 space-y-1 border-t border-border pt-3 text-xs">
        <Linha rotulo="Subtotal" valor={moeda(venda.subtotal)} />
        {venda.desconto > 0 ? (
          <Linha rotulo="Desconto" valor={`− ${moeda(venda.desconto)}`} />
        ) : null}
        {venda.recebido !== null ? (
          <>
            <Linha rotulo="Recebido" valor={moeda(venda.recebido)} />
            <Linha rotulo="Troco" valor={moeda(venda.troco ?? 0)} />
          </>
        ) : null}
      </dl>
      <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Total
        </span>
        <span className="font-mono text-lg font-bold tabular-nums">
          {moeda(venda.total)}
        </span>
      </div>

      {venda.cobrancas.length > 0 ? (
        <>
          <h3 className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {venda.cobrancas.length === 1
              ? "Boleto"
              : `${venda.cobrancas.length} parcelas`}
          </h3>
          <ul className="mt-2 space-y-1.5">
            {venda.cobrancas.map((cobranca) => (
              <li
                key={cobranca.parcela}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <a
                  href={`/vendas/${venda.id}/boleto.pdf?parcela=${cobranca.parcela}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 underline"
                >
                  <FileText className="size-3.5 shrink-0" aria-hidden />
                  {cobranca.parcela}/{cobranca.parcelas} ·{" "}
                  {new Date(cobranca.vencimento).toLocaleDateString("pt-BR")}
                </a>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono tabular-nums">{moeda(cobranca.valor)}</span>
                  <Badge
                    variant={cobranca.situacao === "RECEBIDO" ? "default" : "secondary"}
                    className="font-mono text-[10px]"
                  >
                    {cobranca.situacao}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <a
        href={`/vendas/${venda.id}/cupom`}
        target="_blank"
        rel="noreferrer"
        className="mt-4 flex items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs hover:bg-muted/40"
      >
        <Receipt className="size-3.5" aria-hidden /> Abrir cupom
      </a>
    </aside>
  )
}

function Linha({
  rotulo,
  valor,
  detalhe,
}: {
  rotulo: string
  valor: string
  detalhe?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{rotulo}</dt>
      <dd className="min-w-0 truncate text-right">
        {valor}
        {detalhe ? (
          <span className="block font-mono text-[11px] text-muted-foreground">
            {detalhe}
          </span>
        ) : null}
      </dd>
    </div>
  )
}

