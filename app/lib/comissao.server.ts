import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"
import { NAO_CANCELADA, NAO_E_TRANSFERENCIA } from "~/lib/vendas.server"

/**
 * Quanto cada vendedor tem a receber.
 *
 * Três regras que o cálculo respeita e a tela repete:
 *
 * 1. **Transferência entre lojas não é venda de ninguém.** A nota que a matriz
 *    emite para a filial é documento de acompanhamento da mercadoria; creditar
 *    comissão nela pagaria alguém por mover caixa de um depósito para outro.
 *    Sai por `NAO_E_TRANSFERENCIA`, o mesmo filtro do faturamento.
 *
 * 2. **Venda cancelada não gera comissão.** O cancelamento estorna o estoque e
 *    o dinheiro; a comissão tem de seguir junto.
 *
 * 3. **Devolução abate.** A mercadoria voltou, então o que ela rendia deixa de
 *    ser devido — e abate no período em que a devolução ACONTECEU, não no da
 *    venda original. Abater no da venda mudaria a comissão de um mês já pago.
 */

/** 1,5% é a taxa da rede. Vale quando ninguém cadastrou nenhuma ainda. */
export const TAXA_PADRAO = 1.5

export type Taxa = {
  percentual: number
  vigenteDesde: string
  definidaPor: string
  padrao: boolean
}

/**
 * A taxa que valia numa data — a mais recente cuja vigência já tinha começado.
 *
 * Sem nenhuma cadastrada, devolve o padrão marcado como tal: a tela precisa
 * poder dizer "ninguém definiu, estamos usando 1,5%" em vez de apresentar um
 * número como se fosse decisão de alguém.
 */
export async function taxaVigenteEm(data: Date): Promise<Taxa> {
  const taxa = await db.taxaDeComissao.findFirst({
    where: { vigenteDesde: { lte: data } },
    orderBy: { vigenteDesde: "desc" },
  })

  if (!taxa) {
    return {
      percentual: TAXA_PADRAO,
      vigenteDesde: data.toISOString(),
      definidaPor: "—",
      padrao: true,
    }
  }

  return {
    percentual: taxa.percentual,
    vigenteDesde: taxa.vigenteDesde.toISOString(),
    definidaPor: taxa.definidaPor,
    padrao: false,
  }
}

/** O histórico inteiro, do mais recente para o mais antigo. */
export async function historicoDeTaxas() {
  const taxas = await db.taxaDeComissao.findMany({ orderBy: { vigenteDesde: "desc" } })
  return taxas.map((t) => ({
    id: t.id,
    percentual: t.percentual,
    vigenteDesde: t.vigenteDesde.toISOString(),
    definidaPor: t.definidaPor,
    criadoEm: t.criadoEm.toISOString(),
  }))
}

export async function definirTaxa(
  percentual: number,
  vigenteDesde: Date,
  quem: { nome: string; id: string }
) {
  // Taxa negativa cobraria do vendedor; acima de 100% pagaria mais do que a
  // venda rendeu. As duas são digitação, e as duas viram dinheiro.
  if (!Number.isFinite(percentual) || percentual < 0 || percentual > 100) {
    return { ok: false as const, erro: "Percentual precisa ficar entre 0 e 100" }
  }

  const taxa = await db.taxaDeComissao.create({
    data: {
      percentual,
      vigenteDesde,
      definidaPor: quem.nome,
      definidaPorId: quem.id,
    },
  })

  return {
    ok: true as const,
    mensagem: `Comissão passa a ${taxa.percentual.toLocaleString("pt-BR")}% a partir de ${vigenteDesde.toLocaleDateString("pt-BR")}`,
  }
}

export type LinhaComissao = {
  vendedorId: string | null
  nome: string
  vendas: number
  vendido: number
  devolucoes: number
  devolvido: number
  /** Vendido menos devolvido — é sobre isto que a taxa incide. */
  base: number
  comissao: number
}

export type RelatorioDeComissao = {
  linhas: LinhaComissao[]
  totais: { vendas: number; vendido: number; devolvido: number; base: number; comissao: number }
  /** A taxa usada em cada venda, resumida: uma só, ou o intervalo do período. */
  taxas: { percentual: number; vigenteDesde: string }[]
  semVendedor: { vendas: number; vendido: number }
}

/**
 * A comissão de cada vendedor no período, numa loja ou na rede.
 *
 * A taxa é aplicada venda a venda pela que vigorava NO DIA da venda, e não pela
 * de hoje: um período que atravessa uma mudança de taxa tem de pagar cada parte
 * pelo que foi combinado então.
 */
