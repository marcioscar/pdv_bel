import { db } from "~/lib/db.server"
import { gruposDaAnalise, nomesDosGrupos } from "~/lib/grupos.server"
import { arredondar } from "~/lib/moeda"
import { NAO_CANCELADA, NAO_E_TRANSFERENCIA } from "~/lib/vendas.server"

export type Faixa = "A" | "B" | "C"

export type LinhaAbc = {
  produtoId: string
  codigo: string
  descricao: string
  grupoId: string | null
  grupoNome: string | null
  /** Quantidade vendida no período medido pela política. */
  quantidade: number
  /** O preço de hoje, que é o que multiplica a quantidade. */
  preco: number
  /** Quantidade × preço de hoje. É estimativa: o preço de então pode ter mudado. */
  valor: number
  participacao: number
  acumulado: number
  faixa: Faixa
}

export type CurvaAbc = {
  linhas: LinhaAbc[]
  total: number
  produtos: number
  /** Quantos produtos e quanto valor há em cada faixa. */
  faixas: Record<Faixa, { produtos: number; valor: number; participacao: number }>
  calculadoEm: string
  diasAnalisados: number
  /** Quantos produtos ficaram de fora por serem de grupo que não é padrão. */
  foraPorGrupo: number
}

/** Os cortes clássicos: A até 80% do valor acumulado, B até 95%, C o resto. */
const CORTE_A = 80
const CORTE_B = 95

/**
 * A curva ABC por valor — quais produtos sustentam a operação.
 *
 * Sai de `PoliticaDeCompra`, que guarda quanto cada produto vendeu no período
 * analisado pelo importador do sistema antigo. É a ÚNICA fonte com volume: as
 * vendas do PDV somam três dezenas de linhas de item.
 *
 * Duas honestidades que toda tela que a mostrar precisa repetir ao usuário:
 *
 * 1. É um RETRATO, não uma série viva. Só muda quando alguém roda
 *    `scripts/calcular-politica-de-compra.mjs`. A data do cálculo vai junto.
 * 2. O valor é estimado: quantidade vendida × preço de HOJE. O preço praticado
 *    naquele período pode ter sido outro, e a política não guarda o preço.
 *
 * **Só entra grupo do tipo "padrao".** Encomenda — clichê, saco impresso com o
 * nome da padaria — é feita sob medida para um cliente e não volta a vender;
 * na curva ela empurraria para a faixa A um produto que ninguém vai recomprar,
 * e o comprador formaria estoque de uma venda que não repete. A transferência
 * entre lojas já fica fora por outro caminho: a política é calculada da VENDA,
 * e transferência não é venda.
 *
 * Devolve a curva INTEIRA. Quem só quer os dez maiores corta na ponta — o
 * corte não pode acontecer aqui, porque as faixas e a participação de cada
 * linha só existem contra o total de todos os produtos.
 */
