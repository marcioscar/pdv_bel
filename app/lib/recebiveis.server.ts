import type { Prisma } from "@prisma/client"

import { seuNumeroDaParcela } from "~/lib/cobranca.server"
import { db } from "~/lib/db.server"
import {
  depoisDoDia,
  diaAdiante,
  diaDeHoje,
  inicioDoDia,
  PRIMEIRO_DIA,
  ULTIMO_DIA,
} from "~/lib/dia"
import {
  SITUACOES_EM_ABERTO,
  SITUACOES_ENCERRADAS,
  SITUACOES_RECEBIDAS,
  SITUACOES_RECEBIVEIS,
  type FiltroRecebiveis,
  type SituacaoRecebivel,
} from "~/lib/recebiveis"

/**
 * Contas a receber: a carteira de boletos, olhada pelo VENCIMENTO.
 *
 * A tela de vendas responde "o que foi vendido"; esta responde "quem me deve, e
 * desde quando". São perguntas diferentes o bastante para não caberem na mesma
 * consulta: lá o eixo do tempo é a data da venda, aqui é a data em que o dinheiro
 * entra — e uma venda de março com parcela para julho aparece em lugares
 * distintos nas duas.
 */

export const RECEBIVEIS_POR_PAGINA = 50

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * Lê o filtro da URL, recusando o que não é do usuário.
 *
 * Como em vendas, `lojas` sai daqui já cruzado com as permitidas — é este
 * cruzamento, e não o seletor da tela, que impede alguém de ver a carteira de
 * uma loja onde não opera trocando `?loja=` na barra de endereço.
 *
 * O padrão é diferente do de vendas de propósito: tudo o que já venceu mais os
 * próximos trinta dias, em aberto. Um padrão de "últimos sete dias" numa tela de
 * cobrança esconderia exatamente a dívida velha, que é a que precisa ser vista.
 */
export function lerFiltroRecebiveis(
  url: URL,
  lojasPermitidas: string[]
): FiltroRecebiveis {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const temDe = DIA.test(texto("de"))
  const temAte = DIA.test(texto("ate"))

  const de = temDe ? texto("de") : temAte ? texto("ate") : PRIMEIRO_DIA
  const ateBruto = temAte ? texto("ate") : temDe ? texto("de") : diaAdiante(30)
  // Datas invertidas vêm de digitação, não de má-fé.
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const loja = lojasPermitidas.includes(texto("loja")) ? texto("loja") : "todas"
  const situacao = texto("situacao")

  return {
    lojas: loja === "todas" ? lojasPermitidas : [loja],
    loja,
    de: inicio,
    ate: fim,
    numero: texto("numero").replace(/\D/g, "").slice(0, 9),
    cliente: texto("cliente").slice(0, 60),
    situacao: SITUACOES_RECEBIVEIS.some((s) => s.id === situacao)
      ? (situacao as SituacaoRecebivel)
      : "abertas",
    pagina: Math.max(1, Math.trunc(Number(params.get("pagina"))) || 1),
  }
}

/**
 * Os ids das vendas de um cliente, por nome ou documento.
 *
 * A cobrança não guarda o nome do pagador — guarda `vendaId`, e é a venda que
 * copiou nome e CPF/CNPJ no fechamento. Buscar pela venda é o que mantém a
 * carteira coerente com o histórico: cliente que trocou de nome no cadastro
 * continua sendo achado pelo nome que estava no boleto.
 */
