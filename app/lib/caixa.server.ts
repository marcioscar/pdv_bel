import { db } from "~/lib/db.server"
import { depoisDoDia, inicioDoDia } from "~/lib/dia"
import { arredondar } from "~/lib/moeda"
import { sinalDoMovimento, type TipoMovimentoDeCaixa } from "~/lib/caixa"
import { NAO_CANCELADA } from "~/lib/vendas.server"

/**
 * O fechamento do caixa de um dia.
 *
 * A conta do dinheiro em espécie é a única que precisa bater com algo físico:
 *
 *     esperado = abertura + vendas em dinheiro − sangrias + reforços
 *
 * As outras formas não entram nela. Pix, débito e crédito vão para o banco sem
 * passar pela gaveta, e a prazo nem dinheiro é — mas todas aparecem no
 * documento, porque quem confere o caixa também quer saber quanto a loja vendeu.
 *
 * Venda cancelada não conta em lugar nenhum: o dinheiro voltou para o cliente.
 */

export type ResumoDoDia = Awaited<ReturnType<typeof resumoDoDia>>

export async function resumoDoDia(loja: string, dia: string) {
  const periodo = {
    loja,
    criadaEm: { gte: inicioDoDia(dia), lt: depoisDoDia(dia) },
  }

  const [porForma, canceladas, movimentos, fechamento] = await Promise.all([
    db.venda.groupBy({
      by: ["forma"],
      where: { AND: [periodo, NAO_CANCELADA] },
      _sum: { total: true },
      _count: { _all: true },
    }),
    db.venda.count({ where: { AND: [periodo, { NOT: NAO_CANCELADA }] } }),
    db.movimentoCaixa.findMany({
      where: { loja, dia },
      orderBy: { criadoEm: "asc" },
    }),
    db.fechamentoCaixa.findUnique({ where: { loja_dia: { loja, dia } } }),
  ])

  const por = (forma: string) =>
    arredondar(porForma.find((f) => f.forma === forma)?._sum.total ?? 0)

  const soma = (tipo: TipoMovimentoDeCaixa) =>
    arredondar(
      movimentos.filter((m) => m.tipo === tipo).reduce((acc, m) => acc + m.valor, 0)
    )

  const abertura = soma("abertura")
  const sangrias = soma("sangria")
  const suprimentos = soma("suprimento")
  const vendasDinheiro = por("dinheiro")

  return {
    loja,
    dia,
    abertura,
    sangrias,
    suprimentos,
    vendasDinheiro,
    esperado: arredondar(abertura + vendasDinheiro - sangrias + suprimentos),
    vendasPix: por("pix"),
    vendasDebito: por("debito"),
    vendasCredito: por("credito"),
    vendasPrazo: por("prazo"),
    totalVendido: arredondar(porForma.reduce((a, f) => a + (f._sum.total ?? 0), 0)),
    quantidadeVendas: porForma.reduce((a, f) => a + f._count._all, 0),
    canceladas,
    movimentos,
    fechamento,
  }
}

/** Lança troco inicial, sangria ou reforço. */
export async function lancarMovimentoDeCaixa(entrada: {
  loja: string
  dia: string
  tipo: TipoMovimentoDeCaixa
  valor: number
  operador: string
  operadorId: string
  observacao?: string | null
}) {
  if (!(entrada.valor > 0)) {
    // O tipo é que diz a direção; valor negativo aqui inverteria o sinal duas
    // vezes e a sangria viraria reforço sem ninguém perceber.
    return { ok: false as const, erro: "Informe um valor maior que zero" }
  }

  const jaFechado = await db.fechamentoCaixa.findUnique({
    where: { loja_dia: { loja: entrada.loja, dia: entrada.dia } },
  })
  if (jaFechado) {
    return {
      ok: false as const,
      erro: "Este dia já foi fechado — lançar agora mudaria um documento assinado",
    }
  }

  if (entrada.tipo === "abertura") {
    const jaAbriu = await db.movimentoCaixa.findFirst({
      where: { loja: entrada.loja, dia: entrada.dia, tipo: "abertura" },
    })
    // Duas aberturas dobrariam o troco no esperado. Reforço é o lançamento certo
    // para pôr mais dinheiro depois de o dia ter começado.
    if (jaAbriu) {
      return {
        ok: false as const,
        erro: "O caixa deste dia já foi aberto — para pôr mais troco, lance um reforço",
      }
    }
  }

  await db.movimentoCaixa.create({
    data: {
      loja: entrada.loja,
      dia: entrada.dia,
      tipo: entrada.tipo,
      valor: arredondar(entrada.valor),
      operador: entrada.operador,
      operadorId: entrada.operadorId,
      observacao: entrada.observacao?.trim() || null,
    },
  })

  return { ok: true as const }
}

