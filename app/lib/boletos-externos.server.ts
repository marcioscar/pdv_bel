import { db } from "~/lib/db.server"
import { diaAdiante, diaAtras, diaDeHoje, emDia, inicioDoDia, meioDiaDe } from "~/lib/dia"
import { chamarInter, ErroInter, interConfigurado } from "~/lib/inter.server"
import { arredondar } from "~/lib/moeda"
import {
  SITUACOES_EM_ABERTO,
  SITUACOES_RECEBIDAS,
} from "~/lib/recebiveis"

/**
 * Os boletos que o Inter tem e este sistema não emitiu — os do sistema de
 * contas antigo, os do app do banco — e a conta de quem está devendo, somando
 * os dois lados.
 *
 * Existe porque a trava de inadimplência do caixa só enxergava os boletos do
 * PDV: o cliente que devia três boletos no sistema antigo passava aqui como bom
 * pagador. Decisão do Marcio (23/09/2026): trazer os em aberto de qualquer
 * data e todos os dos últimos 12 meses, e deixar o vencido travar a venda a
 * prazo como já trava o do PDV.
 */

/** Um item de `GET /cobranca/v3/cobrancas`, só com o que se usa aqui. */
type CobrancaDaLista = {
  cobranca: {
    codigoSolicitacao?: string
    seuNumero?: string
    situacao: string
    dataSituacao?: string
    dataEmissao?: string
    dataVencimento?: string
    valorNominal: string | number
    valorTotalRecebido?: string | number
    pagador: { nome: string; cpfCnpj: string }
  }
  boleto?: { nossoNumero?: string; linhaDigitavel?: string }
}

type PaginaDeCobrancas = {
  ultimaPagina?: boolean
  cobrancas: CobrancaDaLista[]
}

const ITENS_POR_PAGINA = 1000

/** Janela menor que isto não se divide mais: o erro é outro, não o intervalo. */
const MENOR_JANELA_DIAS = 31

function diasEntre(de: string, ate: string) {
  return Math.round((inicioDoDia(ate).getTime() - inicioDoDia(de).getTime()) / 86_400_000)
}

function somarDias(dia: string, dias: number) {
  const d = inicioDoDia(dia)
  d.setDate(d.getDate() + dias)
  const mes = String(d.getMonth() + 1).padStart(2, "0")
  return `${d.getFullYear()}-${mes}-${String(d.getDate()).padStart(2, "0")}`
}

/**
 * Todas as páginas de uma janela de vencimento.
 *
 * A doc do Inter não diz o maior intervalo que a consulta aceita. Em vez de
 * chutar um número, a janela é pedida inteira e, se o banco recusar com 400,
 * dividida ao meio até caber — o custo de errar para cima é uma chamada.
 */
async function buscarJanela(
  conta: string,
  de: string,
  ate: string,
  situacao?: string
): Promise<CobrancaDaLista[]> {
  const todas: CobrancaDaLista[] = []
  try {
    for (let pagina = 0; ; pagina++) {
      const busca = new URLSearchParams({
        dataInicial: de,
        dataFinal: ate,
        filtrarDataPor: "VENCIMENTO",
        "paginacao.itensPorPagina": String(ITENS_POR_PAGINA),
        "paginacao.paginaAtual": String(pagina),
      })
      if (situacao) busca.set("situacao", situacao)

      const resposta = await chamarInter<PaginaDeCobrancas>(
        `/cobranca/v3/cobrancas?${busca}`,
        { conta, escopos: ["boleto-cobranca.read"] }
      )
      const lote = resposta?.cobrancas ?? []
      todas.push(...lote)
      if (resposta?.ultimaPagina !== false || lote.length < ITENS_POR_PAGINA) break
    }
    return todas
  } catch (erro) {
    const dias = diasEntre(de, ate)
    if (erro instanceof ErroInter && erro.status === 400 && dias > MENOR_JANELA_DIAS) {
      const meio = somarDias(de, Math.floor(dias / 2))
      return [
        ...(await buscarJanela(conta, de, meio, situacao)),
        ...(await buscarJanela(conta, somarDias(meio, 1), ate, situacao)),
      ]
    }
    throw erro
  }
}

function numero(valor: string | number | undefined) {
  if (valor === undefined || valor === null || valor === "") return null
  const n = Number(valor)
  return Number.isFinite(n) ? n : null
}

