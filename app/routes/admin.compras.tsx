import { useMemo, useState } from "react"
import { ShoppingCart } from "lucide-react"

import type { Route } from "./+types/admin.compras"
import { Badge } from "~/components/ui/badge"
import { Input } from "~/components/ui/input"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { cn } from "~/lib/utils"
import { exigirGerente } from "~/lib/sessao.server"
import { listaDeCompra, origemDaPolitica, type LinhaDeCompra } from "~/lib/compras.server"
import {
  DIAS_DE_COBERTURA,
  DIAS_DE_ENTREGA,
  DIAS_DE_SEGURANCA,
  ROTULOS_DE_URGENCIA,
  type Urgencia,
} from "~/lib/compras"
import { listarLojas } from "~/lib/lojas.server"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Compras — BrasSaco" }]
}

/**
 * O que comprar, para a rede toda.
 *
 * Só gerente: a lista diz quanto dinheiro sai e revela o consumo de cada item —
 * é informação de negociação com fornecedor, não de balcão.
 *
 * A lista não é o catálogo com uma coluna a mais. É a resposta a uma pergunta
 * ("o que precisa ser comprado hoje"), então traz por padrão só o que precisa, e
 * ordenada por quem precisa primeiro. Mostrar as mil e sessenta linhas com o
 * urgente no meio seria a mesma informação e nenhuma resposta.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const [linhas, origem, lojas] = await Promise.all([
    listaDeCompra({ incluirSuficientes: true }),
    origemDaPolitica(),
    listarLojas(),
  ])

  return { linhas, origem, lojas: lojas.map((l) => l.codigo) }
}

const CORES: Record<Urgencia, string> = {
  sem_estoque: "bg-destructive/10 text-destructive",
  critico: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  comprar: "bg-primary/10 text-foreground",
  ok: "bg-muted text-muted-foreground",
}

export default function AdminCompras({ loaderData }: Route.ComponentProps) {
  const { linhas, origem, lojas } = loaderData
  const [busca, setBusca] = useState("")
  const [mostrarTudo, setMostrarTudo] = useState(false)

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    return linhas.filter((l) => {
      if (!mostrarTudo && l.urgencia === "ok") return false
      if (!termo) return true
      return (
        l.descricao.toLowerCase().includes(termo) || l.codigo.toLowerCase().includes(termo)
      )
    })
  }, [linhas, busca, mostrarTudo])

  const aComprar = linhas.filter((l) => l.urgencia !== "ok")
  const total = aComprar.reduce((soma, l) => soma + l.valorEstimado, 0)
  const semEstoque = aComprar.filter((l) => l.urgencia === "sem_estoque").length

  if (!origem) return <SemPolitica />

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ShoppingCart className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Compras</h1>
        <span className="text-xs text-muted-foreground">
          {aComprar.length} {aComprar.length === 1 ? "produto" : "produtos"} para repor
        </span>
      </div>

      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        A conta é da rede somada, porque a compra é central. O ponto de pedido cobre os{" "}
        {DIAS_DE_ENTREGA} dias do fornecedor mais {DIAS_DE_SEGURANCA} de folga; a
        quantidade sugerida enche {DIAS_DE_COBERTURA} dias de venda, já descontando o
        que está em trânsito entre as lojas.
      </p>

      <div className="mt-5 flex flex-wrap gap-3">
        <Cartao rotulo="Sem estoque" valor={String(semEstoque)} alerta={semEstoque > 0} />
        <Cartao rotulo="Itens a comprar" valor={String(aComprar.length)} />
        <Cartao rotulo="Valor estimado" valor={moeda(total)} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por código ou descrição"
          autoComplete="off"
          className="h-10 w-full min-w-0 rounded-lg border-border bg-background text-sm sm:w-72"
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={mostrarTudo}
            onChange={(e) => setMostrarTudo(e.target.checked)}
            className="size-4 accent-primary"
          />
          Mostrar também o que está suficiente
        </label>
      </div>

      {visiveis.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border py-16 text-center">
          <ShoppingCart className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">
            {busca
              ? "Nenhum produto com esse termo."
              : "Nada abaixo do ponto de pedido. O estoque cobre a demanda."}
          </p>
        </div>
      ) : (
        <Tabela linhas={visiveis} lojas={lojas} />
      )}

      <p className="mt-4 text-[11px] text-muted-foreground">
        Calculado em{" "}
        {new Date(origem.calculadoEm).toLocaleString("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        })}{" "}
        sobre {origem.diasAnalisados} dias de venda, {origem.produtos} produtos.
        {origem.diasAnalisados < 90 ? (
          <b className="ml-1 text-amber-700 dark:text-amber-400">
            Período curto: produto de giro lento tem média pouco confiável e a
            sazonalidade não aparece.
          </b>
        ) : null}
      </p>
    </div>
  )
}

function Cartao({
  rotulo,
  valor,
  alerta,
}: {
  rotulo: string
  valor: string
  alerta?: boolean
}) {
  return (
    <div className="min-w-32 flex-1 rounded-xl border border-border px-4 py-3 sm:flex-none">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </p>
      <p
        className={cn(
          "mt-1 font-mono text-lg font-bold tabular-nums",
          alerta && "text-destructive"
        )}
      >
        {valor}
      </p>
    </div>
  )
}

function Tabela({ linhas, lojas }: { linhas: LinhaDeCompra[]; lojas: string[] }) {
  return (
    <>
      {/* Telefone: cada produto é um cartão. Uma tabela de nove colunas num
          aparelho de mão ou rola de lado ou some — e quem compra confere de pé
          no estoque, com o telefone na mão. */}
      <ul className="mt-4 grid gap-2 sm:hidden">
        {linhas.map((l) => (
          <Cartaozinho key={l.produtoId} linha={l} lojas={lojas} />
        ))}
      </ul>

      <div className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Produto</th>
              <th className="py-2 pr-3 text-right font-semibold">Por dia</th>
              <th className="py-2 pr-3 text-right font-semibold">Estoque</th>
              {lojas.map((loja) => (
                <th key={loja} className="py-2 pr-3 text-right font-mono font-semibold">
                  {loja}
                </th>
              ))}
              <th className="py-2 pr-3 text-right font-semibold">Trânsito</th>
              <th className="py-2 pr-3 text-right font-semibold">Pedir em</th>
              <th className="py-2 pr-3 text-right font-semibold">Dura</th>
              <th className="py-2 pr-3 text-right font-semibold">Comprar</th>
              <th className="py-2 text-right font-semibold">Valor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {linhas.map((l) => (
              <tr key={l.produtoId}>
                <td className="py-2 pr-3">
                  <span className="font-mono text-xs text-muted-foreground">{l.codigo}</span>{" "}
                  {l.descricao}
                  <Badge
                    variant="outline"
                    className={cn("ml-2 border-0 text-[10px]", CORES[l.urgencia])}
                  >
                    {ROTULOS_DE_URGENCIA[l.urgencia]}
                  </Badge>
                </td>
                <td className="py-2 pr-3 text-right text-muted-foreground">
                  {l.consumoMedioDiario.toFixed(1)}
                </td>
                <td
                  className={cn(
                    "py-2 pr-3 text-right font-semibold",
                    l.estoque <= 0 && "text-destructive"
                  )}
                >
                  {formatarQuantidade(l.estoque)}
                </td>
                {lojas.map((loja) => {
                  const saldo = l.porLoja[loja] ?? 0
                  return (
                    <td
                      key={loja}
                      className={cn(
                        "py-2 pr-3 text-right text-xs",
                        saldo <= 0 ? "text-muted-foreground/40" : "text-muted-foreground"
                      )}
                    >
                      {formatarQuantidade(saldo)}
                    </td>
                  )
                })}
                <td className="py-2 pr-3 text-right text-xs text-muted-foreground">
                  {l.emTransito > 0 ? formatarQuantidade(l.emTransito) : "—"}
                </td>
                <td className="py-2 pr-3 text-right text-muted-foreground">
                  {formatarQuantidade(l.pontoDePedido)}
                </td>
                <td className="py-2 pr-3 text-right">
                  <Duracao dias={l.diasRestantes} />
                </td>
                <td className="py-2 pr-3 text-right font-semibold">
                  {l.comprar > 0 ? (
                    <>
                      {formatarQuantidade(l.comprar)}{" "}
                      <span className="text-[10px] font-normal text-muted-foreground">
                        {l.unidade}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-2 text-right text-muted-foreground">
                  {l.comprar > 0 ? moeda(l.valorEstimado) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Cartaozinho({ linha: l, lojas }: { linha: LinhaDeCompra; lojas: string[] }) {
  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm leading-snug">
          <span className="font-mono text-xs text-muted-foreground">{l.codigo}</span>{" "}
          {l.descricao}
        </p>
        <Badge
          variant="outline"
          className={cn("shrink-0 border-0 text-[10px]", CORES[l.urgencia])}
        >
          {ROTULOS_DE_URGENCIA[l.urgencia]}
        </Badge>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums">
        <span>
          <b className={cn("font-mono", l.estoque <= 0 && "text-destructive")}>
            {formatarQuantidade(l.estoque)}
          </b>{" "}
          <span className="text-muted-foreground">em estoque</span>
        </span>
        <span className="text-muted-foreground">
          <Duracao dias={l.diasRestantes} />
        </span>
        {l.emTransito > 0 ? (
          <span className="text-muted-foreground">
            {formatarQuantidade(l.emTransito)} a caminho
          </span>
        ) : null}
      </div>

      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {lojas.map((loja) => `${loja} ${formatarQuantidade(l.porLoja[loja] ?? 0)}`).join("  ")}
      </p>

      {l.comprar > 0 ? (
        <p className="mt-2 border-t border-border pt-2 text-sm">
          comprar{" "}
          <b className="font-mono">
            {formatarQuantidade(l.comprar)} {l.unidade}
          </b>
          <span className="ml-2 text-xs text-muted-foreground">
            ≈ {moeda(l.valorEstimado)}
          </span>
        </p>
      ) : null}
    </li>
  )
}

/**
 * "Dura 4 dias" responde a pergunta melhor que "estoque 120".
 *
 * O número de dias já compara o saldo com o consumo, que é a conta que quem
 * compra faria de cabeça olhando as duas colunas.
 */
function Duracao({ dias }: { dias: number | null }) {
  if (dias === null) return <span className="text-muted-foreground">—</span>
  if (dias <= 0) return <span className="font-semibold text-destructive">acabou</span>

  const cheio = Math.floor(dias)
  return (
    <span className={cn(cheio < DIAS_DE_ENTREGA && "font-semibold text-amber-700 dark:text-amber-400")}>
      {cheio > 365 ? "+1 ano" : `${cheio} d`}
    </span>
  )
}

function SemPolitica() {
  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ShoppingCart className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Compras</h1>
      </div>
      <div className="mt-6 rounded-xl border border-dashed border-border px-6 py-16 text-center">
        <ShoppingCart className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
        <p className="mt-3 text-sm font-medium">Nenhuma política de compra calculada</p>
        <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">
          O ponto de pedido vem do histórico de venda. Rode{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
            node scripts/calcular-politica-de-compra.mjs dados/&lt;arquivo.csv&gt; --gravar
          </code>{" "}
          com o faturamento exportado do sistema antigo.
        </p>
      </div>
    </div>
  )
}
