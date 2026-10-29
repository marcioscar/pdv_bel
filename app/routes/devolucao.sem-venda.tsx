import { useMemo, useState } from "react"
import { data, Link, useFetcher } from "react-router"
import { ArrowLeft, Banknote, PackageCheck, Plus, Search, Trash2, Undo2, User } from "lucide-react"

import type { Route } from "./+types/devolucao.sem-venda"
import { EscolhaDeProduto, type ProdutoDoCatalogo } from "~/components/pdv/escolha-de-produto"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { caixaAberto } from "~/lib/caixa.server"
import { db } from "~/lib/db.server"
import { diaDeHoje } from "~/lib/dia"
import { registrarDevolucaoSemVenda, type ItemSemVenda } from "~/lib/devolucoes.server"
import { formatarCpfCnpj } from "~/lib/documento"
import {
  arredondar,
  interpretarQuantidade,
  interpretarValor,
  moeda,
  quantidadeAceita,
} from "~/lib/moeda"
import { criarIndice } from "~/lib/pdv"
import { ehGerente } from "~/lib/permissoes"
import { exigirUsuario } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Devolução sem venda — BrasSaco" }]
}

/**
 * A devolução quando a venda não se acha: o cliente perdeu o cupom, comprou em
 * outra loja, ou ninguém quer garimpar a venda com ele esperando.
 *
 * Qualquer usuário registra, como a devolução comum (decisão do Marcio,
 * 22/10/2026). O documento e o crédito guardam quem lançou, e o gerente confere
 * na lista de Devoluções, onde elas aparecem marcadas "sem venda". As regras —
 * preço com teto no catálogo, crédito para quem tem cadastro, dinheiro da
 * gaveta para o consumidor final, estoque na loja de quem recebe — estão em
 * `registrarDevolucaoSemVenda`.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const [produtos, clientes] = await Promise.all([
    // Os inativos também: o que volta pode ter saído de linha depois da compra.
    db.produto.findMany({
      select: {
        id: true,
        codigo: true,
        descricao: true,
        unidade: true,
        preco: true,
        vendeFracionado: true,
      },
      orderBy: { descricao: "asc" },
    }),
    db.cliente.findMany({
      where: { ativo: true },
      select: { id: true, nome: true, cpfCnpj: true },
      orderBy: { nome: "asc" },
    }),
  ])

  return {
    loja: eu.loja,
    produtos,
    clientes,
    // A lista de devoluções é do gerente: o link só aparece para quem abre.
    verLista: ehGerente(eu.papel),
    // O consumidor final leva em dinheiro, e dinheiro só sai de caixa aberto.
    caixaAberto: await caixaAberto(eu.loja, diaDeHoje()),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)

  const form = await request.formData()
  let itens: ItemSemVenda[] = []
  try {
    const bruto: unknown = JSON.parse(String(form.get("itens") ?? "[]"))
    if (Array.isArray(bruto)) {
      itens = bruto.flatMap((i) => {
        const { produtoId, quantidade, preco } = (i ?? {}) as Record<string, unknown>
        return typeof produtoId === "string" &&
          typeof quantidade === "number" &&
          typeof preco === "number" &&
          Number.isFinite(quantidade) &&
          Number.isFinite(preco)
          ? [{ produtoId, quantidade, preco }]
          : []
      })
    }
  } catch {
    itens = []
  }

  const resultado = await registrarDevolucaoSemVenda({
    // A loja da sessão: a mercadoria entra onde fisicamente chegou.
    loja: eu.loja,
    // Vazio é consumidor final: o valor sai em dinheiro da gaveta.
    clienteId: String(form.get("clienteId") ?? "") || null,
    itens,
    motivo: String(form.get("motivo") ?? ""),
    operador: eu.nome,
    operadorId: eu.id,
    dia: diaDeHoje(),
  })

  if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
  return { ok: true as const, numero: resultado.numero, total: resultado.total }
}

type Linha = { chave: number; produtoId: string | null; quantidade: string; preco: string }

let proximaChave = 1
const linhaVazia = (): Linha => ({ chave: proximaChave++, produtoId: null, quantidade: "1", preco: "" })

export default function DevolucaoSemVenda({ loaderData }: Route.ComponentProps) {
  const { loja, produtos, clientes, verLista, caixaAberto: aberto } = loaderData

  const porId = useMemo(() => new Map(produtos.map((p) => [p.id, p])), [produtos])
  const indice = useMemo(() => criarIndice<ProdutoDoCatalogo>(produtos), [produtos])

  const [clienteId, setClienteId] = useState<string | null>(null)
  // Sem cadastro: o valor não tem onde virar crédito e sai em dinheiro.
  const [consumidorFinal, setConsumidorFinal] = useState(false)
  const [buscaCliente, setBuscaCliente] = useState("")
  const [linhas, setLinhas] = useState<Linha[]>(() => [linhaVazia()])
  const [motivo, setMotivo] = useState("")

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  const cliente = clientes.find((c) => c.id === clienteId) ?? null

  const encontrados = useMemo(() => {
    const termo = buscaCliente
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim()
    const digitos = buscaCliente.replace(/\D/g, "")
    if (!termo) return []
    return clientes
      .filter(
        (c) =>
          c.nome
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .includes(termo) ||
          (digitos.length >= 3 && c.cpfCnpj.includes(digitos))
      )
      .slice(0, 8)
  }, [buscaCliente, clientes])

  function alterar(chave: number, mudanca: Partial<Linha>) {
    setLinhas((atuais) => atuais.map((l) => (l.chave === chave ? { ...l, ...mudanca } : l)))
  }

  /*
   * Cada linha lida e conferida aqui do mesmo jeito que o servidor confere —
   * quantidade inteira (ou até 3 casas no fracionado), preço até o catálogo — para o botão saber se a
   * devolução fecha antes de ir à rede.
   */
  const lidas = linhas.map((linha) => {
    const produto = linha.produtoId ? porId.get(linha.produtoId) ?? null : null
    const quantidade = interpretarQuantidade(linha.quantidade) ?? 0
    const preco = interpretarValor(linha.preco)
    const erro = !produto
      ? null
      : !quantidadeAceita(quantidade, produto.vendeFracionado)
        ? produto.vendeFracionado
          ? "até 3 casas"
          : "quantidade inteira"
        : preco === null || preco <= 0
          ? "informe o preço"
          : preco > produto.preco + 0.005
            ? `até ${moeda(produto.preco)}`
            : null
    return {
      linha,
      produto,
      quantidade,
      preco: preco ?? 0,
      erro,
      subtotal: produto && !erro ? arredondar(quantidade * (preco ?? 0)) : 0,
    }
  })

  const validas = lidas.filter((l) => l.produto && !l.erro)
  const total = arredondar(validas.reduce((soma, l) => soma + l.subtotal, 0))
  const comErro = lidas.some((l) => l.erro)
  const repetido =
    new Set(validas.map((l) => l.produto!.id)).size !== validas.length

  const quem = cliente !== null || (consumidorFinal && aberto)
  const pronto =
    !gravando && quem && validas.length > 0 && !comErro && !repetido && motivo.trim() !== ""

  function confirmar() {
    if (!pronto) return
    fetcher.submit(
      {
        clienteId: cliente?.id ?? "",
        motivo,
        itens: JSON.stringify(
          validas.map((l) => ({ produtoId: l.produto!.id, quantidade: l.quantidade, preco: l.preco }))
        ),
      },
      { method: "post" }
    )
  }

  if (fetcher.data?.ok) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <div className="rounded-xl border border-border p-6">
          <PackageCheck className="mx-auto size-10 text-primary" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">Devolução registrada</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">#{fetcher.data.numero}</p>
          {cliente ? (
            <>
              <p className="mt-1 font-mono text-sm">{moeda(fetcher.data.total)} de crédito</p>
              <p className="mt-3 text-xs text-muted-foreground">
                A mercadoria voltou ao estoque de {loja}, e o valor virou crédito de{" "}
                <b className="text-foreground">{cliente.nome}</b>. Na troca, é só vincular o
                cliente na venda (F6) e abater o crédito na conferência — o que passar dele
                o cliente paga.
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 font-mono text-sm">
                Entregue {moeda(fetcher.data.total)} em dinheiro
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                A mercadoria voltou ao estoque de {loja}, e a saída da gaveta entra no
                fechamento do dia como devolução. Na troca, faça a venda nova
                normalmente.
              </p>
            </>
          )}
          <div className="mt-6 flex flex-col gap-2">
            <Link
              to="/"
              className="inline-flex h-10 items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground"
            >
              Ir para o caixa
            </Link>
            {verLista ? (
              <Link
                to="/admin/devolucoes"
                className="inline-flex h-10 items-center justify-center rounded-lg border border-border text-sm"
              >
                Ver as devoluções
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    )
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
        <h1 className="text-base font-semibold">Devolução sem venda</h1>
        <Badge variant="outline" className="font-mono text-[10px]">
          {loja}
        </Badge>
      </div>
      <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
        Para quando a venda não se acha ou foi em outra loja. A mercadoria entra no
        estoque de <b>{loja}</b> e o preço vem do catálogo (pode baixar, não subir). Com
        cliente cadastrado o valor vira <b>crédito</b> — na troca, a venda nova abate;
        consumidor final leva em <b>dinheiro da gaveta</b>. Não sai NF-e de devolução:
        não há nota de origem a referenciar.
      </p>

      {/* Quem devolve vem primeiro: decide se o valor vira crédito ou dinheiro. */}
      <section className="mt-4">
        <h2 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Cliente
        </h2>
        {cliente ? (
          <div className="flex items-center gap-3 rounded-lg border border-primary bg-primary/5 p-3">
            <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{cliente.nome}</div>
              <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {formatarCpfCnpj(cliente.cpfCnpj)}
              </div>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="rounded-lg"
              onClick={() => {
                setClienteId(null)
                setBuscaCliente("")
              }}
            >
              Trocar
            </Button>
          </div>
        ) : consumidorFinal ? (
          <div
            className={cn(
              "flex items-center gap-3 rounded-lg border p-3",
              aberto ? "border-primary bg-primary/5" : "border-destructive/50 bg-destructive/5"
            )}
          >
            <Banknote className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Consumidor final</div>
              <div className={cn("text-[11px]", aberto ? "text-muted-foreground" : "text-destructive")}>
                {aberto
                  ? "Sem cadastro: o valor sai em dinheiro da gaveta"
                  : `O caixa de ${loja} não foi aberto hoje — sem ele o dinheiro não sai da gaveta`}
              </div>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="rounded-lg"
              onClick={() => setConsumidorFinal(false)}
            >
              Trocar
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border p-2">
            <div className="flex items-center gap-2 px-1">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                autoFocus
                value={buscaCliente}
                onChange={(e) => setBuscaCliente(e.target.value)}
                placeholder="Nome ou CPF/CNPJ do cliente"
                aria-label="Buscar cliente"
                autoComplete="off"
                className="h-9 flex-1 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="shrink-0 rounded-lg"
                onClick={() => setConsumidorFinal(true)}
              >
                <User className="size-3.5" /> Consumidor final
              </Button>
            </div>
            {buscaCliente.trim() ? (
              <ul className="mt-1 max-h-60 overflow-y-auto">
                {encontrados.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setClienteId(c.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60"
                    >
                      <span className="min-w-0 flex-1 truncate">{c.nome}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                        {formatarCpfCnpj(c.cpfCnpj)}
                      </span>
                    </button>
                  </li>
                ))}
                {encontrados.length === 0 ? (
                  <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                    Nenhum cliente com “{buscaCliente}” — cadastre em Clientes, ou devolva
                    como consumidor final
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <section className="mt-4">
        <h2 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          O que voltou
        </h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[36rem] text-sm tabular-nums">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Produto</th>
                <th className="px-3 py-2 text-right font-semibold">Qtd</th>
                <th className="px-3 py-2 text-right font-semibold">Preço</th>
                <th className="px-3 py-2 text-right font-semibold">Valor</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lidas.map(({ linha, produto, erro, subtotal }) => (
                <tr key={linha.chave}>
                  <td className="px-3 py-2">
                    <EscolhaDeProduto
                      escolhido={produto}
                      destacados={[]}
                      indice={indice}
                      onEscolher={(produtoId) => {
                        const escolhido = porId.get(produtoId)
                        // O preço entra com o do catálogo — o teto —, e quem
                        // atende baixa se o cliente pagou menos.
                        alterar(linha.chave, {
                          produtoId,
                          preco: escolhido ? escolhido.preco.toFixed(2).replace(".", ",") : "",
                        })
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Input
                      value={linha.quantidade}
                      onChange={(e) =>
                        alterar(linha.chave, {
                          quantidade: produto?.vendeFracionado
                            ? e.target.value.replace(/[^\d,]/g, "")
                            : e.target.value.replace(/\D/g, ""),
                        })
                      }
                      inputMode={produto?.vendeFracionado ? "decimal" : "numeric"}
                      autoComplete="off"
                      aria-label="Quantidade"
                      className="ml-auto h-8 w-20 rounded-lg text-right font-mono tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Input
                      value={linha.preco}
                      onChange={(e) => alterar(linha.chave, { preco: e.target.value })}
                      disabled={!produto}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label="Preço"
                      className={cn(
                        "ml-auto h-8 w-24 rounded-lg text-right font-mono tabular-nums",
                        erro && "border-destructive text-destructive"
                      )}
                    />
                    {erro ? <div className="mt-0.5 text-[10px] text-destructive">{erro}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {subtotal > 0 ? moeda(subtotal) : "—"}
                  </td>
                  <td className="pr-2">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Tirar a linha"
                      disabled={linhas.length === 1}
                      onClick={() => setLinhas((atuais) => atuais.filter((l) => l.chave !== linha.chave))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1.5 rounded-lg text-muted-foreground"
          onClick={() => setLinhas((atuais) => [...atuais, linhaVazia()])}
        >
          <Plus className="size-4" /> Outro produto
        </Button>
        {repetido ? (
          <p className="mt-1 text-xs text-destructive">
            O mesmo produto aparece duas vezes — junte numa linha só.
          </p>
        ) : null}
      </section>

      <div className="mt-4">
        <label
          htmlFor="motivo"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Por que voltou
        </label>
        <Input
          id="motivo"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="troca de tamanho, defeito, comprou na NRT…"
          autoComplete="off"
          className="h-10 rounded-lg"
        />
      </div>

      {fetcher.data && !fetcher.data.ok ? (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {fetcher.data.erro}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <span className="text-sm text-muted-foreground">
          {consumidorFinal && !cliente ? "Em dinheiro" : "Crédito"}
        </span>
        <span className="font-mono text-2xl font-bold tabular-nums">{moeda(total)}</span>
        {!cliente && !consumidorFinal ? (
          <span className="text-xs text-muted-foreground">
            Falta escolher o cliente, ou consumidor final
          </span>
        ) : !motivo.trim() && validas.length > 0 ? (
          <span className="text-xs text-muted-foreground">Falta dizer por que voltou</span>
        ) : null}
        <Button type="button" disabled={!pronto} onClick={confirmar} className="ml-auto rounded-lg">
          <PackageCheck className="size-4" />
          {gravando
            ? "Registrando…"
            : consumidorFinal && !cliente
              ? "Registrar e devolver em dinheiro"
              : "Registrar e gerar crédito"}
        </Button>
      </div>
    </div>
  )
}
