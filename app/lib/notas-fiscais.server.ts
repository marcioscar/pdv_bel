import type { Prisma } from "@prisma/client"

import { db } from "~/lib/db.server"
import { PRIMEIRO_DIA, ULTIMO_DIA, depoisDoDia, inicioDoDia } from "~/lib/dia"
import {
  SITUACOES_NOTA,
  type FiltroNotas,
  type SituacaoNota,
} from "~/lib/notas-fiscais"
import {
  consultarChaveNaSefaz,
  consultarNsuAvulsoNaSefaz,
  consultarNsuNaSefaz,
  decodificarChave,
  resumoDoProcNFe,
  resumoDoResNFe,
  type ResultadoConsultaChave,
} from "~/lib/sefaz.server"

/**
 * O catálogo local de NF-e de fornecedor, mantido em dia com a SEFAZ.
 *
 * Isto NÃO é a entrada de estoque — é o que a rede já sabe que existe,
 * disponível para o gerente escolher o que processar. A entrada de verdade
 * (bater item a item com o catálogo, mover o saldo) é a próxima etapa.
 */

/** Até 20 páginas de 50 documentos (1000) por clique — o suficiente para um mês
 * de movimento típico sem travar a tela nem arriscar o limite de consumo da SEFAZ. */
const PAGINAS_POR_SINCRONIZACAO = 20

export type ResultadoSincronizacao =
  | { ok: true; novas: number; paginas: number; completo: boolean }
  | { ok: false; erro: string; novas: number }

/**
 * Avança a sincronização da loja a partir de onde parou da última vez.
 *
 * Cada página gravada some no cursor (`SincronizacaoSefaz`) IMEDIATAMENTE, não
 * só no fim — se a SEFAZ recusar no meio (limite de consumo, rede caiu), o
 * progresso já feito fica e a próxima tentativa continua dali, em vez de
 * repetir tudo.
 */