/** O documento como o banco o guarda aqui: só o que identifica. */
function soDocumento(bruto: string) {
  return bruto.toUpperCase().replace(/[^0-9A-Z]/g, "")
}

function paraGravar(conta: string, item: CobrancaDaLista) {
  const c = item.cobranca
  return {
    codigoSolicitacao: c.codigoSolicitacao!,
    conta,
    seuNumero: c.seuNumero || null,
    situacao: c.situacao,
    dataSituacao: c.dataSituacao ? meioDiaDe(c.dataSituacao.slice(0, 10)) : null,
    emissao: c.dataEmissao ? meioDiaDe(c.dataEmissao.slice(0, 10)) : null,
    vencimento: meioDiaDe(c.dataVencimento!.slice(0, 10))!,
    valor: arredondar(numero(c.valorNominal) ?? 0),
    valorRecebido: numero(c.valorTotalRecebido),
    pagadorCpfCnpj: soDocumento(c.pagador?.cpfCnpj ?? ""),
    pagadorNome: (c.pagador?.nome ?? "").trim(),
    nossoNumero: item.boleto?.nossoNumero || null,
    linhaDigitavel: item.boleto?.linhaDigitavel || null,
  }
}

export type ResultadoDaBusca = {
  contas: { conta: string; trazidos: number; novos: number; atualizados: number; erro?: string }[]
  ignoradosDoPdv: number
}

/**
 * Traz do Inter os boletos que não nasceram aqui, das contas de todas as lojas.
 *
 * Três consultas por conta:
 * - todo boleto com vencimento de 12 meses atrás até 2 anos à frente, em
 *   qualquer situação — o histórico de quem paga em dia e o que ainda vai vencer;
 * - e, antes disso, só os que continuam devendo (ATRASADO e PROTESTO).
 *
 * Boleto emitido por este PDV é pulado: esse já mora em `cobrancas`, com a
 * venda dele. Guardar duas vezes contaria a mesma dívida em dobro.
 */
export async function buscarBoletosNoInter(): Promise<ResultadoDaBusca> {
  /*
   * Os índices não nascem com o deploy (o build só roda `prisma generate`), e o
   * único é o que impede dois cliques seguidos de gravarem o mesmo boleto duas
   * vezes. createIndexes é idempotente: na segunda busca não faz nada.
   */
  await db.$runCommandRaw({
    createIndexes: "boletos_externos",
    indexes: [
      { key: { codigoSolicitacao: 1 }, name: "codigoSolicitacao_1", unique: true },
      { key: { pagadorCpfCnpj: 1 }, name: "pagadorCpfCnpj_1" },
      { key: { situacao: 1, vencimento: 1 }, name: "situacao_1_vencimento_1" },
    ],
  })

  const lojas = await db.loja.findMany({ select: { conta: true } })
  const contas = [...new Set(lojas.map((l) => l.conta))].filter(interConfigurado)

  const doPdv = new Set(
    (await db.cobranca.findMany({ select: { codigoSolicitacao: true } })).map(
      (c) => c.codigoSolicitacao
    )
  )

  const umAnoAtras = diaAtras(365)
  const resultado: ResultadoDaBusca = { contas: [], ignoradosDoPdv: 0 }

  for (const conta of contas) {
    try {
      const itens = [
        ...(await buscarJanela(conta, umAnoAtras, diaAdiante(730))),
        ...(await buscarJanela(conta, "2015-01-01", somarDias(umAnoAtras, -1), "ATRASADO")),
        ...(await buscarJanela(conta, "2015-01-01", somarDias(umAnoAtras, -1), "PROTESTO")),
      ].filter((i) => i.cobranca?.codigoSolicitacao && i.cobranca.dataVencimento)

      const deFora = itens.filter((i) => !doPdv.has(i.cobranca.codigoSolicitacao!))
      resultado.ignoradosDoPdv += itens.length - deFora.length

      const { novos, atualizados } = await gravar(deFora.map((i) => paraGravar(conta, i)))
      resultado.contas.push({ conta, trazidos: deFora.length, novos, atualizados })
    } catch (erro) {
      resultado.contas.push({
        conta,
        trazidos: 0,
        novos: 0,
        atualizados: 0,
        erro: erro instanceof Error ? erro.message : String(erro),
      })
    }
  }

  // O boleto antigo que estava em aberto e foi pago sai da consulta de
  // ATRASADO — e ficaria "devendo" aqui para sempre. Esses são conferidos um a um.
  await reconferirAbertosAntigos(umAnoAtras)

  return resultado
}

