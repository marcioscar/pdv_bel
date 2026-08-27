import { arredondar } from "~/lib/moeda"

export type ProdutoCatalogo = {
  id: string
  codigo: string
  descricao: string
  unidade: string
  preco: number
  precoCombo: number | null
  quantidadeCombo: number | null
  estoque: number
}

export type ItemVenda = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  /** Preço avulso do catálogo. O que se cobra sai de `precoAplicado`. */
  preco: number
  precoCombo: number | null
  quantidadeCombo: number | null
  quantidade: number
  /** Estoque no momento em que o item entrou, só para sinalizar falta na tela. */
  estoque: number
}

/** O que basta para saber quanto custa: o produto e quantas se leva. */
export type PrecoDoProduto = {
  preco: number
  precoCombo: number | null
  quantidadeCombo: number | null
}

/**
 * O preço unitário que vale para ESTA quantidade, e se ele veio do combo.
 *
 * Mora aqui, e não no carrinho nem no servidor, porque os DOIS precisam da
 * mesma resposta: a tela mostra o que o caixa vai cobrar, e `precificar`
 * recalcula do banco na hora de gravar. Duas implementações da mesma regra é
 * como se mostra um total ao cliente e se cobra outro.
 *
 * O preço não é guardado no item do carrinho de propósito — ele muda quando a
 * quantidade muda, e um valor copiado ficaria defasado no `+`/`−`.
 *
 * A partir do degrau, TODAS as unidades saem no preço de combo. Cobrar as
 * excedentes ao preço avulso faria levar 11 custar mais que levar 10.
 */
export function precoAplicado(
  produto: PrecoDoProduto,
  quantidade: number
): { preco: number; combo: boolean } {
  const { precoCombo, quantidadeCombo } = produto
  // Faixa incompleta não é faixa: sem os dois valores não há o que aplicar.
  if (precoCombo == null || quantidadeCombo == null || quantidadeCombo <= 0) {
    return { preco: produto.preco, combo: false }
  }
  if (quantidade < quantidadeCombo) return { preco: produto.preco, combo: false }
  return { preco: precoCombo, combo: true }
}

export type EstadoVenda = {
  itens: ItemVenda[]
  /** -1 quando o carrinho está vazio. */
  indiceAtivo: number
  desconto: number
}

export const vendaVazia: EstadoVenda = { itens: [], indiceAtivo: -1, desconto: 0 }

export type AcaoVenda =
  | { tipo: "adicionar"; produto: ProdutoCatalogo; quantidade: number }
  | { tipo: "remover"; indice?: number }
  | { tipo: "definirQuantidade"; indice: number; quantidade: number }
  | { tipo: "ajustarQuantidade"; delta: number }
  | { tipo: "mover"; delta: number }
  | { tipo: "selecionar"; indice: number }
  | { tipo: "definirDesconto"; valor: number }
  | { tipo: "limpar" }

function limitar(indice: number, total: number) {
  if (total === 0) return -1
  return Math.min(Math.max(indice, 0), total - 1)
}

export function reduzirVenda(estado: EstadoVenda, acao: AcaoVenda): EstadoVenda {
  switch (acao.tipo) {
    case "adicionar": {
      const { produto, quantidade } = acao
      const existente = estado.itens.findIndex((item) => item.produtoId === produto.id)

      if (existente >= 0) {
        const itens = estado.itens.map((item, i) =>
          i === existente
            ? { ...item, quantidade: arredondar(item.quantidade + quantidade) }
            : item
        )
        return { ...estado, itens, indiceAtivo: existente }
      }

      const itens = [
        ...estado.itens,
        {
          produtoId: produto.id,
          codigo: produto.codigo,
          descricao: produto.descricao,
          unidade: produto.unidade,
          preco: produto.preco,
          precoCombo: produto.precoCombo,
          quantidadeCombo: produto.quantidadeCombo,
          quantidade,
          estoque: produto.estoque,
        },
      ]
      return { ...estado, itens, indiceAtivo: itens.length - 1 }
    }

    case "remover": {
      const alvo = acao.indice ?? estado.indiceAtivo
      if (alvo < 0 || alvo >= estado.itens.length) return estado

      const itens = estado.itens.filter((_, i) => i !== alvo)
      return { ...estado, itens, indiceAtivo: limitar(alvo, itens.length) }
    }

    case "definirQuantidade": {
      const { indice, quantidade } = acao
      if (indice < 0 || indice >= estado.itens.length) return estado
      if (quantidade <= 0) return reduzirVenda(estado, { tipo: "remover", indice })

      const itens = estado.itens.map((item, i) =>
        i === indice ? { ...item, quantidade: arredondar(quantidade) } : item
      )
      return { ...estado, itens }
    }

    case "ajustarQuantidade": {
      const indice = estado.indiceAtivo
      if (indice < 0) return estado

      const atual = estado.itens[indice].quantidade
      return reduzirVenda(estado, {
        tipo: "definirQuantidade",
        indice,
        quantidade: atual + acao.delta,
      })
    }

    case "mover":
      if (estado.itens.length === 0) return estado
      return {
        ...estado,
        indiceAtivo: limitar(estado.indiceAtivo + acao.delta, estado.itens.length),
      }

    case "selecionar":
      return { ...estado, indiceAtivo: limitar(acao.indice, estado.itens.length) }

    case "definirDesconto":
      return { ...estado, desconto: Math.max(0, arredondar(acao.valor)) }

    case "limpar":
      return vendaVazia
  }
}