export async function sincronizarNotasDaLoja(
  loja: string,
  maxPaginas = PAGINAS_POR_SINCRONIZACAO
): Promise<ResultadoSincronizacao> {
  const cursor = await db.sincronizacaoSefaz.findUnique({ where: { loja } })

  if (cursor?.proximaConsultaEm && cursor.proximaConsultaEm > new Date()) {
    const quanto = emTexto(cursor.proximaConsultaEm.getTime() - Date.now())
    return {
      ok: false,
      novas: 0,
      erro: cursor.recusasSeguidas
        ? `A SEFAZ recusou por consumo indevido ${cursor.recusasSeguidas}x seguidas e a punição dela é ` +
          `progressiva — insistir estica o castigo. Próxima tentativa em ${quanto}.`
        : `Já está em dia com a SEFAZ. Ela bloqueia o CNPJ por uma hora quando se pergunta ` +
          `sem ter novidade — pode tentar de novo em ${quanto}.`,
    }
  }

  let ultNsu = normalizarNsu(cursor?.ultNsu ?? "0")
  // O maior NSU que a SEFAZ já disse existir. Guardado à parte porque as
  // recusas precisam poder gravar o cursor sem inventar este número.
  let maxNsuConhecido = normalizarNsu(cursor?.maxNsu ?? "0")
  let novas = 0

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const resultado = await consultarNsuNaSefaz(loja, ultNsu)
    if (!resultado.ok) {
      // A recusa por consumo indevido vale para o CNPJ inteiro: registrar aqui
      // evita que o próximo clique gaste outra tentativa à toa e estenda o
      // castigo, que é progressivo.
      //
      // Grava o `maxNsu` que já se conhecia, e não o `ultNsu` de agora: numa
      // recusa a SEFAZ não informa quanto existe, e copiar o nosso próprio
      // número para lá apaga a única prova de que ainda falta documento — a
      // loja passa a parecer em dia justamente porque a consulta foi negada.
      if (/consumo indevido|limite de consultas/i.test(resultado.erro)) {
        const recusas = (cursor?.recusasSeguidas ?? 0) + 1
        const ate = await guardarRecusa(loja, ultNsu, maxNsuConhecido, recusas)
        return {
          ok: false,
          novas,
          erro:
            `${resultado.erro}. Recusa ${recusas} seguida — a punição da SEFAZ é progressiva, ` +
            `então a próxima tentativa só fica liberada às ${ate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`,
        }
      }
      return { ok: false, erro: resultado.erro, novas }
    }

    for (const doc of resultado.documentos) {
      // procEventoNFe/resEvento são manifestação, cancelamento, carta de
      // correção — não são a nota em si, e a lista é só de notas.
      const chave = ehNota(doc.schema) ? await gravarNota(loja, doc.schema, doc.xml, doc.nsu) : null
      if (chave) novas++
      // Registrado mesmo quando ignorado: é o que separa "evento que não
      // interessa" de "documento que nunca chegou" na hora de procurar buraco.
      await registrarDocumento(loja, doc.nsu, doc.schema, chave)
    }

    // A SEFAZ respondeu sem dizer até onde foi. Antes isto era preenchido com
    // o NSU que nós mesmos tínhamos mandado — e o efeito era o cursor se
    // declarar em dia sozinho: "até onde fui" batia com "quanto existe" porque
    // os dois eram o nosso próprio número. Foi assim que dez dias de notas
    // ficaram do lado de fora com a tela dizendo "em dia · faltam 0".
    //
    // Sem os dois campos, o cursor fica onde está: repetir a consulta custa uma
    // chamada, pular documento custa uma nota fiscal que ninguém sabe que existe.
    if (resultado.ultNSU == null || resultado.maxNSU == null) {
      return {
        ok: false,
        novas,
        erro:
          `A SEFAZ respondeu (cStat ${resultado.cStat}: ${resultado.xMotivo}) sem informar ` +
          `ultNSU/maxNSU. O cursor foi mantido em ${Number(ultNsu)} para não pular documento — ` +
          `tente de novo em alguns minutos.`,
      }
    }

    // Comparação numérica, e não de texto: a SEFAZ devolve o NSU com zeros à
    // esquerda ("000000000021930") e o cursor já foi gravado sem eles
    // ("21930"). Comparar como texto dava "diferente" para o mesmo número, o
    // laço nunca via que tinha chegado ao fim e repetia a mesma consulta até
    // a SEFAZ bloquear o CNPJ por consumo indevido.
    const anterior = ultNsu
    ultNsu = normalizarNsu(resultado.ultNSU)
    const maxNsu = normalizarNsu(resultado.maxNSU)
    maxNsuConhecido = maxNsu

    const semProgresso = Number(ultNsu) <= Number(anterior)
    const emDia = Number(ultNsu) >= Number(maxNsu)

    // Sem novidade, a SEFAZ manda esperar uma hora antes de perguntar de novo.
    await guardarCursor(loja, ultNsu, maxNsu, semProgresso || emDia ? esperaDeUmaHora() : null)

    if (semProgresso || emDia) {
      return { ok: true, novas, paginas: pagina + 1, completo: true }
    }
  }

  return { ok: true, novas, paginas: maxPaginas, completo: false }
}

export type BuracosDaSincronizacao = {
  /** O primeiro NSU que já se viu — antes dele não há registro, então não há o que afirmar. */
  de: number
  /** Até onde o cursor diz ter ido. */
  ate: number
  /** Os NSUs nunca entregues, os primeiros primeiro. Truncado — o total vem à parte. */
  faltando: number[]
  total: number
}

/**
 * Os NSUs que a sincronização nunca viu passar, dentro da faixa que ela já
 * percorreu.
 *
 * O NSU é uma sequência contínua por CNPJ: se o 21950 e o 21952 chegaram e o
 * 21951 não, aquele documento existiu e ficou de fora. É esta a pergunta que
 * antes só se respondia rebobinando o cursor — o que a SEFAZ pune.
 *
 * Só enxerga dali para frente: o registro (`DocumentoDistribuido`) nasceu com
 * esta correção, então buraco anterior a ele é invisível aqui. Para aqueles
 * resta a busca por chave, com o DANFE do fornecedor na mão.
 */