export async function comissaoPorVendedor(
  lojas: string[],
  de: Date,
  /** Exclusivo, como manda `depoisDoDia`: é o instante em que o período acaba. */
  ate: Date
): Promise<RelatorioDeComissao> {
  const [vendas, devolucoes, taxasCadastradas] = await Promise.all([
    db.venda.findMany({
      where: {
        AND: [
          { loja: { in: lojas }, criadaEm: { gte: de, lt: ate } },
          NAO_CANCELADA,
          NAO_E_TRANSFERENCIA,
        ],
      },
      select: { vendedorId: true, vendedorNome: true, total: true, criadaEm: true },
    }),
    db.devolucao.findMany({
      where: { loja: { in: lojas }, criadaEm: { gte: de, lt: ate } },
      select: { vendaId: true, total: true, criadaEm: true },
    }),
    db.taxaDeComissao.findMany({ orderBy: { vigenteDesde: "asc" } }),
  ])

  /** A taxa vigente numa data, das que já estão em memória. */
  const taxaEm = (quando: Date) => {
    let valor = TAXA_PADRAO
    for (const t of taxasCadastradas) {
      if (t.vigenteDesde <= quando) valor = t.percentual
      else break
    }
    return valor
  }

  /*
   * A devolução guarda a venda, não o vendedor — o vendedor está na venda. Uma
   * consulta só para todas elas: a alternativa seria uma por devolução.
   */
  const vendasDasDevolucoes = await db.venda.findMany({
    where: { id: { in: [...new Set(devolucoes.map((d) => d.vendaId))] } },
    select: { id: true, vendedorId: true, vendedorNome: true, forma: true, canceladaEm: true },
  })
  const porVendaId = new Map(vendasDasDevolucoes.map((v) => [v.id, v]))

  const mapa = new Map<string, LinhaComissao>()
  const linhaDe = (id: string | null, nome: string | null) => {
    const chave = id ?? ""
    const atual =
      mapa.get(chave) ??
      ({
        vendedorId: id,
        // Venda anterior ao campo de vendedor não tem a quem creditar. Ela fica
        // fora das linhas e é reportada à parte: somar num "sem vendedor" dentro
        // da tabela pareceria alguém a receber.
        nome: nome ?? "—",
        vendas: 0,
        vendido: 0,
        devolucoes: 0,
        devolvido: 0,
        base: 0,
        comissao: 0,
      } satisfies LinhaComissao)
    mapa.set(chave, atual)
    return atual
  }

  const semVendedor = { vendas: 0, vendido: 0 }

  for (const venda of vendas) {
    if (!venda.vendedorId) {
      semVendedor.vendas += 1
      semVendedor.vendido += venda.total
      continue
    }
    const linha = linhaDe(venda.vendedorId, venda.vendedorNome)
    linha.vendas += 1
    linha.vendido += venda.total
    linha.comissao += venda.total * (taxaEm(venda.criadaEm) / 100)
  }

  for (const devolucao of devolucoes) {
    const venda = porVendaId.get(devolucao.vendaId)
    // Devolução de venda cancelada não abate nada: a venda já não pagou
    // comissão nenhuma, e abater cobraria do vendedor o que ele não recebeu.
    if (!venda || !venda.vendedorId || venda.canceladaEm) continue

    const linha = linhaDe(venda.vendedorId, venda.vendedorNome)
    linha.devolucoes += 1
    linha.devolvido += devolucao.total
    linha.comissao -= devolucao.total * (taxaEm(devolucao.criadaEm) / 100)
  }

  const linhas = [...mapa.values()]
    .map((l) => ({
      ...l,
      vendido: arredondar(l.vendido),
      devolvido: arredondar(l.devolvido),
      base: arredondar(l.vendido - l.devolvido),
      comissao: arredondar(l.comissao),
    }))
    .sort((a, b) => b.comissao - a.comissao)

  /** Quais taxas o período atravessou — a tela mostra uma ou várias. */
  const usadas = new Map<number, string>()
  for (const venda of vendas) {
    const p = taxaEm(venda.criadaEm)
    const t = [...taxasCadastradas].reverse().find((x) => x.vigenteDesde <= venda.criadaEm)
    if (!usadas.has(p)) usadas.set(p, t?.vigenteDesde.toISOString() ?? de.toISOString())
  }
  if (usadas.size === 0) usadas.set(await taxaVigenteEm(ate).then((t) => t.percentual), de.toISOString())

  return {
    linhas,
    totais: {
      vendas: linhas.reduce((s, l) => s + l.vendas, 0),
      vendido: arredondar(linhas.reduce((s, l) => s + l.vendido, 0)),
      devolvido: arredondar(linhas.reduce((s, l) => s + l.devolvido, 0)),
      base: arredondar(linhas.reduce((s, l) => s + l.base, 0)),
      comissao: arredondar(linhas.reduce((s, l) => s + l.comissao, 0)),
    },
    taxas: [...usadas].map(([percentual, vigenteDesde]) => ({ percentual, vigenteDesde })),
    semVendedor: { vendas: semVendedor.vendas, vendido: arredondar(semVendedor.vendido) },
  }
}