/** O Prisma entrega o `contains` ao Mongo como regex cru: "(teste" derrubava a busca. */
function literal(busca: string) {
  return busca.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function vendasDoCliente(busca: string) {
  const digitos = busca.replace(/\D/g, "")
  const vendas = await db.venda.findMany({
    where: {
      OR: [
        { clienteNome: { contains: literal(busca), mode: "insensitive" } },
        ...(digitos.length >= 3 ? [{ clienteCpfCnpj: { contains: digitos } }] : []),
      ],
    },
    select: { id: true },
  })
  return vendas.map((venda) => venda.id)
}

function condicaoDaSituacao(
  situacao: SituacaoRecebivel,
  hoje: Date
): (Prisma.CobrancaWhereInput & Prisma.BoletoExternoWhereInput) | null {
  switch (situacao) {
    case "abertas":
      return { situacao: { in: SITUACOES_EM_ABERTO } }
    // Vencida é situação MAIS data: o Inter só marca "ATRASADO" quando quer, e
    // esperar por essa marca deixaria a parcela de ontem parecendo em dia.
    case "vencidas":
      return { situacao: { in: SITUACOES_EM_ABERTO }, vencimento: { lt: hoje } }
    case "recebidas":
      return { situacao: { in: SITUACOES_RECEBIDAS } }
    case "canceladas":
      return { situacao: { in: SITUACOES_ENCERRADAS } }
    default:
      return null
  }
}

/**
 * As cláusulas que o filtro produz, montadas uma vez para a tela e o relatório
 * usarem as MESMAS. Duas montagens divergiriam, e o dia em que divergissem a
 * folha impressa mandaria a pessoa à gaveta buscar boleto que a tela não listou.
 */
async function condicoesDoFiltro(filtro: FiltroRecebiveis, hoje: Date) {
  // `conteudo` fica separado do período porque é ele que responde "existe em
  // algum lugar?" quando a busca não acha nada nas datas pedidas.
  const conteudo: Prisma.CobrancaWhereInput[] = [{ loja: { in: filtro.lojas } }]

  if (filtro.numero) conteudo.push({ vendaNumero: Number(filtro.numero) })
  if (filtro.cliente) {
    // Nenhuma venda casando vira `in: []`, que não acha nada — que é a resposta
    // certa para "as contas do cliente que não existe".
    conteudo.push({ vendaId: { in: await vendasDoCliente(filtro.cliente) } })
  }

  const periodo: Prisma.CobrancaWhereInput = {
    vencimento: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) },
  }
  const base: Prisma.CobrancaWhereInput = { AND: [periodo, ...conteudo] }

  const daSituacao = condicaoDaSituacao(filtro.situacao, hoje)
  const where: Prisma.CobrancaWhereInput = daSituacao
    ? { AND: [periodo, ...conteudo, daSituacao] }
    : base

  return { conteudo, base, where, daSituacao }
}

/**
 * O mesmo filtro, traduzido para os boletos do sistema antigo (`boletos_externos`).
 *
 * Duas diferenças que não são escolha: boleto de fora não tem loja, tem a CONTA
 * que emitiu — então filtrar QI traz os da conta da matriz, que a QI divide com
 * a QNE. E não tem número de venda: o número pedido é procurado no "seu número"
 * dele, que é o que o sistema antigo imprimiu no papel.
 */
async function condicoesExternas(filtro: FiltroRecebiveis, hoje: Date) {
  const lojas = await db.loja.findMany({
    where: { codigo: { in: filtro.lojas } },
    select: { conta: true },
  })
  const conteudo: Prisma.BoletoExternoWhereInput[] = [
    { conta: { in: [...new Set(lojas.map((l) => l.conta))] } },
  ]
  if (filtro.numero) conteudo.push({ seuNumero: filtro.numero })
  if (filtro.cliente) {
    const digitos = filtro.cliente.replace(/\D/g, "")
    conteudo.push({
      OR: [
        { pagadorNome: { contains: literal(filtro.cliente), mode: "insensitive" } },
        ...(digitos.length >= 3 ? [{ pagadorCpfCnpj: { contains: digitos } }] : []),
      ],
    })
  }

  const periodo: Prisma.BoletoExternoWhereInput = {
    vencimento: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) },
  }
  const base: Prisma.BoletoExternoWhereInput = { AND: [periodo, ...conteudo] }
  const daSituacao = condicaoDaSituacao(filtro.situacao, hoje)
  const where: Prisma.BoletoExternoWhereInput = daSituacao
    ? { AND: [periodo, ...conteudo, daSituacao] }
    : base

  return { conteudo, base, where, daSituacao }
}

type ExternoCru = Awaited<ReturnType<typeof db.boletoExterno.findMany>>[number]

/**
 * O boleto de fora com a mesma forma de uma parcela do PDV, para tela e folha
 * não terem dois desenhos. O que ele não tem (venda, parcela) vem nulo, e é o
 * `origem` que diz à tela para não oferecer link de venda nem PDF.
 */
function externoComoRecebivel(b: ExternoCru) {
  return {
    origem: "antigo" as const,
    id: b.id,
    vendaId: null,
    vendaNumero: null,
    loja: b.conta,
    parcela: 1,
    parcelas: 1,
    situacao: b.situacao,
    valor: b.valor,
    vencimento: b.vencimento,
    linhaDigitavel: b.linhaDigitavel,
    nossoNumero: b.nossoNumero,
    /** O número que o sistema antigo imprimiu no boleto. */
    documento: b.seuNumero ?? b.nossoNumero ?? null,
    vendaEm: b.emissao,
    clienteNome: b.pagadorNome,
    clienteCpfCnpj: b.pagadorCpfCnpj,
    vendaCancelada: false,
  }
}

/** Duas listas já ordenadas por vencimento, numa só. */
function porVencimento<T extends { vencimento: Date }>(a: T[], b: T[]) {
  return [...a, ...b].sort((x, y) => x.vencimento.getTime() - y.vencimento.getTime())
}