export async function buracosDaSincronizacao(
  loja: string,
  limite = 200
): Promise<BuracosDaSincronizacao> {
  const [cursor, primeiro, quantos] = await Promise.all([
    db.sincronizacaoSefaz.findUnique({ where: { loja } }),
    db.documentoDistribuido.findFirst({ where: { loja }, select: { nsu: true }, orderBy: { nsu: "asc" } }),
    db.documentoDistribuido.count({ where: { loja } }),
  ])
  if (!cursor || !primeiro) return { de: 0, ate: 0, faltando: [], total: 0 }

  const de = Number(primeiro.nsu)
  const ate = Number(cursor.ultNsu)

  // Atalho pela contagem: se há tantos registros quanto números na faixa, não
  // falta nenhum — e a tela, que faz esta pergunta a cada carregamento, não
  // precisa trazer as dezenas de milhares de linhas para descobrir isso.
  if (quantos >= ate - de + 1) return { de, ate, faltando: [], total: 0 }

  const vistos = await db.documentoDistribuido.findMany({
    where: { loja },
    select: { nsu: true },
    orderBy: { nsu: "asc" },
  })
  const numeros = new Set(vistos.map((v) => Number(v.nsu)))

  const faltando: number[] = []
  let total = 0
  for (let n = de; n <= ate; n++) {
    if (numeros.has(n)) continue
    total++
    if (faltando.length < limite) faltando.push(n)
  }

  return { de, ate, faltando, total }
}

export type ResultadoRecuperacao =
  | { ok: true; buscados: number; notas: number; vazios: number }
  | { ok: false; erro: string; buscados: number; notas: number }

/**
 * Busca NSUs específicos (`consNSU`) e grava o que vier.
 *
 * Um por chamada, de propósito: é o preço de poder reler o passado sem mexer
 * no cursor de distribuição. Para na primeira recusa em vez de insistir — a
 * cota é por hora e por CNPJ, e gastar o resto dela contra uma porta fechada
 * só estende o bloqueio.
 *
 * NSU que a SEFAZ diz não ter nada fica registrado como vazio: a numeração não
 * é densa por interessado, e sem isso o mesmo buraco seria perguntado para
 * sempre, a cada vez consumindo cota.
 */
export async function recuperarNsus(loja: string, nsus: number[]): Promise<ResultadoRecuperacao> {
  let buscados = 0
  let notas = 0
  let vazios = 0

  for (const numero of nsus) {
    const nsu = normalizarNsu(String(numero))
    const resultado = await consultarNsuAvulsoNaSefaz(loja, nsu)
    if (!resultado.ok) return { ok: false, erro: resultado.erro, buscados, notas }

    buscados++

    if (!resultado.documento) {
      await registrarDocumento(loja, nsu, "vazio", null)
      vazios++
      continue
    }

    const { schema, xml, nsu: nsuDoDoc } = resultado.documento
    const chave = ehNota(schema) ? await gravarNota(loja, schema, xml, nsuDoDoc || nsu) : null
    if (chave) notas++
    await registrarDocumento(loja, nsuDoDoc || nsu, schema, chave)
  }

  return { ok: true, buscados, notas, vazios }
}

/** Os 15 dígitos com zeros à esquerda que a SEFAZ usa — um formato só, sempre. */
function normalizarNsu(valor: string) {
  return (valor.replace(/\D/g, "") || "0").padStart(15, "0").slice(-15)
}

function esperaDeUmaHora() {
  return new Date(Date.now() + ESPERA_INICIAL_MS)
}

/**
 * Consulta que passou: grava onde chegou e ZERA o contador de recusas.
 *
 * A espera de uma hora que às vezes vem junto não é castigo — é a regra de não
 * perguntar de novo sem ter havido novidade. Confundir as duas faria a próxima
 * recusa começar no degrau errado.
 */
function guardarCursor(loja: string, ultNsu: string, maxNsu: string, proximaConsultaEm: Date | null) {
  const dados = { ultNsu, maxNsu, proximaConsultaEm, recusasSeguidas: 0 }
  return db.sincronizacaoSefaz.upsert({
    where: { loja },
    update: dados,
    create: { loja, ...dados },
  })
}

