import { useMemo, useState } from "react"
import { data, Link, useFetcher } from "react-router"
import { ArrowLeft, PackageCheck, Undo2 } from "lucide-react"

import type { Route } from "./+types/devolucao"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { db } from "~/lib/db.server"
import { diaDeHoje } from "~/lib/dia"
import { caixaAberto } from "~/lib/caixa.server"
import {
  itensDevolviveis,
  registrarDevolucao,
  type DestinoDaDevolucao,
  type LinhaDevolvivel,
} from "~/lib/devolucoes.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { FORMAS_PAGAMENTO } from "~/lib/pdv"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Devolução — BrasSaco" }]
}

/**
 * A devolução de parte de uma venda que já virou fato.
 *
 * Fica no turno, e não na administração, porque acontece com o cliente na
 * frente: ele chega com a mercadoria e o cupom, e quem atende resolve ali. A
 * guarda de gerente é cobrada na rota, como no cancelamento — é ele que
 * responde pelo dinheiro que sai da gaveta.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "devolverMercadoria")

  const venda = await db.venda.findUnique({ where: { id: params.vendaId ?? "" } })
  if (!venda) throw new Response("Venda não encontrada", { status: 404 })
  if (!eu.lojasPermitidas.includes(venda.loja)) {
    throw new Response("Venda de outra loja", { status: 403 })
  }

  const [linhas, notaOriginal] = await Promise.all([
    itensDevolviveis(venda.id),
    // Sem ela não há o que referenciar, e a tela precisa avisar ANTES — não
    // depois de o cliente ir embora com o dinheiro e a nota não sair.
    db.notaFiscalEmitida.findFirst({
      where: { vendaId: venda.id, status: "autorizado", chave: { not: null } },
      orderBy: { criadaEm: "desc" },
    }),
  ])

  return {
    eu: { loja: eu.loja },
    caixaAberto: await caixaAberto(venda.loja, diaDeHoje()),
    venda: {
      id: venda.id,
      numero: venda.numero,
      loja: venda.loja,
      criadaEm: venda.criadaEm.toISOString(),
      total: venda.total,
      forma: venda.forma,
      clienteNome: venda.clienteNome,
      // O crédito precisa de conta onde cair; a tela desliga o botão sem ela.
      temCliente: Boolean(venda.clienteId),
      cancelada: Boolean(venda.canceladaEm),
    },
    linhas,
    temNota: Boolean(notaOriginal?.chave),
  }
}

export async function action({ params, request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "devolverMercadoria")

  const form = await request.formData()
  let itens: { produtoId: string; quantidade: number }[] = []
  try {
    itens = JSON.parse(String(form.get("itens") ?? "[]"))
  } catch {
    itens = []
  }

  const resultado = await registrarDevolucao({
    vendaId: params.vendaId ?? "",
    itens,
    motivo: String(form.get("motivo") ?? ""),
    operador: eu.nome,
    operadorId: eu.id,
    dia: diaDeHoje(),
    destino: destinoValido(String(form.get("destino"))),
  })

  if (!resultado.ok) {
    return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
  }
  return {
    ok: true as const,
    numero: resultado.numero,
    id: resultado.id,
    total: resultado.total,
  }
}

/** O que a tela mandou, recusando o que não é destino — a lista é de três. */
function destinoValido(valor: string): DestinoDaDevolucao {
  return valor === "credito" || valor === "fora" ? valor : "especie"
}

