import { Link, useFetcher, useSearchParams } from "react-router"
import { ArrowLeft, FileCheck, FileSearch } from "lucide-react"

import type { Route } from "./+types/admin.notas-de-entrada.$notaId"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { formatarCpfCnpj } from "~/lib/documento"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { GerarDespesas, type RespostaDespesas } from "~/components/pdv/gerar-despesas"
import {
  categoriasDeDespesa,
  duplicatasDaNota,
  fornecedorParaDespesa,
  gerarDespesas,
  type LinhaDeDespesa,
} from "~/lib/despesas.server"
import { darCiencia, notaPorId } from "~/lib/notas-fiscais.server"
import { criarFornecedor, lerFornecedor, proximoCodigoDeFornecedor } from "~/lib/fornecedores.server"
import { resumoDoProcNFe } from "~/lib/sefaz.server"
import { exigirGerente } from "~/lib/sessao.server"
import { EntradaDeNota, type RespostaEntrada } from "~/components/pdv/entrada-de-nota"
import { percentuaisDaOperacao } from "~/lib/precificacao.server"
import {
  itensComCustoDaNota,
  pedidosAbertosDoFornecedor,
  receberComNota,
  type ItemReconciliado,
} from "~/lib/conciliacao.server"
import { db } from "~/lib/db.server"
import { listarLojas } from "~/lib/lojas.server"
import { recebidoPorProduto } from "~/lib/pedidos-compra.server"
import { criarProduto, lerProduto, SOMENTE_ATIVOS } from "~/lib/produtos.server"

export function meta({ loaderData }: Route.MetaArgs) {
  const nome = loaderData?.nota?.emitenteNome
  return [{ title: nome ? `${nome} — Notas de entrada — BrasSaco` : "Notas de entrada — BrasSaco" }]
}

/**
 * Página própria para o detalhe de uma nota — separada da lista porque o que
 * cabe aqui (itens, duplicatas, cadastro de despesa, cadastro de fornecedor)
 * é trabalho de mesa, não uma prévia ao lado da tabela. Espremido num painel
 * lateral, o formulário de contas a pagar não tinha largura para respirar.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await exigirGerente(request, "buscarNotaFiscal")

  const nota = await notaPorId(params.notaId)
  if (!nota) throw new Response("Nota não encontrada", { status: 404 })

  const resumo = nota.xml && nota.situacaoXml === "completa" ? resumoDoProcNFe(nota.xml) : null
  const itensDaNota = resumo?.itens ?? null

  // A entrada no estoque só existe com o XML completo — sem itens não há o que
  // parear com o catálogo.
  const temItens = Boolean(nota.xml && nota.situacaoXml === "completa")
  const url = new URL(request.url)
  const pedidoId = url.searchParams.get("pedido") ?? ""

  const pedidos = temItens ? await pedidosAbertosDoFornecedor(nota.emitenteCnpj) : []
  // Um pedido só em aberto é o caso comum: já vem escolhido, para não obrigar a
  // confirmar o óbvio. Com vários, quem recebeu é que sabe qual é.
  const pedidoEscolhido = pedidoId
    ? (pedidos.find((p) => p.id === pedidoId) ?? null)
    : (pedidos.length === 1 ? pedidos[0] : null)

  const [lojas, catalogo, recebidoAntes] = temItens
    ? await Promise.all([
        listarLojas(),
        // O catálogo inteiro, e não só os itens do pedido: a nota pode trazer
        // produto que já existe mas não foi pedido, e daí o pareamento certo
        // está no catálogo — sem isso o gerente cadastraria um duplicado.
        db.produto.findMany({
          where: SOMENTE_ATIVOS,
          orderBy: { descricao: "asc" },
          // O preço vem junto para a sugestão poder mostrar, ao lado dela, o
          // que o produto custa hoje — sugestão sozinha não diz o que fazer.
          select: { id: true, codigo: true, descricao: true, unidade: true, preco: true },
        }),
        pedidoEscolhido ? recebidoPorProduto(pedidoEscolhido.id) : new Map<string, number>(),
      ])
    : [[], [], new Map<string, number>()]

  const itensComCusto = temItens ? itensComCustoDaNota(nota.xml!) : []

  /*
   * Quanto a operação custa, em percentual do faturamento — é o que transforma
   * o custo da nota em preço de venda sugerido. Só quando há itens: sem nota
   * completa não há custo para precificar, e a consulta seria à toa.
   */
  const percentuais = temItens ? await percentuaisDaOperacao() : null

  const podeGerarDespesas = Boolean(nota.xml && nota.situacaoXml === "completa")
  const duplicatas = podeGerarDespesas ? duplicatasDaNota(nota.xml!) : null
  const fornecedorDaDespesa = await fornecedorParaDespesa(nota.emitenteCnpj, nota.emitenteNome)
  const categorias = podeGerarDespesas ? await categoriasDeDespesa() : []
  // Endereço do emitente, tirado da própria nota — é o que dá para pré-preencher
  // no cadastro rápido de fornecedor quando não existe cadastro nenhum ainda.
  const enderecoEmitente = resumo
    ? { cidade: resumo.emitenteCidade, bairro: resumo.emitenteBairro }
    : null
  // Só faz sentido perguntar quando o cadastro rápido pode aparecer.
  const codigoSugerido = fornecedorDaDespesa.temCadastro
    ? null
    : await proximoCodigoDeFornecedor()

  return {
    nota,
    itensDaNota,
    duplicatas,
    fornecedorDaDespesa,
    categorias,
    enderecoEmitente,
    codigoSugerido,
    temItens,
    pedidos: pedidos.map((p) => ({
      id: p.id,
      numero: p.numero,
      situacao: p.situacao,
      itens: p.itens.map((i) => ({
        produtoId: i.produtoId,
        codigo: i.codigo,
        descricao: i.descricao,
        unidade: i.unidade,
        quantidade: i.quantidade,
        custoUnitario: i.custoUnitario,
      })),
    })),
    pedidoEscolhidoId: pedidoEscolhido?.id ?? "",
    itensComCusto,
    catalogo,
    percentuais,
    lojas: lojas.map((l) => l.codigo),
    recebidoAntes: Object.fromEntries(recebidoAntes),
  }
}

