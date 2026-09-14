import { db } from "~/lib/db.server"

export type LojaResumo = {
  codigo: string
  nome: string
  conta: string
}

/** Lojas ativas, na ordem do negócio (matriz, filial, depois as outras). */
export async function listarLojas(): Promise<LojaResumo[]> {
  const lojas = await db.loja.findMany({
    where: { ativo: true },
    orderBy: [{ ordem: "asc" }, { codigo: "asc" }],
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

/**
 * A loja da rede que tem este documento, ou null quando é cliente de verdade.
 *
 * É o que identifica a "loja-cliente": QNE, NRT e SDS podem estar cadastradas
 * em `clientes` para receber nota, e o que as distingue de um cliente qualquer
 * não é uma marca no cadastro — é o CNPJ ser o de uma loja da própria rede.
 * Marca se esquece de pôr e se põe por engano; o CNPJ é o que é.
 */
export async function lojaPeloDocumento(documento: string | null | undefined) {
  const so = (documento ?? "").replace(/\D/g, "")
  if (so.length !== 14) return null
  return db.loja.findFirst({ where: { cnpj: so } })
}

/**
 * CNPJ (só dígitos) → código da loja, para a tela marcar de uma vez quais
 * clientes são da própria rede. Uma consulta, e não uma por cliente.
 */
export async function lojasPorCnpj(): Promise<Map<string, string>> {
  const lojas = await db.loja.findMany({
    where: { ativo: true },
    select: { codigo: true, cnpj: true },
  })
  return new Map(lojas.map((l) => [l.cnpj.replace(/\D/g, ""), l.codigo]))
}
