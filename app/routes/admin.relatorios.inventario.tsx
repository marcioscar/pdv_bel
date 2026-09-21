import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { Boxes, Layers, Search, TriangleAlert } from "lucide-react"

import type { Route } from "./+types/admin.relatorios.inventario"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { inventarioValorizado } from "~/lib/inventario.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Inventário de estoque — BrasSaco" }]
}

/**
 * O que existe na prateleira, e quanto vale.
 *
 * Duas moedas na mesma tela, de propósito: o valor de CUSTO é o que a mercadoria
 * custou (é o número do contador e o do capital parado), e o valor de VENDA é o
 * que ela vai render. A diferença entre os dois é a margem embutida no estoque,
 * e é ela que responde se vale a pena comprar mais ou esvaziar o que está lá.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verRelatorios")

  // Uma loja por padrão, como no relatório de faturamento. `?loja=rede`
  // consolida, e só quem tem mais de uma pode pedir.
  const pedido = new URL(request.url).searchParams.get("loja")
  const rede = pedido === "rede" && eu.lojasPermitidas.length > 1
  const escolhida =
    pedido && pedido !== "rede" && eu.lojasPermitidas.includes(pedido) ? pedido : eu.loja

  const lojas = rede ? eu.lojasPermitidas : [escolhida]

  return {
    inventario: await inventarioValorizado(lojas),
    rede,
    escolhida,
    lojasPermitidas: eu.lojasPermitidas,
  }
}

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

export default function RelatorioInventario({ loaderData }: Route.ComponentProps) {
  const { inventario, rede, escolhida, lojasPermitidas } = loaderData
  const { linhas, lojas, totais } = inventario

  const [, setParams] = useSearchParams()
  const [busca, setBusca] = useState("")
  const [grupo, setGrupo] = useState("todos")
  const [soNegativos, setSoNegativos] = useState(false)
  const [vista, setVista] = useState<"lista" | "resumo">("lista")

  const grupos = useMemo(() => {
    const nomes = new Set<string>()
    for (const l of linhas) if (l.grupoNome) nomes.add(l.grupoNome)
    return [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR"))
  }, [linhas])

  const filtradas = useMemo(() => {
    const termo = normalizar(busca.trim())
    return linhas.filter((l) => {
      if (soNegativos && l.quantidade >= 0) return false
      if (grupo !== "todos" && (l.grupoNome ?? "") !== grupo) return false
      if (!termo) return true
      return normalizar(l.descricao).includes(termo) || l.codigo.includes(busca.trim())
    })
  }, [busca, grupo, linhas, soNegativos])

  const custoFiltrado = filtradas.reduce((s, l) => s + (l.valorCusto ?? 0), 0)
  const vendaFiltrada = filtradas.reduce((s, l) => s + l.valorVenda, 0)

  /*
   * Os dois recortes do resumo. Saem das linhas JÁ filtradas: com "Copos"
   * escolhido, o resumo é de Copos — senão o total do resumo brigaria com o
   * total da barra de filtros logo acima, e ninguém saberia qual acreditar.
   *
   * O valor por loja NÃO pode sair de `valorCusto`, que é o da rede toda: é o
   * saldo daquela loja vezes o custo. Usar o total repetiria o mesmo número em
   * cada coluna e somaria quatro vezes o estoque.
   */
  const porGrupo = useMemo(() => {
    const mapa = new Map<
      string,
      { nome: string; itens: number; unidades: number; custo: number; venda: number }
    >()
    for (const l of filtradas) {
      const nome = l.grupoNome ?? "Sem grupo"
      const atual = mapa.get(nome) ?? { nome, itens: 0, unidades: 0, custo: 0, venda: 0 }
      atual.itens += 1
      atual.unidades += l.quantidade
      atual.custo += l.valorCusto ?? 0
      atual.venda += l.valorVenda
      mapa.set(nome, atual)
    }
    return [...mapa.values()].sort((a, b) => b.custo - a.custo || b.venda - a.venda)
  }, [filtradas])

  const porLoja = useMemo(
    () =>
      lojas.map((loja) => {
        let itens = 0
        let unidades = 0
        let custo = 0
        let venda = 0
        for (const l of filtradas) {
          const saldo = l.porLoja[loja] ?? 0
          if (saldo === 0) continue
          itens += 1
          unidades += saldo
          custo += saldo * (l.custo ?? 0)
          venda += saldo * l.preco
        }
        return { loja, itens, unidades, custo, venda }
      }),
    [filtradas, lojas]
  )

  /** A margem que está dormindo na prateleira. Só sobre o que tem custo. */
  const vendaComCusto = filtradas
    .filter((l) => l.valorCusto !== null)
    .reduce((s, l) => s + l.valorVenda, 0)
  const margem = vendaComCusto > 0 ? ((vendaComCusto - custoFiltrado) / vendaComCusto) * 100 : null

  function trocarLoja(valor: string) {
    setParams((atuais) => {
      const novos = new URLSearchParams(atuais)
      novos.set("loja", valor)
      return novos
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:gap-3 sm:px-5">
        <Boxes className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Inventário de estoque</h1>

        <div className="flex gap-1">
          {lojasPermitidas.map((l) => (
            <Button
              key={l}
              type="button"
              size="xs"
              variant={!rede && escolhida === l ? "secondary" : "ghost"}
              onClick={() => trocarLoja(l)}
              className="rounded-lg font-mono"
            >
              {l}
            </Button>
          ))}
          {lojasPermitidas.length > 1 ? (
            <Button
              type="button"
              size="xs"
              variant={rede ? "secondary" : "ghost"}
              onClick={() => trocarLoja("rede")}
              className="rounded-lg"
            >
              Rede
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---- Os números grandes ---- */}
        <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-2 lg:grid-cols-4 sm:px-5">
          <Numero
            rotulo="Valor de custo"
            valor={moeda(totais.valorCusto)}
            apoio={`${totais.itens.toLocaleString("pt-BR")} itens · ${formatarQuantidade(totais.unidades)} unidades`}
          />
          <Numero
            rotulo="Valor de venda"
            valor={moeda(totais.valorVenda)}
            apoio="se tudo sair pelo preço de hoje"
          />
          <Numero
            rotulo="Margem embutida"
            valor={margem === null ? "—" : `${margem.toFixed(1)}%`}
            apoio="o que a prateleira rende sobre o que custou"
          />
          <Numero
            rotulo="Sem custo conhecido"
            valor={totais.semCusto.toLocaleString("pt-BR")}
            apoio={
              totais.semCusto > 0
                ? `${moeda(totais.semCustoValorVenda)} a preço de venda, fora do custo`
                : "todo item com saldo tem custo"
            }
            alerta={totais.semCusto > 0}
          />
        </div>

        {/* ---- Filtros ---- */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5">
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            type="search"
            placeholder="Buscar por código ou descrição…"
            aria-label="Buscar produto no inventário"
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full min-w-0 rounded-lg sm:max-w-xs"
          />

          <select
            value={grupo}
            onChange={(e) => setGrupo(e.target.value)}
            aria-label="Filtrar por grupo"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
          >
            <option value="todos">Todos os grupos</option>
            {grupos.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>

          {totais.negativos > 0 ? (
            <Button
              type="button"
              size="xs"
              variant={soNegativos ? "secondary" : "ghost"}
              onClick={() => setSoNegativos((v) => !v)}
              className="rounded-lg"
            >
              <TriangleAlert className="size-3.5" />
              {totais.negativos} negativo{totais.negativos === 1 ? "" : "s"}
            </Button>
          ) : null}

          <div className="flex gap-1">
            <Button
              type="button"
              size="xs"
              variant={vista === "lista" ? "secondary" : "ghost"}
              onClick={() => setVista("lista")}
              className="rounded-lg"
            >
              Lista
            </Button>
            <Button
              type="button"
              size="xs"
              variant={vista === "resumo" ? "secondary" : "ghost"}
              onClick={() => setVista("resumo")}
              className="rounded-lg"
            >
              <Layers className="size-3.5" />
              Resumo
            </Button>
          </div>

          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {filtradas.length.toLocaleString("pt-BR")} linha
            {filtradas.length === 1 ? "" : "s"} · {moeda(custoFiltrado)} de custo ·{" "}
            {moeda(vendaFiltrada)} de venda
          </span>
        </div>

        {filtradas.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Search className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
            <p className="mt-3 text-sm text-muted-foreground">
              Nada encontrado com esses filtros.
            </p>
          </div>
        ) : vista === "resumo" ? (
          <div className="grid gap-4 px-4 py-4 lg:grid-cols-2 sm:px-5">
            <Agrupado
              titulo="Por grupo"
              apoio="onde o dinheiro está parado, por gaveta do catálogo"
              coluna="Grupo"
              linhas={porGrupo.map((g) => ({
                chave: g.nome,
                rotulo: g.nome,
                itens: g.itens,
                unidades: g.unidades,
                custo: g.custo,
                venda: g.venda,
              }))}
              total={custoFiltrado}
            />
            <Agrupado
              titulo="Por loja"
              apoio={
                rede
                  ? "o mesmo estoque, repartido pela prateleira de cada uma"
                  : "só a loja escolhida acima — use Rede para comparar"
              }
              coluna="Loja"
              mono
              linhas={porLoja.map((l) => ({
                chave: l.loja,
                rotulo: l.loja,
                itens: l.itens,
                unidades: l.unidades,
                custo: l.custo,
                venda: l.venda,
              }))}
              total={porLoja.reduce((s, l) => s + l.custo, 0)}
            />
          </div>
        ) : (
          /* Rolagem horizontal própria: com as quatro lojas abertas a tabela
             passa da largura da tela, e sem isto a última coluna — que é
             justamente o valor de venda — ficava cortada fora do papel. */
          <div className="overflow-x-auto">
          <table className="w-full min-w-[62rem] text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="w-20 px-4 py-2 font-semibold sm:px-5">
                  Código
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Descrição
                </th>
                <th scope="col" className="w-36 px-2 py-2 font-semibold">
                  Grupo
                </th>
                {/* Na rede, onde está a mercadoria é metade da resposta: o mesmo
                    total pode ser um monte parado numa loja só. */}
                {rede
                  ? lojas.map((l) => (
                      <th
                        key={l}
                        scope="col"
                        className="w-16 px-1 py-2 text-right font-mono font-semibold"
                      >
                        {l}
                      </th>
                    ))
                  : null}
                <th scope="col" className="w-20 px-2 py-2 text-right font-semibold">
                  Saldo
                </th>
                <th scope="col" className="w-20 px-2 py-2 text-right font-semibold">
                  Custo
                </th>
                <th scope="col" className="w-28 px-2 py-2 text-right font-semibold">
                  Valor custo
                </th>
                <th scope="col" className="w-28 px-4 py-2 text-right font-semibold sm:px-5">
                  Valor venda
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtradas.map((l) => (
                <tr
                  key={l.produtoId}
                  className={cn("hover:bg-accent/40", !l.ativo && "opacity-60")}
                >
                  <td className="px-4 py-1.5 font-mono text-[10px] text-muted-foreground sm:px-5">
                    {l.codigo}
                  </td>
                  <td className="max-w-[16rem] truncate px-2 py-1.5" title={l.descricao}>
                    {/* A ficha do produto é a resposta para "por que este saldo?" */}
                    <Link
                      to={`/admin/ficha?produto=${l.produtoId}`}
                      className="underline decoration-dotted decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground"
                    >
                      {l.descricao}
                    </Link>
                    {!l.ativo ? (
                      <Badge variant="destructive" className="ml-1.5 text-[9px]">
                        inativo
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    {l.grupoNome ?? "—"}
                  </td>
                  {rede
                    ? lojas.map((loja) => (
                        <td
                          key={loja}
                          className={cn(
                            "px-1 py-1.5 text-right text-[11px]",
                            l.porLoja[loja] < 0
                              ? "text-destructive"
                              : l.porLoja[loja] === 0
                                ? "text-muted-foreground/40"
                                : "text-muted-foreground"
                          )}
                        >
                          {l.porLoja[loja] === 0 ? "—" : formatarQuantidade(l.porLoja[loja])}
                        </td>
                      ))
                    : null}
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right font-medium",
                      l.quantidade < 0 && "text-destructive"
                    )}
                  >
                    {formatarQuantidade(l.quantidade)}{" "}
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {l.unidade}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">
                    {l.custo === null ? "—" : moeda(l.custo)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium">
                    {l.valorCusto === null ? (
                      <span className="text-muted-foreground/50">—</span>
                    ) : (
                      moeda(l.valorCusto)
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right font-medium sm:px-5">
                    {moeda(l.valorVenda)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {/*
          O que o número NÃO é. Um total de estoque tem cara de número contábil,
          e este não é: sai do último preço de compra, não do custo médio.
        */}
        <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          O saldo é somado do livro de movimentos — a mesma conta da ficha de estoque, sem
          saldo guardado em lugar nenhum. O custo é o da ÚLTIMA compra de cada produto, não
          um custo médio: num período de reajuste isso avalia mercadoria velha a preço novo.
          {totais.semCusto > 0 ? (
            <>
              {" "}
              {totais.semCusto} produto{totais.semCusto === 1 ? "" : "s"} com saldo nunca
              {totais.semCusto === 1 ? " foi comprado" : " foram comprados"} por aqui e
              {totais.semCusto === 1 ? " fica" : " ficam"} fora do valor de custo — entrar
              como zero somaria como se a mercadoria fosse de graça.
            </>
          ) : null}{" "}
          {totais.zerados.toLocaleString("pt-BR")} produto
          {totais.zerados === 1 ? "" : "s"} do catálogo {totais.zerados === 1 ? "está" : "estão"}{" "}
          com saldo zero e não {totais.zerados === 1 ? "aparece" : "aparecem"} na lista.
        </p>
      </div>
    </div>
  )
}

/**
 * Um recorte do inventário somado — por grupo ou por loja.
 *
 * A barra de participação é do valor de CUSTO, e não do de venda: a pergunta
 * do inventário é quanto capital está parado ali, e quem responde isso é o que
 * a mercadoria custou.
 */
function Agrupado({
  titulo,
  apoio,
  coluna,
  linhas,
  total,
  mono,
}: {
  titulo: string
  apoio: string
  coluna: string
  linhas: {
    chave: string
    rotulo: string
    itens: number
    unidades: number
    custo: number
    venda: number
  }[]
  total: number
  mono?: boolean
}) {
  return (
    <div className="rounded-xl border border-border">
      <div className="border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{titulo}</h2>
        <p className="text-[11px] text-muted-foreground">{apoio}</p>
      </div>

      <div className="max-h-[28rem] overflow-y-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-semibold">
                {coluna}
              </th>
              <th scope="col" className="w-16 px-2 py-2 text-right font-semibold">
                Itens
              </th>
              <th scope="col" className="w-24 px-2 py-2 text-right font-semibold">
                Unidades
              </th>
              <th scope="col" className="w-28 px-2 py-2 text-right font-semibold">
                Custo
              </th>
              <th scope="col" className="w-28 px-4 py-2 text-right font-semibold">
                Venda
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {linhas.map((l) => (
              <tr key={l.chave}>
                <td className="px-4 py-1.5">
                  <div className={cn("truncate", mono && "font-mono")} title={l.rotulo}>
                    {l.rotulo}
                  </div>
                  {/* A barra é a leitura rápida: qual gaveta come o capital. */}
                  <div className="mt-1 h-1 w-full rounded-full bg-muted">
                    <div
                      className="h-1 rounded-full bg-primary"
                      style={{ width: `${total > 0 ? (l.custo / total) * 100 : 0}%` }}
                    />
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">{l.itens}</td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">
                  {formatarQuantidade(l.unidades)}
                </td>
                <td className="px-2 py-1.5 text-right font-medium">
                  {moeda(l.custo)}
                  <div className="text-[10px] font-normal text-muted-foreground">
                    {total > 0 ? ((l.custo / total) * 100).toFixed(1) : "0,0"}%
                  </div>
                </td>
                <td className="px-4 py-1.5 text-right text-muted-foreground">
                  {moeda(l.venda)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  apoio,
  alerta,
}: {
  rotulo: string
  valor: string
  apoio: string
  alerta?: boolean
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3",
        alerta ? "border-amber-500/40 bg-amber-500/5" : "border-border"
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