type BoletoParaGravar = ReturnType<typeof paraGravar>

async function gravar(boletos: BoletoParaGravar[]) {
  if (boletos.length === 0) return { novos: 0, atualizados: 0 }

  const existentes = new Map(
    (
      await db.boletoExterno.findMany({
        where: { codigoSolicitacao: { in: boletos.map((b) => b.codigoSolicitacao) } },
        select: { codigoSolicitacao: true, situacao: true, valorRecebido: true },
      })
    ).map((b) => [b.codigoSolicitacao, b])
  )

  const agora = new Date()
  const novos = boletos.filter((b) => !existentes.has(b.codigoSolicitacao))
  for (let i = 0; i < novos.length; i += 500) {
    await db.boletoExterno.createMany({
      data: novos.slice(i, i + 500).map((b) => ({ ...b, conferidoEm: agora })),
    })
  }

  // Os que não mudaram só ganham a data da conferência, numa gravação só: um a
  // um seriam milhares de idas ao banco a cada busca.
  const iguais = boletos.filter((b) => {
    const antes = existentes.get(b.codigoSolicitacao)
    return antes && antes.situacao === b.situacao && antes.valorRecebido === b.valorRecebido
  })
  if (iguais.length > 0) {
    await db.boletoExterno.updateMany({
      where: { codigoSolicitacao: { in: iguais.map((b) => b.codigoSolicitacao) } },
      data: { conferidoEm: agora },
    })
  }

  let atualizados = 0
  for (const b of boletos) {
    const antes = existentes.get(b.codigoSolicitacao)
    if (!antes) continue
    if (antes.situacao === b.situacao && antes.valorRecebido === b.valorRecebido) continue
    await db.boletoExterno.update({
      where: { codigoSolicitacao: b.codigoSolicitacao },
      data: { ...b, conferidoEm: agora },
    })
    atualizados++
  }

  return { novos: novos.length, atualizados }
}

/** Uma cobrança consultada pelo código — o suficiente para atualizar a situação. */
type CobrancaDetalhada = {
  cobranca: CobrancaDaLista["cobranca"]
  boleto?: CobrancaDaLista["boleto"]
}

/**
 * Confere um boleto externo no Inter e grava a situação de lá. É o que o
 * webhook chama quando o aviso é de um boleto que não é do PDV — o Inter
 * avisa de todos os boletos da conta, não só dos emitidos por esta aplicação.
 *
 * Devolve `null` quando o boleto não é conhecido aqui (ninguém buscou ainda).
 */
export async function reconferirBoletoExterno(codigoSolicitacao: string) {
  const guardado = await db.boletoExterno.findUnique({ where: { codigoSolicitacao } })
  if (!guardado) return null

  const detalhe = await chamarInter<CobrancaDetalhada>(
    `/cobranca/v3/cobrancas/${codigoSolicitacao}`,
    { conta: guardado.conta, escopos: ["boleto-cobranca.read"] }
  )
  if (!detalhe?.cobranca?.dataVencimento) return { antes: guardado.situacao, depois: guardado.situacao }

  const novo = paraGravar(guardado.conta, {
    cobranca: { ...detalhe.cobranca, codigoSolicitacao },
    boleto: detalhe.boleto,
  })
  await db.boletoExterno.update({
    where: { codigoSolicitacao },
    data: { ...novo, conferidoEm: new Date() },
  })
  return { antes: guardado.situacao, depois: novo.situacao }
}

async function reconferirAbertosAntigos(umAnoAtras: string) {
  const antigos = await db.boletoExterno.findMany({
    where: {
      situacao: { in: SITUACOES_EM_ABERTO },
      vencimento: { lt: inicioDoDia(umAnoAtras) },
      conferidoEm: { lt: new Date(Date.now() - 5 * 60_000) },
    },
    select: { codigoSolicitacao: true },
  })
  for (const b of antigos) {
    try {
      await reconferirBoletoExterno(b.codigoSolicitacao)
    } catch {
      // Um que falhe não derruba a busca inteira; fica para a próxima.
    }
  }
}

