import { db } from "~/lib/db.server"
import { gruposDaAnalise } from "~/lib/grupos.server"
import { arredondar } from "~/lib/moeda"
import { percentuaisDaOperacao } from "~/lib/precificacao.server"
import { NAO_CANCELADA, NAO_E_TRANSFERENCIA } from "~/lib/vendas.server"

/**
 * Os números do painel da administração.
 *
 * Uma observação que atravessa o arquivo inteiro: o faturamento da rede NÃO
 * vem das vendas do PDV. Vem de `receitas`, a coleção do sistema de contas que
 * a rede alimenta há anos — são R$ 3,6 milhões em 2026 contra R$ 1 mil de
 * vendas registradas aqui, porque o PDV entrou em produção agora.
 *
 * Ler faturamento das vendas daria um painel bonito e falso. Os dois convivem:
 * `receitas` responde "quanto a rede fatura", e as vendas do PDV respondem o
 * que só elas sabem — quem vendeu, para quem, e o que saiu.
 */

const DIA_MS = 86_400_000

/** "2026-09-21" no fuso local, que é como o negócio conta o dia. */
function diaLocal(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

export type PontoDiario = { dia: string; porLoja: Record<string, number>; total: number }

/**
 * O faturamento dia a dia, por loja, no período pedido.
 *
 * Vem de `receitas`, somada por dia e loja. São ~7 lançamentos por dia, não uma
 * linha por venda — então a série é do FATURAMENTO do dia, não da contagem de
 * vendas. É por isso que o painel não promete "vendas por dia".
 */
export async function faturamentoDiario(dias: number, lojas: string[]) {
  const inicio = new Date(Date.now() - dias * DIA_MS)

  const linhas = await db.receita.findMany({
    where: { data: { gte: inicio }, loja: { in: lojas } },
    select: { data: true, loja: true, valor: true },
  })

  const porDia = new Map<string, Map<string, number>>()
  for (const l of linhas) {
    const dia = diaLocal(l.data)
    if (!porDia.has(dia)) porDia.set(dia, new Map())
    const m = porDia.get(dia)!
    m.set(l.loja ?? "—", (m.get(l.loja ?? "—") ?? 0) + l.valor)
  }

  /*
   * Todos os dias do período, inclusive os sem lançamento. Sem isto a linha
   * "pula" o domingo e o eixo mente sobre o tempo — dois dias vizinhos no
   * desenho podem estar a uma semana um do outro.
   */
  const pontos: PontoDiario[] = []
  for (let i = dias - 1; i >= 0; i--) {
    const dia = diaLocal(new Date(Date.now() - i * DIA_MS))
    const m = porDia.get(dia) ?? new Map()
    const porLoja = Object.fromEntries(lojas.map((l) => [l, arredondar(m.get(l) ?? 0)]))
    pontos.push({
      dia,
      porLoja,
      total: arredondar(Object.values(porLoja).reduce((a, v) => a + v, 0)),
    })
  }
  return pontos
}

export type LinhaAbc = {
  produtoId: string
  codigo: string
  descricao: string
  /** Quantidade vendida no período medido pela política. */
  quantidade: number
  /** Quantidade × preço de hoje. É estimativa: o preço de então pode ter mudado. */
  valor: number
  participacao: number
  acumulado: number
  faixa: "A" | "B" | "C"
}

/**
 * A curva ABC por valor — quais produtos sustentam a operação.
 *
 * Sai de `PoliticaDeCompra`, que guarda quanto cada produto vendeu no período
 * analisado pelo importador do sistema antigo. É a ÚNICA fonte com volume: as
 * vendas do PDV somam três dezenas de linhas de item.
 *
 * Duas honestidades que a tela precisa repetir ao usuário:
 *
 * 1. É um RETRATO, não uma série viva. Só muda quando alguém roda
 *    `scripts/calcular-politica-de-compra.mjs`. A data do cálculo vai junto.
 * 2. O valor é estimado: quantidade vendida × preço de HOJE. O preço praticado
 *    naquele período pode ter sido outro, e a política não guarda o preço.
 *
 * Corte clássico: A até 80% do valor acumulado, B até 95%, C o resto.
 *
 * **Só entra grupo do tipo "padrao".** Encomenda — clichê, saco impresso com o
 * nome da padaria — é feita sob medida para um cliente e não volta a vender;
 * na curva ela empurraria para a faixa A um produto que ninguém vai recomprar,
 * e o comprador formaria estoque de uma venda que não repete. A transferência
 * entre lojas já fica fora por outro caminho: a política é calculada da VENDA,
 * e transferência não é venda.
 */
export async function curvaAbc(limite = 10) {
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
          quantidade: p.vendidoNoPeriodo,
          valor: p.vendidoNoPeriodo * produto.preco,
        },
      ]
    })
    .sort((a, b) => b.valor - a.valor)

  const total = todas.reduce((s, l) => s + l.valor, 0)
  if (total <= 0) return null

  let acumulado = 0
  const comFaixa: LinhaAbc[] = todas.map((l) => {
    const participacao = (l.valor / total) * 100
    acumulado += participacao
    return {
      ...l,
      valor: arredondar(l.valor),
      participacao: arredondar(participacao),
      acumulado: arredondar(acumulado),
      faixa: acumulado <= 80 ? "A" : acumulado <= 95 ? "B" : "C",
    }
  })

  const conta = (f: "A" | "B" | "C") => comFaixa.filter((l) => l.faixa === f).length

  return {
    linhas: comFaixa.slice(0, limite),
    total: arredondar(total),
    produtos: comFaixa.length,
    faixas: { A: conta("A"), B: conta("B"), C: conta("C") },
    calculadoEm: politicas[0].calculadoEm.toISOString(),
    diasAnalisados: politicas[0].diasAnalisados,
    /** Quantos produtos ficaram de fora por serem de grupo que não é padrão. */
    foraPorGrupo: foraDaAnalise,
  }
}