export function totaisDaVenda(estado: EstadoVenda) {
  const subtotal = arredondar(
    estado.itens.reduce(
      (acc, item) => acc + precoAplicado(item, item.quantidade).preco * item.quantidade,
      0
    )
  )
  // Um desconto maior que o subtotal nunca vira total negativo.
  const desconto = Math.min(estado.desconto, subtotal)
  const volumes = arredondar(estado.itens.reduce((acc, item) => acc + item.quantidade, 0))

  return { subtotal, desconto, total: arredondar(subtotal - desconto), volumes }
}

// ---------------------------------------------------------------------------
// Interpretação da barra de comando
// ---------------------------------------------------------------------------

export type Comando =
  | { tipo: "vazio" }
  | { tipo: "codigo"; codigo: string; quantidade: number }
  | { tipo: "texto"; termo: string; quantidade: number }

/** "3*141", "3x141", "2 X papel" — quantidade, separador, alvo. */
const MULTIPLICADOR = /^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.+)$/
const SOMENTE_DIGITOS = /^\d+$/

export function interpretarComando(entrada: string): Comando {
  const bruto = entrada.trim()
  if (!bruto) return { tipo: "vazio" }

  const multiplicado = MULTIPLICADOR.exec(bruto)
  if (multiplicado) {
    const quantidade = Number(multiplicado[1].replace(",", "."))
    const alvo = multiplicado[2].trim()

    if (quantidade > 0 && alvo) {
      return SOMENTE_DIGITOS.test(alvo)
        ? { tipo: "codigo", codigo: alvo, quantidade }
        : { tipo: "texto", termo: alvo, quantidade }
    }
  }

  if (SOMENTE_DIGITOS.test(bruto)) {
    return { tipo: "codigo", codigo: bruto, quantidade: 1 }
  }

  return { tipo: "texto", termo: bruto, quantidade: 1 }
}

// ---------------------------------------------------------------------------
// Busca no catálogo
// ---------------------------------------------------------------------------

/**
 * Genérico no produto de propósito: o índice só precisa de código, descrição e
 * unidade para buscar. As telas de ficha e de estoque carregam produtos com
 * outras colunas e sem as de preço — obrigá-las a trazer o catálogo inteiro só
 * para caber num tipo seria carregar dado que aquelas telas não usam.
 */
export type EntradaIndice<T = ProdutoCatalogo> = { produto: T; chave: string }

type Buscavel = { codigo: string; descricao: string; unidade: string }

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

/**
 * O catálogo inteiro vem no loader, então a busca roda no cliente e responde
 * sem latência a cada tecla. Normalizar uma vez evita refazer isso por keystroke.
 */
export function criarIndice<T extends Buscavel>(catalogo: T[]): EntradaIndice<T>[] {
  return catalogo.map((produto) => ({
    produto,
    chave: normalizar(`${produto.codigo} ${produto.descricao} ${produto.unidade}`),
  }))
}

