import { db } from "~/lib/db.server"
import { ehTipoValido, type TipoDeGrupo } from "~/lib/grupos"

/**
 * O grupo do produto — a gaveta do catálogo, e o filtro das análises.
 *
 * Existe um valor de `tipo` que muda o comportamento do sistema: "encomenda".
 * O que está nele sai da curva ABC e de qualquer leitura de giro, porque
 * encomenda é item feito sob medida para um cliente e não volta a vender. Ver
 * a nota do modelo `GrupoDeProduto` no schema.
 */

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/** Todos os grupos, do jeito que a tela lê: pelo nome. */
export function listarGrupos() {
  return db.grupoDeProduto.findMany({ orderBy: { nome: "asc" } })
}

/**
 * Os ids dos grupos que entram nas análises de venda e giro.
 *
 * Devolve `null` quando NENHUM grupo foi cadastrado ainda — e aí quem chama
 * não filtra nada. É a diferença entre "ninguém classificou" e "classificaram
 * e nada sobrou": filtrar por uma lista vazia esvaziaria a curva ABC no dia em
 * que a importação não tivesse rodado, e a tela mostraria zero sem explicar.
 */
export async function gruposDaAnalise(): Promise<Set<string> | null> {
  const grupos = await db.grupoDeProduto.findMany({ select: { id: true, tipo: true } })
  if (grupos.length === 0) return null
  return new Set(grupos.filter((g) => g.tipo === "padrao").map((g) => g.id))
}

/** id → nome, para as telas que listam produto e precisam dizer o grupo. */
export async function nomesDosGrupos() {
  const grupos = await db.grupoDeProduto.findMany({ select: { id: true, nome: true } })
  return new Map(grupos.map((g) => [g.id, g.nome]))
}

export type GrupoEntrada = { codigo: string; nome: string; tipo: TipoDeGrupo }

export function lerGrupo(form: FormData): GrupoEntrada | { erro: string } {
  const codigo = String(form.get("codigo") ?? "").trim()
  const nome = String(form.get("nome") ?? "").trim()
  const tipo = String(form.get("tipo") ?? "padrao").trim()

  if (!codigo) return { erro: "Informe o código do grupo" }
  if (codigo.length > 10) return { erro: "Código longo demais" }
  if (nome.length < 2) return { erro: "Nome precisa de pelo menos 2 letras" }
  if (!ehTipoValido(tipo)) return { erro: "Tipo inválido" }

  return { codigo, nome, tipo }
}

export async function salvarGrupo(id: string | null, entrada: GrupoEntrada) {
  // O código é único de verdade no banco: dois grupos com o mesmo código
  // fariam a importação escolher um deles no par ou ímpar.
  const existente = await db.grupoDeProduto.findUnique({ where: { codigo: entrada.codigo } })
  if (existente && existente.id !== id) {
    return { ok: false as const, erro: `O código ${entrada.codigo} já é do grupo ${existente.nome}` }
  }

  if (id) {
    if (!OBJECT_ID.test(id)) return { ok: false as const, erro: "Grupo inválido" }
    const grupo = await db.grupoDeProduto.update({ where: { id }, data: entrada })
    return { ok: true as const, grupo, mensagem: `${grupo.nome} atualizado` }
  }

  const grupo = await db.grupoDeProduto.create({ data: entrada })
  return { ok: true as const, grupo, mensagem: `${grupo.nome} cadastrado` }
}

/**
 * Desativa ou reativa. Não existe apagar: os produtos guardam `grupoId`, e
 * apagar deixaria cada um deles apontando para o nada.
 */
export async function alternarGrupo(id: string) {
  if (!OBJECT_ID.test(id)) return { ok: false as const, erro: "Grupo inválido" }
  const grupo = await db.grupoDeProduto.findUnique({ where: { id } })
  if (!grupo) return { ok: false as const, erro: "Grupo não encontrado" }

  const atualizado = await db.grupoDeProduto.update({
    where: { id },
    data: { ativo: !grupo.ativo },
  })
  return {
    ok: true as const,
    mensagem: `${atualizado.nome} ${atualizado.ativo ? "reativado" : "desativado"}`,
  }
}

/** Quantos produtos há em cada grupo — a tela precisa para não desativar às cegas. */
export async function produtosPorGrupo() {
  const contagem = await db.produto.groupBy({
    by: ["grupoId"],
    _count: { _all: true },
  })
  const mapa = new Map<string, number>()
  let semGrupo = 0
  for (const linha of contagem) {
    if (linha.grupoId) mapa.set(linha.grupoId, linha._count._all)
    else semGrupo += linha._count._all
  }
  return { porGrupo: mapa, semGrupo }
}
