import { useEffect, useState } from "react"
import { Link, useFetcher, useSearchParams } from "react-router"
import { ArrowLeft, FileSearch } from "lucide-react"

import type { Route } from "./+types/admin.notas-de-entrada.$notaId"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { formatarCpfCnpj } from "~/lib/documento"
import { interpretarValor, moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import {
  categoriasDeDespesa,
  duplicatasDaNota,
  fornecedorParaDespesa,
  gerarDespesas,
  type LinhaDeDespesa,
  type ResultadoGerarDespesas,
} from "~/lib/despesas.server"
import { notaPorId } from "~/lib/notas-fiscais.server"
import { criarFornecedor, lerFornecedor, proximoCodigoDeFornecedor } from "~/lib/fornecedores.server"
import { resumoDoProcNFe } from "~/lib/sefaz.server"
import { exigirGerente } from "~/lib/sessao.server"
import { EntradaDeNota, type RespostaEntrada } from "~/components/pdv/entrada-de-nota"
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
          select: { id: true, codigo: true, descricao: true, unidade: true },
        }),
        pedidoEscolhido ? recebidoPorProduto(pedidoEscolhido.id) : new Map<string, number>(),
      ])
    : [[], [], new Map<string, number>()]

  const itensComCusto = temItens ? itensComCustoDaNota(nota.xml!) : []

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
    lojas: lojas.map((l) => l.codigo),
    recebidoAntes: Object.fromEntries(recebidoAntes),
  }
}

type RespostaAction =
  | ({ intencao: "gerarDespesas" } & ResultadoGerarDespesas)
  | { intencao: "cadastrarFornecedor"; ok: true; nome: string }
  | { intencao: "cadastrarFornecedor"; ok: false; erro: string }
  | RespostaEntrada

export async function action({ request }: Route.ActionArgs): Promise<RespostaAction> {
  const eu = await exigirGerente(request, "buscarNotaFiscal")

  const form = await request.formData()
  const intencao = String(form.get("intencao") ?? "")

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
  const notaId = String(form.get("notaId") ?? "")
  let linhas: LinhaDeDespesa[] = []
  try {
    linhas = JSON.parse(String(form.get("linhas") ?? "[]"))
  } catch {
    linhas = []
  }
  const resultado = await gerarDespesas(notaId, linhas, eu.nome)
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
            <p className="text-sm text-amber-600 dark:text-amber-500">
              Só o resumo está disponível — a SEFAZ já não distribui o XML completo com os
              itens para esta nota (mais antiga).
            </p>
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
            nota={nota}
            duplicatas={duplicatas}
            fornecedorDaDespesa={fornecedorDaDespesa}
            categorias={categorias}
            enderecoEmitente={enderecoEmitente}
            codigoSugerido={codigoSugerido}
          />
        </div>
      </div>
    </div>
  )
}

type NotaComDetalhe = NonNullable<Awaited<ReturnType<typeof notaPorId>>>
type DuplicatasDaNota = ReturnType<typeof duplicatasDaNota>
type FornecedorDaDespesa = Awaited<ReturnType<typeof fornecedorParaDespesa>>
type CategoriaDeDespesa = Awaited<ReturnType<typeof categoriasDeDespesa>>[number]
type EnderecoEmitente = { cidade: string | null; bairro: string | null } | null

type LinhaEditavel = {
  conta: string
  tipo: string
  descricao: string
  valorTexto: string
  data: string
}