// ---------------------------------------------------------------------------
// Inadimplentes: o PDV e o sistema antigo na mesma conta
// ---------------------------------------------------------------------------

export type BoletoDoDevedor = {
  origem: "pdv" | "antigo"
  referencia: string
  conta: string
  vencimento: Date
  valor: number
  situacao: string
  linhaDigitavel: string | null
}

/**
 * Quem deve, somando os boletos vencidos do PDV e os de fora, por CPF/CNPJ.
 *
 * O documento é a chave porque é a única coisa que os dois lados têm em comum:
 * o boleto do PDV sabe o cliente pela venda, o de fora só pelo pagador. Nome
 * não serve — "PADARIA X LTDA" e "Padaria X" são o mesmo devedor.
 */
export async function inadimplentes() {
  const hoje = inicioDoDia(diaDeHoje())
  const abertoVencido = { situacao: { in: SITUACOES_EM_ABERTO }, vencimento: { lt: hoje } }

  const [doPdv, deFora] = await Promise.all([
    db.cobranca.findMany({ where: abertoVencido }),
    db.boletoExterno.findMany({ where: abertoVencido }),
  ])

  const vendas = await db.venda.findMany({
    where: { id: { in: [...new Set(doPdv.map((c) => c.vendaId))] } },
    select: { id: true, clienteCpfCnpj: true, clienteNome: true },
  })
  const vendaPorId = new Map(vendas.map((v) => [v.id, v]))

  const grupos = new Map<string, { nome: string; boletos: BoletoDoDevedor[] }>()
  const juntar = (documento: string, nome: string, boleto: BoletoDoDevedor) => {
    const chave = documento || `sem-documento:${nome}`
    const grupo = grupos.get(chave) ?? { nome, boletos: [] }
    grupo.boletos.push(boleto)
    grupos.set(chave, grupo)
  }

  for (const c of doPdv) {
    const venda = vendaPorId.get(c.vendaId)
    juntar(soDocumento(venda?.clienteCpfCnpj ?? ""), venda?.clienteNome ?? "—", {
      origem: "pdv",
      referencia: `Venda #${c.vendaNumero}${c.parcelas > 1 ? ` · ${c.parcela}/${c.parcelas}` : ""}`,
      conta: c.conta,
      vencimento: c.vencimento,
      valor: c.valor,
      situacao: c.situacao,
      linhaDigitavel: c.linhaDigitavel,
    })
  }
  for (const b of deFora) {
    juntar(b.pagadorCpfCnpj, b.pagadorNome, {
      origem: "antigo",
      referencia: b.seuNumero ? `Nº ${b.seuNumero}` : "Sistema antigo",
      conta: b.conta,
      vencimento: b.vencimento,
      valor: b.valor,
      situacao: b.situacao,
      linhaDigitavel: b.linhaDigitavel,
    })
  }

  // O cadastro daqui, quando existe: nome certo e telefone para ligar.
  const documentos = [...grupos.keys()].filter((d) => !d.startsWith("sem-documento:"))
  const clientes = await db.cliente.findMany({
    where: { cpfCnpj: { in: documentos } },
    select: {
      id: true,
      cpfCnpj: true,
      nome: true,
      nomeFantasia: true,
      ddd: true,
      telefone: true,
      contatoNome: true,
      contatoTelefone: true,
    },
  })
  const clientePorDocumento = new Map(clientes.map((c) => [c.cpfCnpj, c]))

  const hojeMs = hoje.getTime()
  const linhas = [...grupos.entries()]
    .map(([documento, grupo]) => {
      const boletos = grupo.boletos.sort((a, b) => a.vencimento.getTime() - b.vencimento.getTime())
      const cliente = clientePorDocumento.get(documento) ?? null
      const telefone = cliente?.telefone
        ? `${cliente.ddd ? `(${cliente.ddd}) ` : ""}${cliente.telefone}`
        : null
      return {
        documento: documento.startsWith("sem-documento:") ? null : documento,
        nome: cliente?.nome ?? grupo.nome,
        nomeFantasia: cliente?.nomeFantasia ?? null,
        clienteId: cliente?.id ?? null,
        telefone,
        contato: cliente?.contatoNome
          ? `${cliente.contatoNome}${cliente.contatoTelefone ? ` · ${cliente.contatoTelefone}` : ""}`
          : null,
        total: arredondar(boletos.reduce((s, b) => s + b.valor, 0)),
        diasAtraso: Math.floor((hojeMs - inicioDoDia(emDia(boletos[0].vencimento)).getTime()) / 86_400_000),
        boletos,
      }
    })
    .sort((a, b) => b.total - a.total)

  return linhas
}