/** Do mais antigo para o mais novo — que é a ordem em que a gaveta é arquivada
 *  e por onde quem cobra começa o dia. */
const POR_VENCIMENTO = [
  { vencimento: "asc" },
  { vendaNumero: "asc" },
  { parcela: "asc" },
] satisfies Prisma.CobrancaOrderByWithRelationInput[]

type CobrancaCrua = Awaited<ReturnType<typeof db.cobranca.findMany>>[number]

/**
 * Cola em cada parcela o pagador, que mora na venda — foi ela que copiou nome e
 * documento no fechamento, e é por isso que cliente renomeado no cadastro
 * continua aparecendo com o nome que saiu impresso no boleto.
 */
async function comOPagador(cobrancas: CobrancaCrua[]) {
  const vendas = await db.venda.findMany({
    where: { id: { in: cobrancas.map((cobranca) => cobranca.vendaId) } },
    select: {
      id: true,
      criadaEm: true,
      clienteNome: true,
      clienteCpfCnpj: true,
      canceladaEm: true,
    },
  })
  const porId = new Map(vendas.map((venda) => [venda.id, venda]))

  return cobrancas.map((cobranca) => {
    const venda = porId.get(cobranca.vendaId)
    return {
      origem: "pdv" as "pdv" | "antigo",
      id: cobranca.id,
      vendaId: cobranca.vendaId as string | null,
      vendaNumero: cobranca.vendaNumero as number | null,
      loja: cobranca.loja,
      parcela: cobranca.parcela,
      parcelas: cobranca.parcelas,
      situacao: cobranca.situacao,
      valor: cobranca.valor,
      vencimento: cobranca.vencimento,
      linhaDigitavel: cobranca.linhaDigitavel,
      /** O que está impresso no canto do boleto — é por ele que se acha o papel
       *  na gaveta. Fica nulo enquanto o Inter não termina de emitir. */
      nossoNumero: cobranca.nossoNumero,
      documento: seuNumeroDaParcela(
        cobranca.loja,
        cobranca.vendaNumero,
        cobranca.parcela,
        cobranca.parcelas
      ) as string | null,
      vendaEm: venda?.criadaEm ?? null,
      clienteNome: venda?.clienteNome ?? null,
      clienteCpfCnpj: venda?.clienteCpfCnpj ?? null,
      // Boleto vivo de venda cancelada é problema, não detalhe: a tela precisa
      // poder gritar em vez de mostrar a linha como qualquer outra.
      vendaCancelada: Boolean(venda?.canceladaEm),
    }
  })
}

export type RecebivelConsultado = Awaited<ReturnType<typeof comOPagador>>[number]

/**
 * As parcelas que casam com o filtro, uma página de cada vez.
 *
 * O resumo ignora de propósito o seletor de situação: os três cartões SÃO a
 * repartição por situação daquele período e daquela loja. Se obedecessem ao
 * seletor, escolher "recebidas" zeraria "a receber" e "vencido" — três números
 * onde dois são sempre zero não informam nada.
 */
