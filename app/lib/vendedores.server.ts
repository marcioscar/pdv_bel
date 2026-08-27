import { db } from "~/lib/db.server"

/**
 * Quem vendeu, para a comissão.
 *
 * Vendedor não é um cadastro à parte: é o próprio `Usuario`, com um código
 * curto. Todo vendedor da rede tem login, então um segundo cadastro só criaria
 * duas listas de gente para manter em dia — e o dia em que divergissem, a
 * comissão iria para um nome que não existe mais no sistema.
 *
 * O código é digitado pelo caixa a cada venda, porque quem fecha é um caixa
 * fixo e quem vendeu muda de cliente para cliente.
 */

export type VendedorDoBalcao = { id: string; codigo: string; nome: string }

/**
 * Os vendedores que podem receber comissão nesta loja.
 *
 * `lojas` vazio é a rede toda (ver o cadastro de `Usuario`): os vendedores
 * revezam de loja, e quem está cobrindo a QNE hoje precisa aparecer lá.
 *
 * Vai inteira para a tela de propósito, em vez de uma consulta por tecla
 * digitada: são poucas pessoas, e o caixa não pode esperar a rede para saber
 * de quem é a comissão que está digitando.
 */
export async function vendedoresDaLoja(loja: string): Promise<VendedorDoBalcao[]> {
  const usuarios = await db.usuario.findMany({
    where: { ativo: true, codigoVendedor: { not: null } },
    select: { id: true, nome: true, codigoVendedor: true, lojas: true },
    orderBy: { nome: "asc" },
  })

  return usuarios
    .filter((u) => u.lojas.length === 0 || u.lojas.includes(loja))
    .map((u) => ({ id: u.id, codigo: u.codigoVendedor!, nome: u.nome }))
}

/**
 * Resolve o código no servidor, e não confia no id que a tela mandou.
 *
 * A tela manda o CÓDIGO digitado; quem diz a quem ele pertence é o banco. Se o
 * navegador mandasse id e nome, dava para creditar comissão a qualquer um
 * editando o payload — e comissão é dinheiro.
 */
export async function vendedorPorCodigo(
  codigo: string,
  loja: string
): Promise<VendedorDoBalcao | null> {
  const limpo = codigo.trim()
  if (!limpo) return null

  const usuario = await db.usuario.findFirst({
    where: { ativo: true, codigoVendedor: limpo },
    select: { id: true, nome: true, codigoVendedor: true, lojas: true },
  })
  if (!usuario) return null
  if (usuario.lojas.length > 0 && !usuario.lojas.includes(loja)) return null

  return { id: usuario.id, codigo: usuario.codigoVendedor!, nome: usuario.nome }
}

/**
 * O código já é de outra pessoa? Cobrado aqui porque o campo não pode ter
 * índice único no Mongo (ver o comentário em `Usuario.codigoVendedor`).
 */
export async function codigoVendedorEmUso(codigo: string, excetoUsuarioId?: string) {
  const limpo = codigo.trim()
  if (!limpo) return null

  const dono = await db.usuario.findFirst({
    where: { codigoVendedor: limpo, ...(excetoUsuarioId ? { id: { not: excetoUsuarioId } } : {}) },
    select: { nome: true },
  })
  return dono?.nome ?? null
}