/** Uma hora dobrando a cada recusa seguida, com teto — 1h, 2h, 4h, 8h. */
const ESPERA_INICIAL_MS = 60 * 60_000
const ESPERA_MAXIMA_MS = 8 * 60 * 60_000

function esperaProgressiva(recusasSeguidas: number) {
  const dobrada = ESPERA_INICIAL_MS * 2 ** Math.max(0, recusasSeguidas - 1)
  return new Date(Date.now() + Math.min(dobrada, ESPERA_MAXIMA_MS))
}

/**
 * Consulta recusada por consumo indevido: adia a próxima na medida do degrau em
 * que se está.
 *
 * O teto de oito horas é deliberado. Sem ele, meia dúzia de cliques impacientes
 * silenciariam a sincronização por dias — e nota de fornecedor que não chega é
 * pior que espera longa, porque ninguém percebe.
 */
async function guardarRecusa(
  loja: string,
  ultNsu: string,
  maxNsu: string,
  recusasSeguidas: number
): Promise<Date> {
  const proximaConsultaEm = esperaProgressiva(recusasSeguidas)
  const dados = { ultNsu, maxNsu, proximaConsultaEm, recusasSeguidas }
  await db.sincronizacaoSefaz.upsert({
    where: { loja },
    update: dados,
    create: { loja, ...dados },
  })
  return proximaConsultaEm
}

/** "45 min", "2 h", "3 h 20 min" — minuto puro fica ilegível a partir de uma hora. */
function emTexto(milissegundos: number) {
  const minutos = Math.max(1, Math.ceil(milissegundos / 60_000))
  if (minutos < 60) return `${minutos} min`
  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60
  return resto ? `${horas} h ${resto} min` : `${horas} h`
}

/**
 * Grava (ou atualiza) uma nota a partir do XML já baixado — usado tanto pela
 * sincronização por NSU quanto pela busca manual por chave, para as duas
 * alimentarem a mesma lista.
 *
 * Nunca sobrescreve `situacao`: é a decisão do gerente sobre a nota, e uma
 * ressincronização não pode apagar o que ele já resolveu.
 */
async function gravarNota(
  loja: string,
  schema: string,
  xml: string,
  nsu: string
): Promise<string | null> {
  const completa = schema.startsWith("procNFe")
  const resumo = completa ? resumoDoProcNFe(xml) : resumoDoResNFe(xml)
  // Chave que não tem 44 dígitos é chave corrompida, não chave estranha: já
  // aconteceu (o parser convertia para número e estourava a precisão) e o
  // estrago foi gravar 49 duplicatas inúteis, porque a chave é a identidade
  // do documento. Melhor recusar do que guardar lixo com aparência de nota.
  if (!resumo?.chaveAcesso || !/^\d{44}$/.test(resumo.chaveAcesso)) return null

  const decodificada = decodificarChave(resumo.chaveAcesso)
  const numero = "numero" in resumo && resumo.numero ? Number(resumo.numero) : decodificada?.numero ?? null
  const serie = "serie" in resumo && resumo.serie ? Number(resumo.serie) : decodificada?.serie ?? null

  const dados = {
    loja,
    // 14 dígitos sempre: CNPJ que começa com zero perdia o zero e virava um
    // segundo "fornecedor" na lista, que nunca casava com o cadastro.
    emitenteCnpj: normalizarCnpj(resumo.emitenteCnpj ?? decodificada?.cnpjEmitente ?? ""),
    emitenteNome: resumo.emitenteNome ?? "",
    numero,
    serie,
    dataEmissao: resumo.dataEmissao ? new Date(resumo.dataEmissao) : null,
    valorTotal: resumo.valorTotal,
    situacaoXml: completa ? "completa" : "resumo",
    xml: completa ? xml : null,
  }

  // O NSU é estável por documento e por interessado: reprocessar a mesma faixa
  // devolve o mesmo número. Por isso a atualização também o grava — é o que
  // conserta, na próxima passada, as notas gravadas com o "0" fixo de antes.
  // Vazio não sobrescreve: melhor um zero antigo do que apagar o que se sabia.
  const comNsu = nsu ? { ...dados, nsu } : dados

  await db.notaFiscalRecebida.upsert({
    where: { chaveAcesso: resumo.chaveAcesso },
    create: { chaveAcesso: resumo.chaveAcesso, nsu: nsu || "0", ...dados },
    update: comNsu,
  })
  return resumo.chaveAcesso
}

