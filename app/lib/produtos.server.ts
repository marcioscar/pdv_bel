import { db } from "~/lib/db.server"
import { interpretarValor } from "~/lib/moeda"

export type ProdutoEntrada = {
  codigo: string
  descricao: string
  unidade: string
  preco: number
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

  if (!codigo) return { erro: "Informe o código" }
  if (codigo.length > 20) return { erro: "Código longo demais" }
  if (descricao.length < 3) return { erro: "Descrição precisa de pelo menos 3 letras" }
  if (!unidade) return { erro: "Informe a unidade (PC, UN, CX…)" }
  if (unidade.length > 6) return { erro: "Unidade longa demais" }
  if (preco === null || preco < 0) return { erro: "Preço inválido" }

  return { codigo, descricao, unidade, preco }
}

export async function criarProduto(entrada: ProdutoEntrada): Promise<ResultadoProduto> {
  // `codigo` não é único no catálogo: 55 códigos já se repetem hoje, e o caixa
  // resolve mostrando a lista quando o código é ambíguo. Não barramos aqui.
  const produto = await db.produto.create({ data: entrada })
  return { ok: true, produto }
}

export async function atualizarProduto(
  id: string,
  entrada: ProdutoEntrada
): Promise<ResultadoProduto> {
  if (!OBJECT_ID.test(id)) return { ok: false, erro: "Produto inválido" }

  const existente = await db.produto.findUnique({ where: { id } })
  if (!existente) return { ok: false, erro: "Produto não encontrado" }

  const produto = await db.produto.update({ where: { id }, data: entrada })
  return { ok: true, produto }
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