export async function consultarRecebiveis(filtro: FiltroRecebiveis) {
  const hoje = inicioDoDia(diaDeHoje())
  const [pdv, fora] = await Promise.all([
    condicoesDoFiltro(filtro, hoje),
    condicoesExternas(filtro, hoje),
  ])

  const abertoPdv = { AND: [pdv.base, { situacao: { in: SITUACOES_EM_ABERTO } }] }
  const abertoFora = { AND: [fora.base, { situacao: { in: SITUACOES_EM_ABERTO } }] }
  const recebidoPdv = { AND: [pdv.base, { situacao: { in: SITUACOES_RECEBIDAS } }] }
  const recebidoFora = { AND: [fora.base, { situacao: { in: SITUACOES_RECEBIDAS } }] }

  /*
   * Duas coleções numa lista só, em ordem de vencimento. Para a página N basta
   * pegar as N primeiras páginas de CADA lado, juntar e cortar: nenhuma linha
   * da página N pode estar além disso em nenhuma das duas.
   */
  const ate = filtro.pagina * RECEBIVEIS_POR_PAGINA
  const soma = (r: { _sum: { valor: number | null }; _count: { _all: number } }[]) => ({
    valor: r.reduce((s, x) => s + (x._sum.valor ?? 0), 0),
    quantidade: r.reduce((s, x) => s + x._count._all, 0),
  })
  const agregado = { _sum: { valor: true }, _count: { _all: true } } as const

  const [
    dePdv, deFora, totalPdv, totalFora,
    aPdv, aFora, vPdv, vFora, rPdv, rFora,
  ] = await Promise.all([
    db.cobranca.findMany({ where: pdv.where, orderBy: POR_VENCIMENTO, take: ate }),
    db.boletoExterno.findMany({ where: fora.where, orderBy: { vencimento: "asc" }, take: ate }),
    db.cobranca.count({ where: pdv.where }),
    db.boletoExterno.count({ where: fora.where }),
    db.cobranca.aggregate({ where: abertoPdv, ...agregado }),
    db.boletoExterno.aggregate({ where: abertoFora, ...agregado }),
    db.cobranca.aggregate({ where: { AND: [abertoPdv, { vencimento: { lt: hoje } }] }, ...agregado }),
    db.boletoExterno.aggregate({ where: { AND: [abertoFora, { vencimento: { lt: hoje } }] }, ...agregado }),
    db.cobranca.aggregate({ where: recebidoPdv, ...agregado }),
    db.boletoExterno.aggregate({ where: recebidoFora, ...agregado }),
  ])

  const pagina = porVencimento(
    await comOPagador(dePdv),
    deFora.map(externoComoRecebivel)
  ).slice((filtro.pagina - 1) * RECEBIVEIS_POR_PAGINA, ate)
  const total = totalPdv + totalFora

  /**
   * Quantas casariam se o vencimento não estivesse no caminho. Mesma ideia da
   * tela de vendas: quem procura a venda #1234 ou a conta da Maria não sabe para
   * que dia ela foi combinada, e "nenhuma conta" parece defeito.
   */
  const foraDoPeriodo =
    total === 0 && (filtro.numero || filtro.cliente)
      ? (await db.cobranca.count({
          where: pdv.daSituacao ? { AND: [...pdv.conteudo, pdv.daSituacao] } : { AND: pdv.conteudo },
        })) +
        (await db.boletoExterno.count({
          where: fora.daSituacao
            ? { AND: [...fora.conteudo, fora.daSituacao] }
            : { AND: fora.conteudo },
        }))
      : 0

  const aberto = soma([aPdv, aFora])
  const vencido = soma([vPdv, vFora])
  const recebido = soma([rPdv, rFora])

  return {
    recebiveis: pagina,
    total,
    foraDoPeriodo,
    paginas: Math.max(1, Math.ceil(total / RECEBIVEIS_POR_PAGINA)),
    resumo: {
      aberto: aberto.valor,
      abertoQuantidade: aberto.quantidade,
      vencido: vencido.valor,
      vencidoQuantidade: vencido.quantidade,
      recebido: recebido.valor,
      recebidoQuantidade: recebido.quantidade,
    },
  }
}

/**
 * O teto da folha impressa.
 *
 * Uma A4 leva umas quarenta linhas, então isto já são vinte e cinco páginas —
 * mais que isso ninguém confere de pé na frente de uma gaveta, e uma consulta
 * sem teto é um jeito de derrubar o servidor pedindo "tudo" numa base grande. A
 * folha avisa quando corta, em vez de mentir um total que não confere.
 */
export const LIMITE_IMPRESSAO = 1000

/**
 * O mesmo filtro da tela, mas sem paginação: a folha de conferência precisa da
 * lista inteira, porque quem está na frente da gaveta não tem como pedir a
 * página 2.
 */
export async function recebiveisParaImpressao(filtro: FiltroRecebiveis) {
  const hoje = inicioDoDia(diaDeHoje())
  const [pdv, fora] = await Promise.all([
    condicoesDoFiltro(filtro, hoje),
    condicoesExternas(filtro, hoje),
  ])

  // Os boletos do sistema antigo entram na mesma folha: são eles, na maior
  // parte, os papéis que estão na gaveta.
  const [cobrancas, externos, totalPdv, totalFora] = await Promise.all([
    db.cobranca.findMany({ where: pdv.where, orderBy: POR_VENCIMENTO, take: LIMITE_IMPRESSAO }),
    db.boletoExterno.findMany({
      where: fora.where,
      orderBy: { vencimento: "asc" },
      take: LIMITE_IMPRESSAO,
    }),
    db.cobranca.count({ where: pdv.where }),
    db.boletoExterno.count({ where: fora.where }),
  ])

  const recebiveis = porVencimento(
    await comOPagador(cobrancas),
    externos.map(externoComoRecebivel)
  ).slice(0, LIMITE_IMPRESSAO)
  const total = totalPdv + totalFora

  return {
    recebiveis,
    total,
    /** Quantas ficaram de fora por causa do teto — a folha precisa admitir isso. */
    cortadas: Math.max(0, total - recebiveis.length),
  }
}
