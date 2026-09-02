import { db } from "~/lib/db.server"
import { validarCest, validarCfop, validarCsosn, validarOrigem } from "~/lib/fiscal"
import { interpretarValor } from "~/lib/moeda"

export type ProdutoEntrada = {
  codigo: string
  descricao: string
  unidade: string
  preco: number
  /** Preço unitário a partir de `quantidadeCombo`. Nulo quando não há combo. */
  precoCombo: number | null
  quantidadeCombo: number | null
  ncm: string | null
  /**
   * Tributação própria, quando difere do padrão da loja. Vazios na esmagadora
   * maioria: só substituição tributária e casos de isenção precisam disso.
   */
  origemFiscal: string | null
  cfop: string | null
  csosn: string | null
  cest: string | null
}

/**
 * Só produto ativo aparece no caixa e nas buscas.
 *
 * Repare onde este filtro **não** entra: `precificar` (em vendas.server) busca por
 * id sem olhar `ativo`, de propósito. Desativar um produto com o carrinho aberto
 * não pode fazer a venda falhar no fechamento — desativar tira das buscas, não
 * invalida o que já está lançado. E `emitirParaVenda` idem, para venda antiga
 * continuar podendo emitir boleto.
 */
export const SOMENTE_ATIVOS = { ativo: true } as const

export type ResultadoProduto =
  | { ok: true; produto: { id: string; codigo: string; descricao: string } }
  | { ok: false; erro: string }

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

function texto(valor: FormDataEntryValue | null) {
  return typeof valor === "string" ? valor.trim() : ""
}

/**
 * Lê e valida o produto do formulário.
 *
 * O preço passa por `interpretarValor`, o mesmo do caixa, para "12,50" e "12.50"
 * valerem o mesmo — quem cadastra digita com vírgula, e um preço lido como 1250
 * viraria uma venda errada.
 */
export function lerProduto(form: FormData): ProdutoEntrada | { erro: string } {
  const codigo = texto(form.get("codigo"))
  const descricao = texto(form.get("descricao"))
  const unidade = texto(form.get("unidade")).toUpperCase()
  const preco = interpretarValor(texto(form.get("preco")))
  const ncm = texto(form.get("ncm")).replace(/\D/g, "")

  const origemFiscal = texto(form.get("origemFiscal")).replace(/\D/g, "")
  const cfop = texto(form.get("cfop")).replace(/\D/g, "")
  const csosn = texto(form.get("csosn")).replace(/\D/g, "")
  const cest = texto(form.get("cest")).replace(/\D/g, "")

  const precoComboBruto = texto(form.get("precoCombo"))
  const quantidadeComboBruta = texto(form.get("quantidadeCombo"))
  const precoCombo = precoComboBruto ? interpretarValor(precoComboBruto) : null
  const quantidadeCombo = quantidadeComboBruta ? interpretarValor(quantidadeComboBruta) : null

  if (!codigo) return { erro: "Informe o código" }
  if (codigo.length > 20) return { erro: "Código longo demais" }
  if (descricao.length < 3) return { erro: "Descrição precisa de pelo menos 3 letras" }
  if (!unidade) return { erro: "Informe a unidade (PC, UN, CX…)" }
  if (unidade.length > 6) return { erro: "Unidade longa demais" }
  if (preco === null || preco < 0) return { erro: "Preço inválido" }
  // Vazio é aceito (o campo é opcional), mas preenchido pela metade não: um NCM
  // de 6 dígitos rejeita a NF-e inteira na SEFAZ, e o erro só apareceria na
  // emissão — longe daqui, com o cliente esperando.
  if (ncm && ncm.length !== 8) return { erro: "NCM precisa ter 8 dígitos" }

  /*
   * Os fiscais seguem a mesma regra do NCM: vazio é aceito (quem manda é o
   * padrão da loja), torto não. Um CFOP de 3 dígitos derruba a nota inteira na
   * SEFAZ, e não só o item.
   */
  if (origemFiscal && !validarOrigem(origemFiscal)) {
    return { erro: "Origem é um dígito de 0 a 8 (0 = nacional)" }
  }
  if (cfop && !validarCfop(cfop)) return { erro: "CFOP precisa ter 4 dígitos" }
  if (csosn && !validarCsosn(csosn)) return { erro: "CSOSN precisa ter 3 dígitos" }
  if (cest && !validarCest(cest)) return { erro: "CEST precisa ter 7 dígitos" }
  // O CEST só existe para descrever mercadoria de substituição tributária: sem o
  // CSOSN que a declara, ele iria para a nota descrevendo o que ela não é.
  if (cest && !csosn) {
    return { erro: "CEST sem CSOSN: informe também a tributação (500, para ST)" }
  }

  /*
   * Os dois campos do combo andam juntos. Preenchido pela metade seria uma
   * faixa que não descreve nada — e, pior, silenciosa: o caixa continuaria
   * cobrando o preço avulso sem ninguém entender por quê.
   */
  if (precoComboBruto && !quantidadeComboBruta) {
    return { erro: "Informe a partir de quantas unidades vale o preço de combo" }
  }
  if (quantidadeComboBruta && !precoComboBruto) {
    return { erro: "Informe o preço de combo" }
  }
  if (precoComboBruto && (precoCombo === null || precoCombo < 0)) {
    return { erro: "Preço de combo inválido" }
  }
  if (quantidadeComboBruta && (quantidadeCombo === null || quantidadeCombo <= 0)) {
    return { erro: "Quantidade do combo inválida" }
  }
  // Combo mais caro que o avulso é quase certamente dígito trocado, e o
  // prejuízo só apareceria no fechamento do mês.
  if (precoCombo !== null && precoCombo > preco) {
    return { erro: "O preço de combo está acima do preço avulso" }
  }

  return {
    codigo,
    descricao,
    unidade,
    preco,
    precoCombo,
    quantidadeCombo,
    ncm: ncm || null,
    origemFiscal: origemFiscal || null,
    cfop: cfop || null,
    csosn: csosn || null,
    cest: cest || null,
  }
}