type RespostaCiencia =
  | { intencao: "ciencia"; ok: true; mensagem: string }
  | { intencao: "ciencia"; ok: false; erro: string }

type RespostaAction =
  | RespostaDespesas
  | RespostaEntrada
  | RespostaCiencia

export async function action({ request }: Route.ActionArgs): Promise<RespostaAction> {
  const eu = await exigirGerente(request, "buscarNotaFiscal")

  const form = await request.formData()
  const intencao = String(form.get("intencao") ?? "")

  if (intencao === "ciencia") {
    const resultado = await darCiencia(String(form.get("notaId") ?? ""), eu.nome)
    return resultado.ok
      ? { intencao: "ciencia", ok: true, mensagem: resultado.mensagem }
      : { intencao: "ciencia", ok: false, erro: resultado.erro }
  }

  if (intencao === "receber") {
    let itens: ItemReconciliado[] = []
    try {
      itens = JSON.parse(String(form.get("itens") ?? "[]"))
    } catch {
      itens = []
    }
    const resultado = await receberComNota(
      String(form.get("pedidoId") ?? "") || null,
      String(form.get("notaId") ?? ""),
      String(form.get("loja") ?? ""),
      eu.nome,
      itens
    )
    return { intencao: "receber", ...resultado }
  }

  if (intencao === "cadastrarProduto") {
    // Passa por `lerProduto`, o mesmo do cadastro de produtos, para as regras
    // (código obrigatório, descrição mínima, preço válido) valerem iguais nos
    // dois caminhos — cadastro rápido não é cadastro relaxado.
    await exigirGerente(request, "editarProdutos")
    const lido = lerProduto(form)
    if ("erro" in lido) return { intencao: "cadastrarProduto", ok: false, erro: lido.erro }

    const resultado = await criarProduto(lido)
    return resultado.ok
      ? {
          intencao: "cadastrarProduto",
          ok: true,
          linha: Number(form.get("linha") ?? 0),
          produtoId: resultado.produto.id,
        }
      : { intencao: "cadastrarProduto", ok: false, erro: resultado.erro }
  }

  if (intencao === "cadastrarFornecedor") {
    // Mesma guarda de /admin/fornecedores — cadastrar fornecedor não é sobre
    // dinheiro comprometido, é sobre o catálogo de quem se compra.
    await exigirGerente(request, "editarProdutos")
    const lido = lerFornecedor(form)
    const resultado = await criarFornecedor(lido)
    return resultado.ok
      ? {
          intencao: "cadastrarFornecedor",
          ok: true,
          nome: resultado.fornecedor.nomeFantasia || resultado.fornecedor.razaoSocial,
        }
      : { intencao: "cadastrarFornecedor", ok: false, erro: resultado.erro }
  }

  await exigirGerente(request, "gerarDespesas")
  let linhas: LinhaDeDespesa[] = []
  try {
    linhas = JSON.parse(String(form.get("linhas") ?? "[]"))
  } catch {
    linhas = []
  }
  const resultado = await gerarDespesas(
    { tipo: "nota", id: String(form.get("documentoId") ?? "") },
    linhas,
    eu.nome
  )
  return { intencao: "gerarDespesas", ...resultado }
}