/**
 * O retrato do que há para receber: vencido, a vencer e o que entrou nos
 * últimos 30 dias — os dois lados juntos, e separados para quem quiser ver de
 * onde vem cada parte.
 */
export async function resumoDosBoletos() {
  const hoje = inicioDoDia(diaDeHoje())
  const trintaDias = inicioDoDia(diaAtras(30))

  const soma = async (
    modelo: "cobranca" | "boletoExterno",
    where: Record<string, unknown>
  ) => {
    const r =
      modelo === "cobranca"
        ? await db.cobranca.aggregate({ where, _sum: { valor: true }, _count: { _all: true } })
        : await db.boletoExterno.aggregate({ where, _sum: { valor: true }, _count: { _all: true } })
    return { valor: arredondar(r._sum.valor ?? 0), quantidade: r._count._all }
  }

  const vencido = { situacao: { in: SITUACOES_EM_ABERTO }, vencimento: { lt: hoje } }
  const aVencer = { situacao: { in: SITUACOES_EM_ABERTO }, vencimento: { gte: hoje } }

  const [vencidoPdv, vencidoAntigo, aVencerPdv, aVencerAntigo, recebidoPdv, recebidoAntigo, ultima] =
    await Promise.all([
      soma("cobranca", vencido),
      soma("boletoExterno", vencido),
      soma("cobranca", aVencer),
      soma("boletoExterno", aVencer),
      // O boleto do PDV não guarda a data do pagamento; a última mudança dele
      // é a melhor aproximação que existe aqui.
      soma("cobranca", { situacao: { in: SITUACOES_RECEBIDAS }, atualizadaEm: { gte: trintaDias } }),
      soma("boletoExterno", { situacao: { in: SITUACOES_RECEBIDAS }, dataSituacao: { gte: trintaDias } }),
      db.boletoExterno.findFirst({ orderBy: { conferidoEm: "desc" }, select: { conferidoEm: true } }),
    ])

  return {
    vencido: { pdv: vencidoPdv, antigo: vencidoAntigo },
    aVencer: { pdv: aVencerPdv, antigo: aVencerAntigo },
    recebido30: { pdv: recebidoPdv, antigo: recebidoAntigo },
    ultimaBusca: ultima?.conferidoEm ?? null,
  }
}

/** Os últimos pagamentos que caíram, de qualquer lado — é o "entrou?" do dia. */
export async function pagamentosRecentes(limite = 20) {
  const [doPdv, deFora] = await Promise.all([
    db.cobranca.findMany({
      where: { situacao: { in: SITUACOES_RECEBIDAS } },
      orderBy: { atualizadaEm: "desc" },
      take: limite,
    }),
    db.boletoExterno.findMany({
      where: { situacao: { in: SITUACOES_RECEBIDAS } },
      orderBy: { dataSituacao: "desc" },
      take: limite,
    }),
  ])

  const vendas = await db.venda.findMany({
    where: { id: { in: doPdv.map((c) => c.vendaId) } },
    select: { id: true, clienteNome: true },
  })
  const nomeDaVenda = new Map(vendas.map((v) => [v.id, v.clienteNome]))

  return [
    ...doPdv.map((c) => ({
      origem: "pdv" as const,
      quando: c.atualizadaEm,
      nome: nomeDaVenda.get(c.vendaId) ?? "—",
      referencia: `Venda #${c.vendaNumero}`,
      valor: c.valor,
      situacao: c.situacao,
    })),
    ...deFora.map((b) => ({
      origem: "antigo" as const,
      quando: b.dataSituacao ?? b.conferidoEm,
      nome: b.pagadorNome,
      referencia: b.seuNumero ? `Nº ${b.seuNumero}` : "Sistema antigo",
      valor: b.valorRecebido ?? b.valor,
      situacao: b.situacao,
    })),
  ]
    .sort((a, b) => b.quando.getTime() - a.quando.getTime())
    .slice(0, limite)
}