export async function criarProduto(entrada: ProdutoEntrada): Promise<ResultadoProduto> {
  // `codigo` não é único no catálogo: 55 códigos já se repetem hoje, e o caixa
  // resolve mostrando a lista quando o código é ambíguo. Não barramos aqui.
  const produto = await db.produto.create({ data: entrada })
  return { ok: true, produto }
}

export async function atualizarProduto(
  id: string,
  entrada: ProdutoEntrada,
  /** Quem está mexendo. Preço é dinheiro: a mudança fica com nome e hora. */
  quem?: { nome: string; id: string }
): Promise<ResultadoProduto> {
  if (!OBJECT_ID.test(id)) return { ok: false, erro: "Produto inválido" }

  const existente = await db.produto.findUnique({ where: { id } })
  if (!existente) return { ok: false, erro: "Produto não encontrado" }

  const produto = await db.produto.update({ where: { id }, data: entrada })

  /**
   * O registro entra DEPOIS da alteração e fora de transação, de propósito.
   *
   * Se o registro falhasse dentro de uma transação, a mudança de preço seria
   * desfeita — e travar a edição do catálogo porque o log falhou é pior do que
   * um log com uma lacuna. A lacuna, se acontecer, aparece: o preço da ficha
   * não bate com a última linha do histórico.
   */
  if (quem && existente.preco !== produto.preco) {
    await db.alteracaoDePreco.create({
      data: {
        produtoId: produto.id,
        de: existente.preco,
        para: produto.preco,
        operador: quem.nome,
        operadorId: quem.id,
      },
    })
  }

  return { ok: true, produto }
}

/** O histórico de preço de um produto, do mais recente para o mais antigo. */
export function alteracoesDePreco(produtoId: string, limite = 40) {
  return db.alteracaoDePreco.findMany({
    where: { produtoId },
    orderBy: { criadoEm: "desc" },
    take: limite,
  })
}

/**
 * As últimas alterações de preço da rede inteira.
 *
 * É a lista que responde "quem andou mexendo em preço" — a pergunta que não
 * tinha resposta antes. Traz a descrição junto porque um id de produto não diz
 * nada a quem está lendo.
 */
export async function ultimasAlteracoesDePreco(limite = 30) {
  const alteracoes = await db.alteracaoDePreco.findMany({
    orderBy: { criadoEm: "desc" },
    take: limite,
  })

  const produtos = await db.produto.findMany({
    where: { id: { in: [...new Set(alteracoes.map((a) => a.produtoId))] } },
    select: { id: true, codigo: true, descricao: true, unidade: true },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  return alteracoes.map((a) => ({
    ...a,
    codigo: porId.get(a.produtoId)?.codigo ?? "—",
    descricao: porId.get(a.produtoId)?.descricao ?? "(produto removido)",
  }))
}

/** Quantos produtos repetem cada código — o caixa precisa desambiguar esses. */
export async function codigosRepetidos(): Promise<Set<string>> {
  const grupos = await db.produto.groupBy({
    by: ["codigo"],
    where: SOMENTE_ATIVOS,
    _count: { _all: true },
    having: { codigo: { _count: { gt: 1 } } },
  })
  return new Set(grupos.map((g) => g.codigo))
}

/**
 * Desativa ou reativa. Não existe apagar: o item da venda guarda descrição e
 * preço copiados, mas o relatório e o estoque referenciam o produtoId — apagar
 * deixaria movimento de estoque apontando para o nada.
 */
export async function alternarProduto(id: string) {
  if (!OBJECT_ID.test(id)) return { ok: false as const, erro: "Produto inválido" }

  const produto = await db.produto.findUnique({ where: { id } })
  if (!produto) return { ok: false as const, erro: "Produto não encontrado" }

  const atualizado = await db.produto.update({
    where: { id },
    data: { ativo: !produto.ativo },
  })
  return {
    ok: true as const,
    mensagem: `${atualizado.descricao} ${atualizado.ativo ? "reativado" : "desativado"}`,
  }
}