export default function DetalheNotaDeEntrada({ loaderData }: Route.ComponentProps) {
  const {
    nota,
    itensDaNota,
    duplicatas,
    fornecedorDaDespesa,
    categorias,
    enderecoEmitente,
    codigoSugerido,
    temItens,
    pedidos,
    pedidoEscolhidoId,
    itensComCusto,
    catalogo,
    percentuais,
    lojas,
    recebidoAntes,
  } = loaderData

  const [params, setParams] = useSearchParams()

  // O pedido vive na URL para o loader poder buscar o "já recebido" dele — é
  // dado do servidor, não estado só de tela.
  function escolherPedido(pedidoId: string) {
    const proximos = new URLSearchParams(params)
    if (pedidoId) proximos.set("pedido", pedidoId)
    else proximos.set("pedido", "")
    setParams(proximos, { preventScrollReset: true })
  }

  const pedidoEscolhido = pedidos.find((p) => p.id === pedidoEscolhidoId) ?? null

  return (
    <div className="p-4 sm:p-6">
      <Link
        to="/admin/notas-de-entrada"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Notas de entrada
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <FileSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">
          {nota.emitenteNome} — nº {nota.numero ?? "—"}/{nota.serie ?? "—"}
        </h1>
      </div>

      <div className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Emitente</dt>
              <dd>
                {nota.emitenteNome} ({formatarCpfCnpj(nota.emitenteCnpj)})
              </dd>
              <dt className="text-muted-foreground">Nº / série</dt>
              <dd>
                {nota.numero ?? "—"} / {nota.serie ?? "—"}
              </dd>
              <dt className="text-muted-foreground">Emissão</dt>
              <dd>{nota.dataEmissao ? new Date(nota.dataEmissao).toLocaleString("pt-BR") : "—"}</dd>
              <dt className="text-muted-foreground">Valor total</dt>
              <dd>{nota.valorTotal != null ? moeda(nota.valorTotal) : "—"}</dd>
            </dl>
          </div>
        </div>

        <div>
          {nota.situacaoXml !== "completa" ? (
            <SoResumo nota={nota} />
          ) : itensDaNota && itensDaNota.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                    <th className="px-2 py-1.5">Código</th>
                    <th className="px-2 py-1.5">Descrição</th>
                    <th className="px-2 py-1.5 text-right">Qtd</th>
                    <th className="px-2 py-1.5 text-right">Unit.</th>
                    <th className="px-2 py-1.5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {itensDaNota.map((item, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-2 py-1.5">{item.codigo}</td>
                      <td className="px-2 py-1.5">{item.descricao}</td>
                      <td className="px-2 py-1.5 text-right">
                        {item.quantidade != null
                          ? `${formatarQuantidade(item.quantidade)} ${item.unidade ?? ""}`
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {item.valorUnitario != null ? moeda(item.valorUnitario) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {item.valorTotal != null ? moeda(item.valorTotal) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {temItens ? (
          <div className="rounded-lg border p-4">
            <EntradaDeNota
              notaId={nota.id}
              itensDaNota={itensComCusto}
              pedidos={pedidos}
              pedidoEscolhido={pedidoEscolhido}
              onEscolherPedido={escolherPedido}
              catalogo={catalogo}
              percentuais={percentuais}
              lojas={lojas}
              recebidoAntes={recebidoAntes}
              jaRecebida={nota.situacao === "recebida"}
              recebidoEm={nota.recebidoEm ? String(nota.recebidoEm) : null}
              recebidoPor={nota.recebidoPor}
            />
          </div>
        ) : null}

        <div className="rounded-lg border p-4">
          <GerarDespesas
            documento={{
              tipo: "nota",
              id: nota.id,
              // O número da fatura nomeia as parcelas quando a nota o declara;
              // sem ele, o número da própria nota é o que quem paga reconhece.
              numero: duplicatas?.numeroFatura ?? String(nota.numero ?? ""),
              valorTotal: nota.valorTotal,
              despesasGeradasEm: nota.despesasGeradasEm,
              despesasGeradasPor: nota.despesasGeradasPor,
            }}
            duplicatas={duplicatas?.duplicatas ?? null}
            fornecedor={fornecedorDaDespesa}
            categorias={categorias}
            cadastroRapido={{
              emitenteCnpj: nota.emitenteCnpj,
              emitenteNome: nota.emitenteNome,
              endereco: enderecoEmitente,
              codigoSugerido,
            }}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * O que a tela mostra quando só veio o resumo.
 *
 * Antes dizia que a SEFAZ "já não distribui o XML completo para esta nota
 * (mais antiga)", o que está errado na maioria dos casos: o motivo comum não é
 * a idade da nota, é a falta da manifestação. Enquanto o destinatário não dá
 * Ciência da Operação, a SEFAZ entrega só o resumo — e resumo não tem itens,
 * então não há entrada de estoque nem conta a pagar.
 *
 * Depois da ciência o XML não chega na hora: quem distribui é o serviço de
 * distribuição, no ciclo dele. Por isso o estado "já pedi" existe e tem texto
 * próprio — sem ele alguém clicaria de novo achando que falhou.
 */
function SoResumo({
  nota,
}: {
  nota: { id: string; cienciaEm: string | Date | null; cienciaProtocolo: string | null }
}) {
  const fetcher = useFetcher<typeof action>()
  const enviando = fetcher.state !== "idle"
  const resposta = fetcher.data?.intencao === "ciencia" ? fetcher.data : null

  if (nota.cienciaEm) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
        <p className="text-sm font-medium">Ciência registrada, esperando o XML</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Dada em {new Date(nota.cienciaEm).toLocaleString("pt-BR")}
          {nota.cienciaProtocolo ? ` · protocolo ${nota.cienciaProtocolo}` : ""}. O XML
          completo com os itens vem no próximo ciclo de distribuição da SEFAZ — sincronize
          as notas de entrada daqui a pouco.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <p className="text-sm font-medium text-amber-700 dark:text-amber-500">
        Só o resumo chegou — sem os itens
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        A SEFAZ distribui só emitente, data e valor até o destinatário se manifestar. A{" "}
        <strong className="font-medium text-foreground">Ciência da Operação</strong> libera
        o XML completo: ela apenas declara que você sabe que a nota existe — não confirma
        recebimento de mercadoria e não impede o emitente de cancelar.
      </p>

      <fetcher.Form method="post" className="mt-3">
        <input type="hidden" name="intencao" value="ciencia" />
        <input type="hidden" name="notaId" value={nota.id} />
        <Button type="submit" size="sm" variant="outline" disabled={enviando} className="rounded-lg">
          <FileCheck className="size-4" />
          {enviando ? "Registrando…" : "Dar ciência da operação"}
        </Button>
      </fetcher.Form>

      {resposta ? (
        <p
          className={cn(
            "mt-2 text-xs font-medium",
            resposta.ok ? "text-foreground" : "text-destructive"
          )}
          role="status"
        >
          {resposta.ok ? resposta.mensagem : resposta.erro}
        </p>
      ) : null}
    </div>
  )
}