export function buscarProdutos<T extends Buscavel>(
  indice: EntradaIndice<T>[],
  termo: string,
  limite = 7
): T[] {
  const termos = normalizar(termo).split(/\s+/).filter(Boolean)
  if (termos.length === 0) return []

  const encontrados: { produto: T; peso: number }[] = []

  for (const entrada of indice) {
    if (!termos.every((t) => entrada.chave.includes(t))) continue
    // Quem começa com o termo digitado aparece primeiro.
    encontrados.push({
      produto: entrada.produto,
      peso: entrada.chave.startsWith(termos[0]) ? 0 : 1,
    })
  }

  return encontrados
    .sort((a, b) => a.peso - b.peso || a.produto.descricao.length - b.produto.descricao.length)
    .slice(0, limite)
    .map((e) => e.produto)
}

export function produtosPorCodigo(catalogo: ProdutoCatalogo[], codigo: string) {
  return catalogo.filter((produto) => produto.codigo === codigo)
}

// ---------------------------------------------------------------------------
// Pagamento
// ---------------------------------------------------------------------------

export const FORMAS_PAGAMENTO = [
  { id: "dinheiro", rotulo: "Dinheiro" },
  { id: "credito", rotulo: "Crédito" },
  { id: "debito", rotulo: "Débito" },
  { id: "pix", rotulo: "Pix" },
  { id: "prazo", rotulo: "A prazo" },
] as const

export type FormaPagamento = (typeof FORMAS_PAGAMENTO)[number]["id"]

/** Venda a prazo vira boleto: exige cliente com endereço e respeita o mínimo do Inter. */
export const VALOR_MINIMO_BOLETO = 2.5

/**
 * Condições de pagamento a prazo. Fixas de propósito: deixar o vendedor digitar
 * dias é fonte de erro e de combinação fora da política da empresa.
 *
 * `dias` com mais de um elemento é parcelamento — cada parcela vira um boleto
 * com o seu próprio vencimento.
 */
export const CONDICOES_PAGAMENTO = [
  { id: "7", rotulo: "7 dias", dias: [7] },
  { id: "21", rotulo: "21 dias", dias: [21] },
  { id: "28", rotulo: "28 dias", dias: [28] },
  { id: "3x", rotulo: "3× — 21, 28 e 35 dias", dias: [21, 28, 35] },
] as const

export type CondicaoPagamento = (typeof CONDICOES_PAGAMENTO)[number]

export function condicaoPorId(id: string): CondicaoPagamento | null {
  return CONDICOES_PAGAMENTO.find((c) => c.id === id) ?? null
}

/** Vencimentos de uma condição, ao meio-dia para o fuso não empurrar o dia. */
export function vencimentosDaCondicao(condicao: CondicaoPagamento, hoje = new Date()) {
  return condicao.dias.map((dias) => {
    const data = new Date(hoje)
    data.setDate(data.getDate() + dias)
    data.setHours(12, 0, 0, 0)
    return data
  })
}

/**
 * Divide o total entre as parcelas em centavos, jogando a sobra na primeira.
 * Dividir em reais deixaria diferença de centavo entre a soma e o total.
 */
export function dividirParcelas(total: number, quantidade: number): number[] {
  const centavos = Math.round(total * 100)
  const base = Math.floor(centavos / quantidade)
  const sobra = centavos - base * quantidade

  return Array.from({ length: quantidade }, (_, i) => (base + (i === 0 ? sobra : 0)) / 100)
}

/** O Inter recusa boleto abaixo de R$ 2,50 — e o limite vale POR parcela. */
export function condicaoCabeNoTotal(condicao: CondicaoPagamento, total: number) {
  return dividirParcelas(total, condicao.dias.length).every(
    (valor) => valor >= VALOR_MINIMO_BOLETO
  )
}

export type Parcela = { parcela: number; valor: number; vencimento: Date }

/**
 * O plano de parcelas de uma condição: quanto e para quando.
 *
 * Uma função só, usada pela tela (para mostrar antes de fechar) e pelo servidor
 * (para emitir). Se fossem dois cálculos, o operador poderia prometer ao cliente
 * um valor ou uma data diferentes dos que sairiam no boleto.
 */
export function parcelasDaCondicao(
  condicao: CondicaoPagamento,
  total: number,
  base = new Date()
): Parcela[] {
  const valores = dividirParcelas(total, condicao.dias.length)
  const vencimentos = vencimentosDaCondicao(condicao, base)

  return condicao.dias.map((_, i) => ({
    parcela: i + 1,
    valor: valores[i],
    vencimento: vencimentos[i],
  }))
}