/** Desfaz um lançamento errado, enquanto o dia não fechou. */
export async function apagarMovimentoDeCaixa(id: string, loja: string) {
  const movimento = await db.movimentoCaixa.findUnique({ where: { id } })
  if (!movimento || movimento.loja !== loja) {
    return { ok: false as const, erro: "Lançamento não encontrado" }
  }

  const fechado = await db.fechamentoCaixa.findUnique({
    where: { loja_dia: { loja, dia: movimento.dia } },
  })
  if (fechado) {
    return { ok: false as const, erro: "Este dia já foi fechado" }
  }

  await db.movimentoCaixa.delete({ where: { id } })
  return { ok: true as const }
}

export type ResultadoFechamento =
  | { ok: true; id: string; diferenca: number }
  | { ok: false; erro: string }

/**
 * Fecha o dia com o que a pessoa contou na gaveta.
 *
 * Grava o retrato inteiro do cálculo, e não só a diferença. Se uma venda daquele
 * dia for cancelada semana que vem, o esperado mudaria — e o documento assinado
 * passaria a discordar de si mesmo. Retrato guardado, documento estável.
 */
export async function fecharCaixa(entrada: {
  loja: string
  dia: string
  contado: number
  operador: string
  operadorId: string
  observacao?: string | null
}): Promise<ResultadoFechamento> {
  if (!Number.isFinite(entrada.contado) || entrada.contado < 0) {
    return { ok: false, erro: "Informe quanto foi contado na gaveta" }
  }

  const resumo = await resumoDoDia(entrada.loja, entrada.dia)
  if (resumo.fechamento) {
    return {
      ok: false,
      erro: `Este dia já foi fechado por ${resumo.fechamento.fechadoPor}`,
    }
  }

  const contado = arredondar(entrada.contado)
  const diferenca = arredondar(contado - resumo.esperado)

  try {
    const doc = await db.fechamentoCaixa.create({
      data: {
        loja: entrada.loja,
        dia: entrada.dia,
        fechadoPor: entrada.operador,
        fechadoPorId: entrada.operadorId,
        abertura: resumo.abertura,
        vendasDinheiro: resumo.vendasDinheiro,
        sangrias: resumo.sangrias,
        suprimentos: resumo.suprimentos,
        esperado: resumo.esperado,
        contado,
        diferenca,
        vendasPix: resumo.vendasPix,
        vendasDebito: resumo.vendasDebito,
        vendasCredito: resumo.vendasCredito,
        vendasPrazo: resumo.vendasPrazo,
        totalVendido: resumo.totalVendido,
        quantidadeVendas: resumo.quantidadeVendas,
        canceladas: resumo.canceladas,
        observacao: entrada.observacao?.trim() || null,
      },
    })
    return { ok: true, id: doc.id, diferenca }
  } catch (erro) {
    // O índice único é a trava de verdade contra duas abas fechando o mesmo dia.
    if (typeof erro === "object" && erro !== null && (erro as { code?: string }).code === "P2002") {
      return { ok: false, erro: "Este dia acabou de ser fechado por outra pessoa" }
    }
    throw erro
  }
}

/**
 * Reabre o dia, apagando o fechamento.
 *
 * Existe porque fechar com o número errado acontece, e a alternativa seria o
 * operador "consertar" com uma sangria falsa — que estragaria o histórico em vez
 * de corrigi-lo. É ação de gerente, e o papel já impresso deixa de valer.
 */
export async function reabrirCaixa(loja: string, dia: string) {
  const { count } = await db.fechamentoCaixa.deleteMany({ where: { loja, dia } })
  return count > 0
}

export type FechamentoListado = Awaited<ReturnType<typeof listarFechamentos>>[number]

export function listarFechamentos(lojasPermitidas: string[], limite = 90) {
  return db.fechamentoCaixa.findMany({
    where: { loja: { in: lojasPermitidas } },
    orderBy: [{ dia: "desc" }, { loja: "asc" }],
    take: limite,
  })
}

/** Dias com movimento que ninguém fechou — a lista que cobra o gerente. */
export async function diasSemFechamento(lojasPermitidas: string[], desde: string) {
  const vendas = await db.venda.findMany({
    where: { loja: { in: lojasPermitidas }, criadaEm: { gte: inicioDoDia(desde) } },
    select: { loja: true, criadaEm: true },
  })

  const comMovimento = new Set<string>()
  for (const v of vendas) {
    const d = v.criadaEm
    const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    comMovimento.add(`${v.loja}|${dia}`)
  }

  const fechados = new Set(
    (
      await db.fechamentoCaixa.findMany({
        where: { loja: { in: lojasPermitidas }, dia: { gte: desde } },
        select: { loja: true, dia: true },
      })
    ).map((f) => `${f.loja}|${f.dia}`)
  )

  return [...comMovimento]
    .filter((c) => !fechados.has(c))
    .map((c) => ({ loja: c.split("|")[0], dia: c.split("|")[1] }))
    .sort((a, b) => (a.dia === b.dia ? a.loja.localeCompare(b.loja) : b.dia.localeCompare(a.dia)))
}