export default function Devolucao({ loaderData }: Route.ComponentProps) {
  const { venda, linhas, temNota, caixaAberto: aberto } = loaderData

  const [quantidades, setQuantidades] = useState<Record<string, string>>({})
  const [motivo, setMotivo] = useState("")
  /*
   * Espécie é o padrão porque é o que acontece no balcão. Crédito só aparece
   * com cliente vinculado — sem cadastro não há a quem creditar, e um botão
   * que erra sempre é pior que um botão que não está lá.
   */
  const [destino, setDestino] = useState<DestinoDaDevolucao>("especie")

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  function quantidadeDe(linha: LinhaDevolvivel) {
    const bruto = quantidades[linha.produtoId]
    if (bruto === undefined || bruto === "") return 0
    const n = Number(bruto.replace(",", "."))
    return Number.isFinite(n) ? n : 0
  }

  const escolhidos = linhas
    .map((l) => ({ linha: l, quantidade: quantidadeDe(l) }))
    .filter((x) => x.quantidade > 0)

  const total = useMemo(
    () => escolhidos.reduce((soma, x) => soma + x.quantidade * x.linha.preco, 0),
    [escolhidos]
  )
  const excedido = escolhidos.some((x) => x.quantidade > x.linha.devolvivel)
  const nadaADevolver = linhas.every((l) => l.devolvivel <= 0)

  function confirmar() {
    if (gravando || escolhidos.length === 0 || excedido || !motivo.trim()) return
    fetcher.submit(
      {
        itens: JSON.stringify(
          escolhidos.map((x) => ({ produtoId: x.linha.produtoId, quantidade: x.quantidade }))
        ),
        motivo,
        destino,
      },
      { method: "post" }
    )
  }

  if (fetcher.data?.ok) {
    return <Pronta numero={fetcher.data.numero} id={fetcher.data.id} total={fetcher.data.total} temNota={temNota} />
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link
        to="/vendas"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Voltar para Vendas
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Undo2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Devolução da venda #{venda.numero}</h1>
        <Badge variant="outline" className="font-mono text-[10px]">
          {venda.loja}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {new Date(venda.criadaEm).toLocaleString("pt-BR", {
            dateStyle: "short",
            timeStyle: "short",
          })}{" "}
          · {moeda(venda.total)} em{" "}
          {FORMAS_PAGAMENTO.find((f) => f.id === venda.forma)?.rotulo ?? venda.forma}
          {venda.clienteNome ? ` · ${venda.clienteNome}` : ""}
        </span>
      </div>

      {venda.cancelada ? (
        <Recado tipo="erro">
          Esta venda foi cancelada — o estoque já voltou pelo cancelamento. Não há o
          que devolver.
        </Recado>
      ) : nadaADevolver ? (
        <Recado tipo="erro">Tudo desta venda já voltou.</Recado>
      ) : null}

      {!temNota && !venda.cancelada ? (
        <Recado tipo="aviso">
          Esta venda não tem nota autorizada, então <b>não haverá nota de devolução</b> —
          sem a chave da original não existe o que referenciar. A mercadoria volta ao
          estoque e o dinheiro ao cliente do mesmo jeito.
        </Recado>
      ) : null}

      {destino === "especie" && !aberto ? (
        <Recado tipo="erro">
          O caixa de {venda.loja} não foi aberto hoje — sem ele o dinheiro não pode
          sair da gaveta. Abra o caixa, ou desmarque a devolução em espécie.
        </Recado>
      ) : null}

      <div className="mt-4 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Produto</th>
              <th className="px-3 py-2 text-right font-semibold">Levou</th>
              <th className="px-3 py-2 text-right font-semibold">Já voltou</th>
              <th className="px-3 py-2 text-right font-semibold">Cabe</th>
              <th className="px-3 py-2 text-right font-semibold">Preço</th>
              <th className="px-3 py-2 text-right font-semibold">Voltando</th>
              <th className="px-3 py-2 text-right font-semibold">Valor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {linhas.map((linha) => {
              const qtd = quantidadeDe(linha)
              const demais = qtd > linha.devolvivel
              return (
                <tr key={linha.produtoId} className={cn(qtd > 0 && "bg-primary/5")}>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {linha.codigo}
                    </span>{" "}
                    {linha.descricao}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {formatarQuantidade(linha.vendida)}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {linha.jaDevolvida > 0 ? formatarQuantidade(linha.jaDevolvida) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    {formatarQuantidade(linha.devolvivel)} {linha.unidade}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {moeda(linha.preco)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Input
                      value={quantidades[linha.produtoId] ?? ""}
                      onChange={(e) =>
                        setQuantidades((q) => ({
                          ...q,
                          [linha.produtoId]: e.target.value.replace(/\D/g, ""),
                        }))
                      }
                      disabled={linha.devolvivel <= 0 || venda.cancelada}
                      inputMode="numeric"
                      placeholder="0"
                      autoComplete="off"
                      className={cn(
                        "h-8 w-24 rounded-lg text-right font-mono tabular-nums",
                        demais && "border-destructive text-destructive"
                      )}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {qtd > 0 ? moeda(qtd * linha.preco) : "—"}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label
            htmlFor="motivo"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Por que voltou
          </label>
          {/* Obrigatório: é a única explicação que o lançamento carrega, e
              "voltaram 3" sem motivo é indistinguível de erro de digitação
              seis meses depois. */}
          <Input
            id="motivo"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="defeito, tamanho errado, cliente desistiu…"
            autoComplete="off"
            className="h-10 rounded-lg"
          />
        </div>

        <div className="pb-1">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            O valor volta como
          </span>
          <div className="flex flex-wrap gap-1.5">
            {DESTINOS.map((opcao) => {
              // Sem cliente na venda não há conta onde pôr o saldo.
              const impedido = opcao.id === "credito" && !venda.temCliente
              return (
                <Button
                  key={opcao.id}
                  type="button"
                  size="sm"
                  variant={destino === opcao.id ? "default" : "outline"}
                  disabled={impedido}
                  title={impedido ? "Só com cliente cadastrado na venda" : opcao.ajuda}
                  onClick={() => setDestino(opcao.id)}
                  className="rounded-lg"
                >
                  {opcao.rotulo}
                </Button>
              )
            })}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {DESTINOS.find((d) => d.id === destino)?.ajuda}
          </p>
        </div>
      </div>

      {fetcher.data && !fetcher.data.ok ? (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {fetcher.data.erro}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <span className="text-sm">
          {escolhidos.length} {escolhidos.length === 1 ? "item" : "itens"}
        </span>
        <span className="font-mono text-2xl font-bold tabular-nums">{moeda(total)}</span>
        {excedido ? (
          <span className="text-xs font-medium text-destructive">
            Há item voltando acima do que cabe
          </span>
        ) : null}
        {!motivo.trim() && escolhidos.length > 0 ? (
          <span className="text-xs text-muted-foreground">Falta dizer por que voltou</span>
        ) : null}

        <Button
          type="button"
          disabled={
            gravando ||
            escolhidos.length === 0 ||
            excedido ||
            !motivo.trim() ||
            venda.cancelada ||
            (destino === "especie" && !aberto)
          }
          onClick={confirmar}
          className="ml-auto rounded-lg"
        >
          <PackageCheck className="size-4" />
          {gravando ? "Registrando…" : "Registrar devolução"}
        </Button>
      </div>
    </div>
  )
}

const DESTINOS: { id: DestinoDaDevolucao; rotulo: string; ajuda: string }[] = [
  {
    id: "especie",
    rotulo: "Dinheiro da gaveta",
    ajuda: "Sai do caixa agora — exige caixa aberto e entra no fechamento do dia",
  },
  {
    id: "credito",
    rotulo: "Crédito do cliente",
    ajuda: "Vira saldo a favor dele, para abater numa próxima compra. Nada sai da gaveta",
  },
  {
    id: "fora",
    rotulo: "Acerto por fora",
    ajuda: "Só a mercadoria volta — o valor é resolvido por outro caminho",
  },
]

function Recado({ tipo, children }: { tipo: "erro" | "aviso"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "mt-3 rounded-lg px-3 py-2 text-sm",
        tipo === "erro"
          ? "bg-destructive/10 text-destructive"
          : "bg-muted/60 text-muted-foreground"
      )}
      role="status"
    >
      {children}
    </p>
  )
}

function Pronta({
  numero,
  id,
  total,
  temNota,
}: {
  numero: number
  id: string
  total: number
  temNota: boolean
}) {
  return (
    <div className="mx-auto max-w-md p-6 text-center">
      <div className="rounded-xl border border-border p-6">
        <PackageCheck className="mx-auto size-10 text-primary" aria-hidden />
        <p className="mt-3 text-sm text-muted-foreground">Devolução registrada</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">#{numero}</p>
        <p className="mt-1 font-mono text-sm">{moeda(total)}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          A mercadoria voltou ao estoque.{" "}
          {temNota
            ? "A NF-e de devolução pode ser emitida na lista de devoluções."
            : "Sem NF-e: a venda original não tinha nota autorizada para referenciar."}
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <Link
            to="/admin/devolucoes"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground"
          >
            Ver as devoluções
          </Link>
          <Link
            to="/vendas"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border text-sm"
          >
            Voltar para Vendas
          </Link>
        </div>
        <span className="sr-only">{id}</span>
      </div>
    </div>
  )
}