function hojeComoDia() {
  const hoje = new Date()
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`
}

/**
 * Gera as contas a pagar (`despesas`) a partir dos vencimentos da própria
 * nota — a coleção não é deste projeto, é do sistema de contas a pagar que a
 * rede já usa; aqui só nasce o título, com a mesma cara que os já existentes.
 *
 * Sem duplicata na nota (à vista, sem boleto formal) começa com uma linha só,
 * pelo valor total, para não obrigar o gerente a montar do zero. "Acrescentar
 * linha" cobre o que às vezes vem por fora do que a nota lista.
 */
function GerarDespesas({
  nota,
  duplicatas,
  fornecedorDaDespesa,
  categorias,
  enderecoEmitente,
  codigoSugerido,
}: {
  nota: NotaComDetalhe
  duplicatas: DuplicatasDaNota | null
  fornecedorDaDespesa: FornecedorDaDespesa | null
  categorias: CategoriaDeDespesa[]
  enderecoEmitente: EnderecoEmitente
  codigoSugerido: string | null
}) {
  const fetcher = useFetcher<RespostaAction>()
  const cadastroFetcher = useFetcher<RespostaAction>()
  const gerando = fetcher.state !== "idle"

  const [cadastroAberto, setCadastroAberto] = useState(false)
  // Cadastrado agora mesmo, nesta tela: sobrepõe o que veio do loader sem
  // precisar recarregar a página para o aviso âmbar sumir.
  const [nomeCadastradoAgora, setNomeCadastradoAgora] = useState<string | null>(null)

  useEffect(() => {
    const resposta = cadastroFetcher.data
    if (resposta?.intencao !== "cadastrarFornecedor" || !resposta.ok) return
    setNomeCadastradoAgora(resposta.nome)
    setCadastroAberto(false)
  }, [cadastroFetcher.data])

  const temCadastro = nomeCadastradoAgora != null || (fornecedorDaDespesa?.temCadastro ?? false)
  const nomeDoFornecedor = nomeCadastradoAgora ?? fornecedorDaDespesa?.nome ?? nota.emitenteNome
  // "revenda" quando a categoria ainda não foi carregada — mesmo valor que a
  // coleção `contas` já usa para compra de mercadoria para revender.
  const categoriaPadrao = categorias.find((c) => c.conta === "revenda")?.conta ?? "revenda"

  const [linhas, setLinhas] = useState<LinhaEditavel[]>(() => {
    const parcelas = duplicatas?.duplicatas ?? []

    if (parcelas.length === 0) {
      return [
        {
          conta: categoriaPadrao,
          tipo: "variavel",
          descricao: nomeDoFornecedor,
          valorTexto: nota.valorTotal != null ? String(nota.valorTotal).replace(".", ",") : "",
          data: hojeComoDia(),
        },
      ]
    }

    const numero = duplicatas?.numeroFatura ?? String(nota.numero ?? "")
    return parcelas.map((p, i) => ({
      conta: categoriaPadrao,
      tipo: "variavel",
      descricao: `${numero} ${i + 1}/${parcelas.length}`.trim(),
      valorTexto: String(p.valor).replace(".", ","),
      data: p.vencimento ?? "",
    }))
  })

  function atualizar(i: number, campo: keyof LinhaEditavel, valor: string) {
    setLinhas((atual) => atual.map((linha, idx) => (idx === i ? { ...linha, [campo]: valor } : linha)))
  }

  function adicionar() {
    setLinhas((atual) => [
      ...atual,
      {
        conta: categoriaPadrao,
        tipo: "variavel",
        descricao: nomeDoFornecedor,
        valorTexto: "",
        data: hojeComoDia(),
      },
    ])
  }

  function remover(i: number) {
    setLinhas((atual) => atual.filter((_, idx) => idx !== i))
  }

  function gerar() {
    const payload: LinhaDeDespesa[] = linhas.map((l) => ({
      conta: l.conta.trim() || categoriaPadrao,
      tipo: l.tipo.trim() || "variavel",
      descricao: l.descricao.trim(),
      valor: interpretarValor(l.valorTexto) ?? 0,
      data: l.data,
      // Só se preenche depois de pagar, no outro sistema — nasce sempre em
      // branco daqui, e nem aparece como campo nesta tela.
      contaCorrente: null,
    }))
    fetcher.submit(
      { intencao: "gerarDespesas", notaId: nota.id, linhas: JSON.stringify(payload) },
      { method: "post" }
    )
  }

  const totalLancado = linhas.reduce((soma, l) => soma + (interpretarValor(l.valorTexto) ?? 0), 0)
  const diferenca = nota.valorTotal != null ? totalLancado - nota.valorTotal : null

  if (nota.despesasGeradasEm) {
    return (
      <div className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3 text-xs">
        Contas a pagar geradas em {new Date(nota.despesasGeradasEm).toLocaleString("pt-BR")}
        {nota.despesasGeradasPor ? ` por ${nota.despesasGeradasPor}` : ""}.
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Contas a pagar</h3>
        <Button type="button" size="xs" variant="ghost" onClick={adicionar}>
          + Acrescentar linha
        </Button>
      </div>

      {fornecedorDaDespesa && !temCadastro ? (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-amber-600/30 bg-amber-600/5 p-2">
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Este fornecedor não tem cadastro — usando o nome da própria nota (
            {nomeDoFornecedor}), não o nome fantasia.
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="shrink-0"
            onClick={() => setCadastroAberto(true)}
          >
            Cadastrar fornecedor
          </Button>
        </div>
      ) : null}

      <CadastroDeFornecedor
        open={cadastroAberto}
        onOpenChange={setCadastroAberto}
        emitenteCnpj={nota.emitenteCnpj}
        emitenteNome={nota.emitenteNome}
        endereco={enderecoEmitente}
        codigoSugerido={codigoSugerido}
        fetcher={cadastroFetcher}
      />

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="w-36 py-1 pr-2">Vencimento</th>
              <th className="w-28 py-1 pr-2 text-right">Valor</th>
              <th className="py-1 pr-2">Descrição</th>
              <th className="w-40 py-1 pr-2">Conta</th>
              <th className="w-28 py-1 pr-2">Tipo</th>
              <th className="w-8 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((linha, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1 pr-2">
                  <input
                    type="date"
                    value={linha.data}
                    onChange={(e) => atualizar(i, "data", e.target.value)}
                    className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={linha.valorTexto}
                    onChange={(e) => atualizar(i, "valorTexto", e.target.value)}
                    className="h-7 w-full text-right font-mono text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={linha.descricao}
                    onChange={(e) => atualizar(i, "descricao", e.target.value)}
                    className="h-7 w-full min-w-40 text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={linha.conta}
                    onChange={(e) => atualizar(i, "conta", e.target.value)}
                    className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
                  >
                    {categorias.map((c) => (
                      <option key={c.id} value={c.conta}>
                        {c.etiqueta}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={linha.tipo}
                    onChange={(e) => atualizar(i, "tipo", e.target.value)}
                    className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
                  >
                    <option value="variavel">variável</option>
                    <option value="fixa">fixa</option>
                  </select>
                </td>
                <td className="py-1">
                  <Button type="button" size="xs" variant="ghost" onClick={() => remover(i)}>
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Total lançado: {moeda(totalLancado)}
          {diferenca != null && Math.abs(diferenca) > 0.01 ? (
            <span className="ml-1 text-amber-600 dark:text-amber-500">
              ({diferenca > 0 ? "+" : ""}
              {moeda(diferenca)} vs. valor da nota)
            </span>
          ) : null}
        </span>

        <Button
          type="button"
          size="sm"
          disabled={gerando || linhas.length === 0}
          onClick={gerar}
          className="ml-auto"
        >
          {gerando ? "Gerando…" : "Gerar contas a pagar"}
        </Button>
      </div>

      {fetcher.data?.intencao === "gerarDespesas" && !fetcher.data.ok ? (
        <p className="mt-1 text-xs text-destructive">{fetcher.data.erro}</p>
      ) : null}
    </div>
  )
}

/**
 * Cadastro rápido do fornecedor, num dialog aberto direto de "Contas a
 * pagar" quando o CNPJ da nota não bate com nenhum cadastro — mesma ideia do
 * cadastro rápido de produto na conciliação: pré-preenche com o que a NF-e
 * já traz (razão social, CNPJ, cidade e bairro do emitente) e deixa tudo
 * editável, porque "código" e "nome fantasia" são coisa que só quem cadastra
 * sabe escolher.
 */
function CadastroDeFornecedor({
  open,
  onOpenChange,
  emitenteCnpj,
  emitenteNome,
  endereco,
  codigoSugerido,
  fetcher,
}: {
  open: boolean
  onOpenChange: (aberto: boolean) => void
  emitenteCnpj: string
  emitenteNome: string
  endereco: EnderecoEmitente
  codigoSugerido: string | null
  fetcher: ReturnType<typeof useFetcher<RespostaAction>>
}) {
  const [codigo, setCodigo] = useState(codigoSugerido ?? "")
  const [razaoSocial, setRazaoSocial] = useState(emitenteNome)
  const [nomeFantasia, setNomeFantasia] = useState("")
  const [cidade, setCidade] = useState(endereco?.cidade ?? "")
  const [bairro, setBairro] = useState(endereco?.bairro ?? "")

  const cadastrando = fetcher.state !== "idle"
  const resposta = fetcher.data
  const erro = resposta?.intencao === "cadastrarFornecedor" && !resposta.ok ? resposta.erro : null

  function cadastrar() {
    fetcher.submit(
      {
        intencao: "cadastrarFornecedor",
        codigo,
        razaoSocial,
        nomeFantasia,
        documento: emitenteCnpj,
        cidade,
        bairro,
      },
      { method: "post" }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cadastrar fornecedor</DialogTitle>
          <DialogDescription>
            Pré-preenchido com o que a nota fiscal já traz, e o código com o próximo livre —
            confira e complete o que faltar.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-codigo">Código</Label>
              <Input
                id="fornecedor-codigo"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-fantasia">Nome fantasia</Label>
              {/* O foco começa aqui, e não no código: aquele já vem preenchido,
                  este é o que sempre precisa ser digitado. */}
              <Input
                id="fornecedor-fantasia"
                autoFocus
                value={nomeFantasia}
                onChange={(e) => setNomeFantasia(e.target.value)}
                placeholder="Como se conhece no dia a dia"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fornecedor-razao">Razão social</Label>
            <Input id="fornecedor-razao" value={razaoSocial} onChange={(e) => setRazaoSocial(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>CNPJ</Label>
            <p className="text-sm text-muted-foreground">{formatarCpfCnpj(emitenteCnpj)}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-cidade">Cidade</Label>
              <Input id="fornecedor-cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-bairro">Bairro</Label>
              <Input id="fornecedor-bairro" value={bairro} onChange={(e) => setBairro(e.target.value)} />
            </div>
          </div>

          {erro ? <p className="text-sm text-destructive">{erro}</p> : null}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
          <Button type="button" disabled={cadastrando} onClick={cadastrar}>
            {cadastrando ? "Cadastrando…" : "Cadastrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
