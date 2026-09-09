import { Link, useNavigate, useNavigation, useSearchParams } from "react-router"
import { FileText, Plus, Search } from "lucide-react"

import type { Route } from "./+types/admin.afs"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Atalho, Campo, ESTILO_CAMPO, Pagina } from "~/components/pdv/filtros"
import { PERIODO_TODO, type FiltroAfs } from "~/lib/afs"
import { consultarAfs, lerFiltroAfs } from "~/lib/afs.server"
import { diaAtras, diaDeHoje } from "~/lib/dia"
import { listarLojas } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "AFs de compra — BrasSaco" }]
}

/**
 * As entradas por AF — autorização de faturamento, o papel que chega no lugar
 * da nota quando o fornecedor não emite NF-e para a entrega.
 *
 * Tela separada da de notas de entrada de propósito: lá o trabalho é escolher
 * dentro do que a SEFAZ trouxe, e aqui é digitar o que só existe no papel. As
 * duas terminam no mesmo lugar (estoque com custo e conta a pagar), mas
 * começam em mundos diferentes.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "lancarAf")

  const filtro = lerFiltroAfs(new URL(request.url))
  const [consulta, lojas] = await Promise.all([consultarAfs(filtro), listarLojas()])

  return { filtro, lojas, ...consulta }
}

export default function AdminAfs({ loaderData }: Route.ComponentProps) {
  const { filtro, lojas, afs, total, valor, foraDoPeriodo, paginas } = loaderData

  const [params, setParams] = useSearchParams()
  const navegar = useNavigate()
  const navegacao = useNavigation()
  const consultando = navegacao.state === "loading"

  /** Muda um pedaço do filtro e volta para a primeira página. */
  function mudarFiltro(mudancas: Partial<Record<keyof FiltroAfs, string>>) {
    const proximos = new URLSearchParams(params)
    for (const [chave, valor] of Object.entries(mudancas)) {
      if (valor) proximos.set(chave, valor)
      else proximos.delete(chave)
    }
    proximos.delete("pagina")
    setParams(proximos)
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">AFs de compra</h1>
        <span className="text-xs text-muted-foreground">
          Entrada de mercadoria que chegou sem NF-e — não vem da SEFAZ, é digitada do papel
        </span>
        <Button render={<Link to="/admin/afs/nova" />} size="sm" className="ml-auto">
          <Plus className="size-4" />
          Lançar AF
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border p-3">
        <Campo rotulo="Fornecedor">
          <Input
            defaultValue={filtro.fornecedor}
            onBlur={(e) => mudarFiltro({ fornecedor: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") mudarFiltro({ fornecedor: e.currentTarget.value })
            }}
            placeholder="Todos"
            className="w-56"
          />
        </Campo>

        <Campo rotulo="Nº da AF">
          <Input
            defaultValue={filtro.numero}
            onBlur={(e) => mudarFiltro({ numero: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") mudarFiltro({ numero: e.currentTarget.value })
            }}
            className="w-28"
          />
        </Campo>

        <Campo rotulo="Loja">
          <select
            value={filtro.loja}
            onChange={(e) => mudarFiltro({ loja: e.target.value })}
            className={cn(ESTILO_CAMPO, "w-32")}
          >
            <option value="">Todas</option>
            {lojas.map((l) => (
              <option key={l.codigo} value={l.codigo}>
                {l.nome}
              </option>
            ))}
          </select>
        </Campo>

        <Campo rotulo="De">
          <input
            type="date"
            value={filtro.de === PERIODO_TODO.de ? "" : filtro.de}
            onChange={(e) => mudarFiltro({ de: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>
        <Campo rotulo="Até">
          <input
            type="date"
            value={filtro.ate === PERIODO_TODO.ate ? "" : filtro.ate}
            onChange={(e) => mudarFiltro({ ate: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>

        <div className="flex gap-1.5">
          <Atalho rotulo="30 dias" onClick={() => mudarFiltro({ de: diaAtras(30), ate: diaDeHoje() })} />
          <Atalho rotulo="90 dias" onClick={() => mudarFiltro({ de: diaAtras(90), ate: diaDeHoje() })} />
          <Atalho
            rotulo="Limpar"
            onClick={() => mudarFiltro({ fornecedor: "", numero: "", loja: "", de: "", ate: "" })}
          />
        </div>

        {consultando ? <Search className="size-4 animate-pulse text-muted-foreground" /> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground">{total}</strong> {total === 1 ? "AF" : "AFs"} ·{" "}
          {moeda(valor)}
        </span>
        {foraDoPeriodo > 0 ? (
          <span className="text-amber-600 dark:text-amber-500">
            nada no período — mas há {foraDoPeriodo} fora dele
          </span>
        ) : null}
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-muted-foreground">
              <th className="px-2 py-1.5">Fornecedor</th>
              <th className="px-2 py-1.5">Nº da AF</th>
              <th className="px-2 py-1.5">Data</th>
              <th className="px-2 py-1.5">Loja</th>
              <th className="px-2 py-1.5 text-right">Itens</th>
              <th className="px-2 py-1.5 text-right">Valor</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {afs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-muted-foreground">
                  Nenhuma AF lançada com esse filtro.
                </td>
              </tr>
            ) : (
              afs.map((af) => (
                <tr
                  key={af.id}
                  onClick={() => navegar(`/admin/afs/${af.id}`)}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-2 py-1.5">
                    {/* Âncora de verdade dentro da linha clicável: quem quiser
                        abrir em outra aba ou navegar pelo teclado consegue. */}
                    <Link to={`/admin/afs/${af.id}`} className="hover:underline">
                      {af.fornecedorNome}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5 font-mono">{af.numero}</td>
                  <td className="px-2 py-1.5">
                    {new Date(af.dataEmissao).toLocaleDateString("pt-BR")}
                  </td>
                  <td className="px-2 py-1.5">{af.loja}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{af.itens.length}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{moeda(af.total)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      {af.pedidoDeCompraNumero ? (
                        <Badge variant="secondary">pedido #{af.pedidoDeCompraNumero}</Badge>
                      ) : null}
                      {af.despesasGeradasEm ? <Badge variant="outline">a pagar</Badge> : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {paginas > 1 ? (
          <div className="flex items-center gap-3 border-t px-2 py-2 text-xs text-muted-foreground">
            <Pagina params={params} para={filtro.pagina - 1} ativa={filtro.pagina > 1}>
              ‹ Anteriores
            </Pagina>
            <span className="font-mono tabular-nums">
              página {filtro.pagina} de {paginas}
            </span>
            <Pagina params={params} para={filtro.pagina + 1} ativa={filtro.pagina < paginas}>
              Próximas ›
            </Pagina>
          </div>
        ) : null}
      </div>
    </div>
  )
}