/** Se este `schema` de docZip é uma nota — o resto é evento, e evento não entra na lista. */
function ehNota(schema: string) {
  return schema.startsWith("resNFe") || schema.startsWith("procNFe")
}

/**
 * Anota que este NSU foi entregue, seja ele nota ou evento.
 *
 * Idempotente: reprocessar a mesma faixa não duplica nem apaga — o NSU é
 * estável por documento e por interessado.
 */
async function registrarDocumento(
  loja: string,
  nsuBruto: string,
  esquema: string,
  chaveAcesso: string | null
) {
  const nsu = normalizarNsu(nsuBruto)
  // Documento sem NSU não dá para indexar, e inventar um "0" criaria um
  // registro que mente sobre a posição na sequência.
  if (!nsuBruto || Number(nsu) === 0) return

  const dados = { esquema, chaveAcesso, virouNota: chaveAcesso != null }
  await db.documentoDistribuido.upsert({
    where: { loja_nsu: { loja, nsu } },
    create: { loja, nsu, ...dados },
    update: dados,
  })
}

/** CNPJ com 14 dígitos, zeros à esquerda inclusive — o formato do cadastro. */
function normalizarCnpj(valor: string) {
  const digitos = (valor ?? "").replace(/\D/g, "")
  return digitos ? digitos.padStart(14, "0") : ""
}

export function listarNotasDaLoja(loja: string) {
  return db.notaFiscalRecebida.findMany({
    where: { loja },
    orderBy: { dataEmissao: "desc" },
  })
}

export const NOTAS_POR_PAGINA = 40

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * Lê o filtro da URL, no mesmo padrão de `lerFiltroPedidos`.
 *
 * O padrão é "tudo": nota de fornecedor chega às dezenas por mês, e um
 * período curto por padrão esconderia a nota do mês passado que é justamente
 * a que se está procurando.
 */
export function lerFiltroNotas(url: URL): FiltroNotas {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  const temDe = DIA.test(texto("de"))
  const temAte = DIA.test(texto("ate"))
  const de = temDe ? texto("de") : temAte ? texto("ate") : PRIMEIRO_DIA
  const ateBruto = temAte ? texto("ate") : temDe ? texto("de") : ULTIMO_DIA
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const situacao = texto("situacao")

  return {
    loja: texto("loja").slice(0, 10),
    de: inicio,
    ate: fim,
    fornecedor: texto("fornecedor").slice(0, 60),
    numero: texto("numero").replace(/\D/g, "").slice(0, 9),
    situacao: SITUACOES_NOTA.some((s) => s.id === situacao) ? (situacao as SituacaoNota) : "todas",
    pagina: Math.max(1, Math.trunc(Number(params.get("pagina"))) || 1),
  }
}

/**
 * As notas que casam com o filtro, uma página de cada vez.
 *
 * O resumo ignora de propósito o seletor de situação — como em contas a
 * receber e em pedidos, os cartões SÃO a repartição por situação daquele
 * período e daquele fornecedor. Obedecer ao seletor faria os outros serem
 * sempre zero.
 */
