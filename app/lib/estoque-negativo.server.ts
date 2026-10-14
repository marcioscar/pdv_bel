import { db } from "~/lib/db.server"
import { saldosDosProdutos } from "~/lib/estoque.server"
import { arredondar, quantidade as formatarQuantidade } from "~/lib/moeda"
import { enviarTelegramEmSegundoPlano, texto } from "~/lib/telegram.server"

/**
 * O estoque que ficou negativo — e o gerente sabendo disso.
 *
 * A venda e a transferência não recusam mais por falta de saldo: a mercadoria
 * chega, o gerente não está para dar entrada, e a loja não pode parar. Em troca,
 * todo documento que deixa um produto abaixo de zero registra um aviso e manda
 * uma mensagem ao gerente. Ele não autoriza nada; dá ciência — é o lembrete de
 * que há entrada a lançar.
 */

/**
 * Depois de gravado o documento: confere o saldo de cada produto na loja e
 * registra aviso para os que ficaram negativos. Nunca lança — o documento já
 * aconteceu, e um aviso que falhou não pode desfazer uma venda.
 */
export async function registrarAvisosDeNegativo(entrada: {
  loja: string
  itens: { produtoId: string; quantidade: number }[]
  origem: "venda" | "transferencia"
  documento: string
  documentoId: string
  operador: string
}) {
  try {
    const saldos = await saldosDosProdutos(
      [...new Set(entrada.itens.map((i) => i.produtoId))],
      entrada.loja
    )
    const negativos = entrada.itens.filter((i) => (saldos.get(i.produtoId) ?? 0) < 0)
    if (negativos.length === 0) return

    const produtos = await db.produto.findMany({
      where: { id: { in: negativos.map((i) => i.produtoId) } },
      select: { id: true, codigo: true, descricao: true, unidade: true },
    })
    const porId = new Map(produtos.map((p) => [p.id, p]))

    const avisos = negativos.flatMap((i) => {
      const p = porId.get(i.produtoId)
      if (!p) return []
      return [
        {
          produtoId: i.produtoId,
          codigo: p.codigo,
          descricao: p.descricao,
          unidade: p.unidade,
          loja: entrada.loja,
          origem: entrada.origem,
          documento: entrada.documento,
          documentoId: entrada.documentoId,
          quantidade: arredondar(i.quantidade),
          saldoDepois: saldos.get(i.produtoId) ?? 0,
          operador: entrada.operador,
        },
      ]
    })
    if (avisos.length === 0) return
    await db.avisoEstoqueNegativo.createMany({ data: avisos })

    const linhas = avisos
      .slice(0, 10)
      .map(
        (a) =>
          `• ${texto(a.codigo)} ${texto(a.descricao)}: saldo ${formatarQuantidade(a.saldoDepois)} ${texto(a.unidade)}`
      )
    enviarTelegramEmSegundoPlano(
      [
        `<b>Estoque negativo · ${texto(entrada.loja)}</b>`,
        `${texto(entrada.documento)} por ${texto(entrada.operador)}`,
        ...linhas,
        avisos.length > 10 ? `… e mais ${avisos.length - 10}` : "",
        "Falta dar entrada na mercadoria. Dê ciência em Estoque negativo.",
      ]
        .filter(Boolean)
        .join("\n")
    )
  } catch (erro) {
    console.error("[estoque negativo] aviso não registrado:", erro instanceof Error ? erro.message : erro)
  }
}

/** Quanto tempo o aviso fica na lista depois de criado. */
export const DIAS_DE_AVISO = 60

/**
 * Os avisos dos últimos `DIAS_DE_AVISO` dias — com ciência ou sem. Ciência
 * não tira da lista: a lista é o histórico do que aconteceu, e o selo diz quem
 * viu. Os pendentes vêm primeiro; depois, o mais recente.
 */
export async function avisosRecentes(lojas: string[]) {
  const desde = new Date(Date.now() - DIAS_DE_AVISO * 86_400_000)
  const avisos = await db.avisoEstoqueNegativo.findMany({
    where: { loja: { in: lojas }, criadoEm: { gte: desde } },
    orderBy: { criadoEm: "desc" },
    take: 1000,
  })
  return avisos.sort((a, b) => Number(Boolean(a.cienteEm)) - Number(Boolean(b.cienteEm)))
}

/**
 * Quem está abaixo de zero AGORA, por loja — calculado do livro, não dos avisos:
 * o aviso é o momento em que ficou negativo; isto é se continua. Some sozinho
 * quando a entrada da mercadoria é lançada.
 */
export async function negativosAgora(lojas: string[]) {
  const grupos = await db.movimentoEstoque.groupBy({
    by: ["produtoId", "loja"],
    where: { loja: { in: lojas } },
    _sum: { quantidade: true },
  })
  const abaixo = grupos.filter((g) => arredondar(g._sum.quantidade ?? 0) < 0)
  if (abaixo.length === 0) return []

  const produtos = await db.produto.findMany({
    where: { id: { in: [...new Set(abaixo.map((g) => g.produtoId))] } },
    select: { id: true, codigo: true, descricao: true, unidade: true },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  return abaixo
    .map((g) => ({
      produtoId: g.produtoId,
      loja: g.loja,
      saldo: arredondar(g._sum.quantidade ?? 0),
      codigo: porId.get(g.produtoId)?.codigo ?? "",
      descricao: porId.get(g.produtoId)?.descricao ?? "(produto removido)",
      unidade: porId.get(g.produtoId)?.unidade ?? "",
    }))
    .sort((a, b) => a.loja.localeCompare(b.loja) || a.saldo - b.saldo)
}

/** Dá ciência — em um aviso, ou em todos os pendentes das lojas do gerente. */
export async function darCiencia(entrada: { ids: string[] | "todos"; lojas: string[]; gerente: string }) {
  const { count } = await db.avisoEstoqueNegativo.updateMany({
    where: {
      loja: { in: entrada.lojas },
      OR: [{ cienteEm: null }, { cienteEm: { isSet: false } }],
      ...(entrada.ids === "todos" ? {} : { id: { in: entrada.ids } }),
    },
    data: { cienteEm: new Date(), cientePor: entrada.gerente },
  })
  return count
}

/** Para o menu e o painel: quantos avisos esperam ciência. */
export function contarAvisosPendentes(lojas: string[]) {
  return db.avisoEstoqueNegativo.count({
    where: { loja: { in: lojas }, OR: [{ cienteEm: null }, { cienteEm: { isSet: false } }] },
  })
}
