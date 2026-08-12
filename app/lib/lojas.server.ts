import { db } from "~/lib/db.server"

export type LojaResumo = {
  codigo: string
  nome: string
  conta: string
}

/** Lojas ativas, em ordem de código. São quatro: o custo é irrelevante. */
export async function listarLojas(): Promise<LojaResumo[]> {
  const lojas = await db.loja.findMany({
    where: { ativo: true },
    orderBy: { codigo: "asc" },
    select: { codigo: true, nome: true, conta: true },
  })
  return lojas
}

export async function lojaPorCodigo(codigo: string) {
  return db.loja.findUnique({ where: { codigo } })
}

/**
 * A conta do Inter que atende uma loja.
 *
 * Existe como consulta ao banco, e não como constante no código, porque errar
 * aqui emite boleto no CNPJ errado: QI e QNE compartilham a conta da matriz, NRT
 * e SDS têm a sua. O dado mora junto da loja para não haver duas versões disso.
 */
export async function contaDaLoja(codigoLoja: string): Promise<string> {
  const loja = await db.loja.findUnique({
    where: { codigo: codigoLoja },
    select: { conta: true, ativo: true },
  })
  if (!loja) throw new Error(`Loja ${codigoLoja} não cadastrada`)
  return loja.conta
}

/** Dados da loja usados no comprovante e no cabeçalho do boleto. */
export async function dadosDaLoja(codigoLoja: string) {
  const loja = await db.loja.findUnique({ where: { codigo: codigoLoja } })
  if (!loja) throw new Error(`Loja ${codigoLoja} não cadastrada`)
  return loja
}