export async function consultarNotas(filtro: FiltroNotas) {
  const periodo: Prisma.NotaFiscalRecebidaWhereInput = {
    dataEmissao: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) },
  }
  const conteudo: Prisma.NotaFiscalRecebidaWhereInput[] = [{ loja: filtro.loja }]

  if (filtro.numero) conteudo.push({ numero: Number(filtro.numero) })
  if (filtro.fornecedor) {
    // Um campo só para nome e CNPJ: quem procura tem um ou outro na mão, e
    // dois campos separados obrigariam a saber de antemão qual deles serve.
    const digitos = filtro.fornecedor.replace(/\D/g, "")
    conteudo.push({
      OR: [
        { emitenteNome: { contains: filtro.fornecedor, mode: "insensitive" } },
        ...(digitos.length >= 3 ? [{ emitenteCnpj: { contains: digitos } }] : []),
      ],
    })
  }

  const base: Prisma.NotaFiscalRecebidaWhereInput = { AND: [periodo, ...conteudo] }
  const where: Prisma.NotaFiscalRecebidaWhereInput =
    filtro.situacao === "todas" ? base : { AND: [periodo, ...conteudo, { situacao: filtro.situacao }] }

  const [pagina, total, agregado, disponiveis, recebidas] = await Promise.all([
    db.notaFiscalRecebida.findMany({
      where,
      orderBy: { dataEmissao: "desc" },
      skip: (filtro.pagina - 1) * NOTAS_POR_PAGINA,
      take: NOTAS_POR_PAGINA,
    }),
    db.notaFiscalRecebida.count({ where }),
    db.notaFiscalRecebida.aggregate({ where, _sum: { valorTotal: true } }),
    db.notaFiscalRecebida.aggregate({
      where: { AND: [base, { situacao: "disponivel" }] },
      _sum: { valorTotal: true },
      _count: { _all: true },
    }),
    db.notaFiscalRecebida.aggregate({
      where: { AND: [base, { situacao: "recebida" }] },
      _sum: { valorTotal: true },
      _count: { _all: true },
    }),
  ])

  // Quando a busca não acha nada no período, dizer isso é melhor que uma tela
  // vazia que parece defeito — a mesma escolha já feita nas outras consultas.
  const foraDoPeriodo =
    total === 0 && (filtro.numero || filtro.fornecedor)
      ? await db.notaFiscalRecebida.count({ where: { AND: conteudo } })
      : 0

  return {
    notas: pagina,
    total,
    foraDoPeriodo,
    paginas: Math.max(1, Math.ceil(total / NOTAS_POR_PAGINA)),
    resumo: {
      valor: agregado._sum.valorTotal ?? 0,
      disponivel: disponiveis._sum.valorTotal ?? 0,
      disponivelQuantidade: disponiveis._count._all,
      recebida: recebidas._sum.valorTotal ?? 0,
      recebidaQuantidade: recebidas._count._all,
    },
  }
}

export type NotaDaConsulta = Awaited<ReturnType<typeof consultarNotas>>["notas"][number]

/** Os fornecedores que já mandaram nota para esta loja, para o seletor da tela. */
export async function fornecedoresComNota(loja: string) {
  const notas = await db.notaFiscalRecebida.findMany({
    where: { loja },
    select: { emitenteCnpj: true, emitenteNome: true },
  })

  const porCnpj = new Map<string, { cnpj: string; nome: string; notas: number }>()
  for (const n of notas) {
    const atual = porCnpj.get(n.emitenteCnpj)
    if (atual) atual.notas++
    else porCnpj.set(n.emitenteCnpj, { cnpj: n.emitenteCnpj, nome: n.emitenteNome, notas: 1 })
  }

  return [...porCnpj.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
}

export function situacaoSincronizacao(loja: string) {
  return db.sincronizacaoSefaz.findUnique({ where: { loja } })
}

export function notaPorId(id: string) {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return null
  return db.notaFiscalRecebida.findUnique({ where: { id } })
}

export type ResultadoBuscaChave = ResultadoConsultaChave

/** Busca manual por chave — para a nota que ainda não apareceu na sincronização. */
export async function buscarNotaPorChave(loja: string, chave: string): Promise<ResultadoBuscaChave> {
  const resultado = await consultarChaveNaSefaz(loja, chave)
  if (resultado.ok && resultado.documento) {
    const { schema, xml, nsu } = resultado.documento
    const chaveGravada = await gravarNota(loja, schema, xml, nsu)
    await registrarDocumento(loja, nsu, schema, chaveGravada)
  }
  return resultado
}