export async function curvaAbc(): Promise<CurvaAbc | null> {
  const [politicas, daAnalise] = await Promise.all([
    db.politicaDeCompra.findMany({
      select: { produtoId: true, vendidoNoPeriodo: true, calculadoEm: true, diasAnalisados: true },
    }),
    gruposDaAnalise(),
  ])
  if (politicas.length === 0) return null

  const produtos = await db.produto.findMany({
    where: { id: { in: politicas.map((p) => p.produtoId) } },
    select: { id: true, codigo: true, descricao: true, preco: true, grupoId: true },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const grupos = await db.grupoDeProduto.findMany({ select: { id: true, nome: true } })
  const nomeDoGrupo = new Map(grupos.map((g) => [g.id, g.nome]))

  let foraDaAnalise = 0
  const todas = politicas
    .flatMap((p) => {
      const produto = porId.get(p.produtoId)
      // Produto desativado depois do cálculo: a política sobrevive ao cadastro,
      // mas um item sem nome não diz nada numa curva que se lê pelo nome.
      if (!produto) return []
      /*
       * `daAnalise === null` é "ninguém cadastrou grupo ainda" — e aí a curva é
       * do catálogo inteiro, como sempre foi. Diferente de um grupo marcado
       * como encomenda, que tira o produto de propósito. Produto sem grupo
       * ENTRA: é o estado de quem ainda não foi classificado, e sumir dele
       * calado esvaziaria a curva sem ninguém entender por quê.
       */
      if (daAnalise && produto.grupoId && !daAnalise.has(produto.grupoId)) {
        foraDaAnalise++
        return []
      }
      return [
        {
          produtoId: p.produtoId,
          codigo: produto.codigo,
          descricao: produto.descricao,
          grupoId: produto.grupoId,
          grupoNome: produto.grupoId ? (nomeDoGrupo.get(produto.grupoId) ?? null) : null,
          quantidade: p.vendidoNoPeriodo,
          preco: produto.preco,
          valor: p.vendidoNoPeriodo * produto.preco,
        },
      ]
    })
    .sort((a, b) => b.valor - a.valor)

  const curva = faixasDaCurva(todas)
  if (!curva) return null

  return {
    ...curva,
    calculadoEm: politicas[0].calculadoEm.toISOString(),
    diasAnalisados: politicas[0].diasAnalisados,
    foraPorGrupo: foraDaAnalise,
  }
}

type LinhaSemFaixa = Omit<LinhaAbc, "participacao" | "acumulado" | "faixa">

/**
 * Participação, acumulado e faixa — a parte da curva que não depende de onde
 * vieram os números. Uma só para a curva do relatório (histórico do sistema
 * antigo) e a do painel (vendas do PDV): cortes diferentes nas duas mostrariam
 * faixa A com dois critérios.
 */
function faixasDaCurva(linhasSemFaixa: LinhaSemFaixa[]) {
  const todas = [...linhasSemFaixa].sort((a, b) => b.valor - a.valor)
  const total = todas.reduce((s, l) => s + l.valor, 0)
  if (total <= 0) return null

  let acumulado = 0
  const linhas: LinhaAbc[] = todas.map((l) => {
    const participacao = (l.valor / total) * 100
    acumulado += participacao
    return {
      ...l,
      valor: arredondar(l.valor),
      participacao: arredondar(participacao),
      acumulado: arredondar(acumulado),
      faixa: acumulado <= CORTE_A ? "A" : acumulado <= CORTE_B ? "B" : "C",
    }
  })

  const daFaixa = (f: Faixa) => {
    const dela = linhas.filter((l) => l.faixa === f)
    const valor = dela.reduce((s, l) => s + l.valor, 0)
    return {
      produtos: dela.length,
      valor: arredondar(valor),
      participacao: arredondar((valor / total) * 100),
    }
  }

  return {
    linhas,
    total: arredondar(total),
    produtos: linhas.length,
    faixas: { A: daFaixa("A"), B: daFaixa("B"), C: daFaixa("C") },
  }
}

/**
 * A curva ABC das vendas do PDV no período — o que o painel mostra.
 *
 * Diferente da do relatório, o valor aqui não é estimado: é o subtotal que
 * cada item REALMENTE saiu na venda. Mesmo filtro de grupo (encomenda fora) e
 * mesmas faixas. Vazia enquanto o PDV não tiver venda — e é para ser assim:
 * o painel se baseia só no que foi vendido aqui.
 */
export async function curvaAbcDoPdv(inicio: Date, lojas: string[]) {
  const [vendas, daAnalise] = await Promise.all([
    db.venda.findMany({
      where: {
        AND: [{ loja: { in: lojas }, criadaEm: { gte: inicio } }, NAO_CANCELADA, NAO_E_TRANSFERENCIA],
      },
      select: { itens: true },
    }),
    gruposDaAnalise(),
  ])

  const porProduto = new Map<string, { codigo: string; descricao: string; quantidade: number; valor: number }>()
  for (const venda of vendas) {
    for (const item of venda.itens) {
      const atual =
        porProduto.get(item.produtoId) ??
        { codigo: item.codigo, descricao: item.descricao, quantidade: 0, valor: 0 }
      atual.quantidade += item.quantidade
      atual.valor += item.subtotal
      porProduto.set(item.produtoId, atual)
    }
  }
  if (porProduto.size === 0) return null

  const produtos = await db.produto.findMany({
    where: { id: { in: [...porProduto.keys()] } },
    select: { id: true, grupoId: true },
  })
  const grupoDe = new Map(produtos.map((p) => [p.id, p.grupoId]))
  const nomeDoGrupo = await nomesDosGrupos()

  let foraPorGrupo = 0
  const linhas: LinhaSemFaixa[] = []
  for (const [produtoId, l] of porProduto) {
    const grupoId = grupoDe.get(produtoId) ?? null
    if (daAnalise && grupoId && !daAnalise.has(grupoId)) {
      foraPorGrupo++
      continue
    }
    linhas.push({
      produtoId,
      codigo: l.codigo,
      descricao: l.descricao,
      grupoId,
      grupoNome: grupoId ? (nomeDoGrupo.get(grupoId) ?? null) : null,
      quantidade: l.quantidade,
      // O preço médio praticado, não o de tabela: desconto de combo incluído.
      preco: l.quantidade > 0 ? arredondar(l.valor / l.quantidade) : 0,
      valor: l.valor,
    })
  }

  const curva = faixasDaCurva(linhas)
  return curva ? { ...curva, foraPorGrupo, vendas: vendas.length } : null
}
