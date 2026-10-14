import { Link } from "react-router"
import { ArrowLeft, FileText } from "lucide-react"

import type { Route } from "./+types/admin.afs.$afId"
import { Badge } from "~/components/ui/badge"
import { GerarDespesas, type RespostaDespesas } from "~/components/pdv/gerar-despesas"
import { afPorId } from "~/lib/afs.server"
import { PrecosDeVenda, type RespostaPrecos } from "~/components/pdv/precos-de-venda"
import { ultimoCustoPorProduto } from "~/lib/compras.server"
import { db } from "~/lib/db.server"
import { percentuaisDaOperacao } from "~/lib/precificacao.server"
import { alterarPrecos } from "~/lib/produtos.server"
import { categoriasDeDespesa, gerarDespesas, type LinhaDeDespesa } from "~/lib/despesas.server"
import { formatarCpfCnpj } from "~/lib/documento"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"

export function meta({ loaderData }: Route.MetaArgs) {
  const af = loaderData?.af
  return [{ title: af ? `AF ${af.numero} — ${af.fornecedorNome} — BrasSaco` : "AF — BrasSaco" }]
}

/**
 * O que uma AF lançou: os itens que entraram no estoque e a conta a pagar que
 * sai dela.
 *
 * Só leitura do lado do estoque — a entrada aconteceu no lançamento, junto com
 * a gravação da AF, e desfazer mercadoria que já está na prateleira é ajuste de
 * inventário, não edição de documento. O que ainda falta fazer aqui é o
 * financeiro, que é justamente o bloco de baixo.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await exigirGerente(request, "lancarAf")

  const af = await afPorId(params.afId)
  if (!af) throw new Response("AF não encontrada", { status: 404 })

  const ids = [...new Set(af.itens.map((i) => i.produtoId))]
  const [categorias, produtos, custoAnterior, percentuais] = await Promise.all([
    categoriasDeDespesa(),
    db.produto.findMany({ where: { id: { in: ids } }, select: { id: true, preco: true } }),
    // O custo de ANTES desta AF: a entrada dela já está no estoque, e o "último
    // custo" de agora seria o dela mesma — o markup proposto sairia zerado.
    ultimoCustoPorProduto(ids, new Date(new Date(af.criadoEm).getTime() - 1)),
    percentuaisDaOperacao(),
  ])
  const precoPorId = new Map(produtos.map((p) => [p.id, p.preco]))

  return {
    af,
    categorias,
    percentuais,
    paraPrecificar: af.itens.map((i) => ({
      produtoId: i.produtoId,
      codigo: i.codigo,
      descricao: i.descricao,
      unidade: i.unidade,
      custo: i.custoUnitario,
      precoHoje: precoPorId.get(i.produtoId) ?? null,
      custoAnterior: custoAnterior.get(i.produtoId) ?? null,
    })),
  }
}

export async function action({
  request,
}: Route.ActionArgs): Promise<RespostaDespesas | RespostaPrecos> {
  const form = await request.formData()

  // O preço de venda novo: permissão de quem mexe no catálogo.
  if (form.get("intencao") === "atualizarPrecos") {
    const gerente = await exigirGerente(request, "editarProdutos")
    let itens: { produtoId: string; preco: number }[] = []
    try {
      itens = JSON.parse(String(form.get("itens") ?? "[]"))
    } catch {
      return { intencao: "atualizarPrecos", ok: false, erro: "Dados inválidos" }
    }
    const r = await alterarPrecos(itens, { nome: gerente.nome, id: gerente.id })
    return r.ok
      ? { intencao: "atualizarPrecos", ok: true, alterados: r.alterados }
      : { intencao: "atualizarPrecos", ok: false, erro: r.erro }
  }

  const eu = await exigirGerente(request, "gerarDespesas")

  let linhas: LinhaDeDespesa[] = []
  try {
    linhas = JSON.parse(String(form.get("linhas") ?? "[]"))
  } catch {
    linhas = []
  }

  const resultado = await gerarDespesas(
    { tipo: "af", id: String(form.get("documentoId") ?? "") },
    linhas,
    eu.nome
  )
  return { intencao: "gerarDespesas", ...resultado }
}

export default function DetalheAf({ loaderData }: Route.ComponentProps) {
  const { af, categorias, percentuais, paraPrecificar } = loaderData

  return (
    <div className="p-4 sm:p-6">
      <Link
        to="/admin/afs"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        AFs de compra
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">
          {af.fornecedorNome} — AF nº {af.numero}
        </h1>
        {af.pedidoDeCompraNumero ? (
          <a
            href={`/pedidos-de-compra/${af.pedidoDeCompraId}/impressao`}
            target="_blank"
            rel="noreferrer"
          >
            <Badge variant="secondary">pedido #{af.pedidoDeCompraNumero}</Badge>
          </a>
        ) : null}
      </div>

      <div className="mt-4 space-y-6">
        <div className="rounded-lg border p-4 text-sm lg:w-1/2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Fornecedor</dt>
            <dd>
              {af.fornecedorNome}
              {af.fornecedorDocumento ? ` (${formatarCpfCnpj(af.fornecedorDocumento)})` : ""}
            </dd>
            <dt className="text-muted-foreground">Data da AF</dt>
            <dd>{new Date(af.dataEmissao).toLocaleDateString("pt-BR")}</dd>
            <dt className="text-muted-foreground">Loja que recebeu</dt>
            <dd>{af.loja}</dd>
            <dt className="text-muted-foreground">Valor total</dt>
            <dd>{moeda(af.total)}</dd>
            <dt className="text-muted-foreground">Lançada</dt>
            <dd>
              {new Date(af.criadoEm).toLocaleString("pt-BR")} por {af.criadoPor}
            </dd>
            {af.observacao ? (
              <>
                <dt className="text-muted-foreground">Observação</dt>
                <dd>{af.observacao}</dd>
              </>
            ) : null}
          </dl>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-2 py-1.5">Código</th>
                <th className="px-2 py-1.5">Descrição</th>
                <th className="px-2 py-1.5 text-right">Qtd</th>
                <th className="px-2 py-1.5 text-right">Custo unit.</th>
                <th className="px-2 py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {af.itens.map((item, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-2 py-1.5 font-mono">{item.codigo}</td>
                  <td className="px-2 py-1.5">{item.descricao}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatarQuantidade(item.quantidade)} {item.unidade}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {moeda(item.custoUnitario)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{moeda(item.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border p-4">
          <PrecosDeVenda itens={paraPrecificar} percentuais={percentuais} />
        </div>

        <div className="rounded-lg border p-4">
          <GerarDespesas
            documento={{
              tipo: "af",
              id: af.id,
              numero: af.numero,
              valorTotal: af.total,
              despesasGeradasEm: af.despesasGeradasEm,
              despesasGeradasPor: af.despesasGeradasPor,
            }}
            // A AF não declara parcela nenhuma: o vencimento é o que está
            // escrito no papel, e quem lança é que sabe. Começa com uma linha
            // pelo total, como a nota sem duplicata.
            duplicatas={null}
            // Sempre tem cadastro: a AF escolheu o fornecedor da própria lista.
            fornecedor={{ nome: af.fornecedorNome, temCadastro: true }}
            categorias={categorias}
            cadastroRapido={null}
          />
        </div>
      </div>
    </div>
  )
}