/**
 * Quem vendeu e para quem, das vendas do PDV.
 *
 * Aqui o volume é pequeno de propósito — é o que o PDV registrou desde que
 * entrou no ar. A tela diz isso em vez de fingir que o ranking é da rede.
 */
export async function rankingsDoPdv(dias: number, lojas: string[]) {
  const inicio = new Date(Date.now() - dias * DIA_MS)

  const vendas = await db.venda.findMany({
    where: {
      AND: [
        { loja: { in: lojas }, criadaEm: { gte: inicio } },
        NAO_CANCELADA,
        NAO_E_TRANSFERENCIA,
      ],
    },
    select: { vendedorId: true, vendedorNome: true, clienteId: true, clienteNome: true, total: true },
  })

  const soma = (chave: "vendedor" | "cliente") => {
    const mapa = new Map<string, { nome: string; total: number; vendas: number }>()
    for (const v of vendas) {
      const id = chave === "vendedor" ? v.vendedorId : v.clienteId
      const nome = chave === "vendedor" ? v.vendedorNome : v.clienteNome
      /*
       * Sem vendedor ou sem cliente fica de FORA do ranking, em vez de virar
       * uma linha "sem identificação" que ganharia de todo mundo: no balcão a
       * maioria das vendas é ao consumidor final sem cadastro, e essa linha
       * seria sempre a primeira, dizendo nada.
       */
      if (!id || !nome) continue
      const atual = mapa.get(id) ?? { nome, total: 0, vendas: 0 }
      atual.total += v.total
      atual.vendas += 1
      mapa.set(id, atual)
    }
    return [...mapa.values()]
      .map((l) => ({ ...l, total: arredondar(l.total) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  }

  return {
    vendedores: soma("vendedor"),
    clientes: soma("cliente"),
    vendasConsideradas: vendas.length,
    semVendedor: vendas.filter((v) => !v.vendedorId).length,
    semCliente: vendas.filter((v) => !v.clienteId).length,
  }
}

/** Os números grandes do topo: mês corrente contra o mês anterior. */
export async function resumoDoMes(lojas: string[]) {
  const agora = new Date()
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1)
  const inicioAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1)

  const [mes, anterior, percentuais] = await Promise.all([
    db.receita.aggregate({
      where: { data: { gte: inicioMes }, loja: { in: lojas } },
      _sum: { valor: true },
      _count: { _all: true },
    }),
    db.receita.aggregate({
      where: { data: { gte: inicioAnterior, lt: inicioMes }, loja: { in: lojas } },
      _sum: { valor: true },
    }),
    percentuaisDaOperacao(),
  ])

  const faturamento = arredondar(mes._sum.valor ?? 0)
  const faturamentoAnterior = arredondar(anterior._sum.valor ?? 0)

  /*
   * O mês corrente está pela metade, então comparar o total dele com o total do
   * anterior sempre acusaria queda. O que se compara é o RITMO: quanto por dia
   * decorrido, contra quanto por dia o mês anterior fez inteiro.
   */
  const diaDoMes = agora.getDate()
  const diasNoAnterior = new Date(agora.getFullYear(), agora.getMonth(), 0).getDate()
  const porDia = faturamento / diaDoMes
  const porDiaAnterior = faturamentoAnterior / diasNoAnterior
  const variacao = porDiaAnterior > 0 ? ((porDia - porDiaAnterior) / porDiaAnterior) * 100 : null

  /** O que sobra depois dos custos da operação, na régua da precificação. */
  const margem = 100 - percentuais.pctFixas - percentuais.pctVariaveis

  return {
    faturamento,
    faturamentoAnterior,
    porDia: arredondar(porDia),
    porDiaAnterior: arredondar(porDiaAnterior),
    variacao: variacao === null ? null : arredondar(variacao),
    diaDoMes,
    lancamentos: mes._count._all,
    pctFixas: percentuais.pctFixas,
    pctVariaveis: percentuais.pctVariaveis,
    margem: arredondar(margem),
    periodoDosCustos: { de: percentuais.de, ate: percentuais.ate },
  }
}
