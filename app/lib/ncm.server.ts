import { db } from "~/lib/db.server"

/**
 * A tabela NCM, trazida da fonte federal e guardada aqui.
 *
 * A fonte é o Portal Único Siscomex (Receita/Camex) — não a SEFAZ, que só
 * RECEBE o NCM dentro da NF-e. O arquivo é público, sem credencial, e traz a
 * nomenclatura inteira: capítulos, posições e as ~10,5 mil folhas de 8 dígitos,
 * que são as únicas que a NF-e aceita.
 */

const FONTE = "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json"

type NomenclaturaBruta = {
  Codigo: string
  Descricao: string
  Data_Inicio: string
  Data_Fim: string
}

/**
 * Tira a marcação da fonte e os traços de nível.
 *
 * Mil descrições vêm com HTML de verdade no meio ("1.000 cm<sup>3</sup>",
 * "<i>Gallus domesticus</i>"), e os "--" do começo são profundidade na
 * hierarquia, não parte do texto.
 */
function limpar(texto: string) {
  return texto
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/^[-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
}

const digitos = (codigo: string) => codigo.replace(/\D/g, "")

/** Minúsculas e sem acento — a mesma normalização da busca de produtos. */
function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

/**
 * O caminho até a folha, montado com os ancestrais.
 *
 * Sem isto a tabela é inútil para procurar: a folha 3923.21.90 se chama
 * literalmente "Outros", e o que diz que ela é um saco de polietileno são os
 * níveis acima. A NCM se subdivide em 2, 4, 5, 6, 7 e 8 dígitos.
 */
function caminhoAteAFolha(codigo8: string, porDigitos: Map<string, NomenclaturaBruta>) {
  const partes: string[] = []
  for (const corte of [2, 4, 5, 6, 7, 8]) {
    const nivel = porDigitos.get(codigo8.slice(0, corte))
    if (!nivel) continue
    const texto = limpar(nivel.Descricao)
    // Níveis que repetem o texto do pai só alongariam a linha.
    if (texto && texto !== partes[partes.length - 1]) partes.push(texto)
  }
  return partes.join(" · ")
}

export type ResultadoImportacao =
  | { ok: true; quantidade: number; ato: string; vigencia: string }
  | { ok: false; erro: string }

/**
 * Traz a tabela da fonte e substitui a que está aqui.
 *
 * Substitui inteira em vez de casar linha a linha: a tabela é publicada como um
 * retrato de uma resolução, e um merge deixaria vivo um código que a resolução
 * nova extinguiu — que é justamente o que faria a NF-e ser rejeitada.
 */
export async function importarTabelaNcm(operador: string): Promise<ResultadoImportacao> {
  let bruto: { Nomenclaturas?: NomenclaturaBruta[]; Ato?: string; Data_Ultima_Atualizacao_NCM?: string }

  try {
    const resposta = await fetch(FONTE, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(90_000),
    })
    if (!resposta.ok) {
      return { ok: false, erro: `A fonte respondeu ${resposta.status}. Tente de novo mais tarde.` }
    }
    bruto = await resposta.json()
  } catch (erro) {
    return {
      ok: false,
      erro:
        erro instanceof Error && erro.name === "TimeoutError"
          ? "A fonte demorou demais para responder"
          : "Não foi possível falar com o Portal Único Siscomex",
    }
  }

  const lista = bruto.Nomenclaturas
  if (!Array.isArray(lista) || lista.length === 0) {
    return { ok: false, erro: "A fonte devolveu uma tabela vazia" }
  }

  const porDigitos = new Map<string, NomenclaturaBruta>()
  for (const linha of lista) porDigitos.set(digitos(linha.Codigo), linha)

  const hoje = new Date()
  const linhas = lista
    .filter((n) => digitos(n.Codigo).length === 8)
    // Código já encerrado não pode ser oferecido: a NF-e emitida com ele é
    // recusada, e o erro só apareceria na emissão.
    .filter((n) => aindaVigente(n.Data_Fim, hoje))
    .map((n) => {
      const codigo = digitos(n.Codigo)
      const caminho = caminhoAteAFolha(codigo, porDigitos)
      return {
        codigo,
        formatado: n.Codigo,
        descricao: limpar(n.Descricao),
        caminho,
        busca: normalizar(caminho),
      }
    })

  if (linhas.length === 0) return { ok: false, erro: "Nenhum NCM de 8 dígitos na tabela" }

  const ato = bruto.Ato ?? "não informado"
  const vigencia = bruto.Data_Ultima_Atualizacao_NCM ?? "não informada"

  await db.ncm.deleteMany({})
  // Em blocos: dez mil documentos num createMany só estoura o limite do driver.
  for (let i = 0; i < linhas.length; i += 1000) {
    await db.ncm.createMany({ data: linhas.slice(i, i + 1000) })
  }

  await db.importacaoNcm.deleteMany({})
  await db.importacaoNcm.create({
    data: { importadoPor: operador, ato, vigencia, quantidade: linhas.length },
  })

  return { ok: true, quantidade: linhas.length, ato, vigencia }
}

/** "31/12/9999" é o jeito da fonte dizer "sem fim". */
function aindaVigente(dataFim: string, hoje: Date) {
  const [dia, mes, ano] = (dataFim ?? "").split("/").map(Number)
  if (!dia || !mes || !ano) return true
  return new Date(ano, mes - 1, dia, 23, 59, 59) >= hoje
}

export async function situacaoDaTabelaNcm() {
  const [ultima, quantos] = await Promise.all([
    db.importacaoNcm.findFirst({ orderBy: { importadoEm: "desc" } }),
    db.ncm.count(),
  ])
  return { ultima, quantos }
}

export type NcmEncontrado = {
  codigo: string
  formatado: string
  descricao: string
  caminho: string
  /** Quantos produtos do catálogo já usam este código. */
  usos: number
}

/**
 * Procura por código ou por texto do caminho.
 *
 * Sem termo, devolve os que o catálogo JÁ usa — como a lista de fornecedores,
 * ordenada por atividade e não por ordem alfabética. Hoje três códigos cobrem
 * os mil e cem produtos da rede, então na maioria das vezes a resposta certa
 * está aí antes de alguém digitar qualquer coisa.
 */
export async function buscarNcm(termo: string, limite = 12): Promise<NcmEncontrado[]> {
  const limpo = termo.trim()
  const usos = await usosPorNcm()

  if (!limpo) {
    if (usos.size === 0) return []
    const jaUsados = await db.ncm.findMany({ where: { codigo: { in: [...usos.keys()] } } })
    return jaUsados
      .map((n) => ({ ...semId(n), usos: usos.get(n.codigo) ?? 0 }))
      .sort((a, b) => b.usos - a.usos)
      .slice(0, limite)
  }

  const soDigitos = limpo.replace(/\D/g, "")
  // Digitou número: é o próprio código que se procura, do começo.
  const buscandoCodigo =
    soDigitos.length >= 2 && soDigitos.length === limpo.replace(/[.\s]/g, "").length

  /*
   * Busca por texto traz mais que o limite de propósito, para a ordenação
   * abaixo poder escolher — cortar antes de ordenar deixaria de fora justamente
   * o código que a rede já usa.
   */
  const achados = await db.ncm.findMany({
    where: buscandoCodigo
      ? { codigo: { startsWith: soDigitos } }
      : // Todas as palavras, como na busca de produtos: "copo" sozinho casaria
        // "escopolamina" por dentro da palavra, e é digitando a segunda palavra
        // que quem procura estreita o resultado.
        {
          AND: palavras(normalizar(limpo)).map((palavra) => ({
            busca: { contains: palavra },
          })),
        },
    take: buscandoCodigo ? limite : 200,
    orderBy: { codigo: "asc" },
  })

  const comUsos = achados.map((n) => ({ ...semId(n), usos: usos.get(n.codigo) ?? 0 }))
  if (buscandoCodigo) return comUsos

  /*
   * O que a rede já usa vem primeiro.
   *
   * Procurar "polímeros de etileno" casa tanto o polímero cru (3901) quanto o
   * saco pronto (3923.21), e por código o cru vem antes — mas quem cadastra
   * aqui vende saco. O que já está no catálogo é o melhor palpite que existe.
   */
  return comUsos.sort((a, b) => b.usos - a.usos || a.codigo.localeCompare(b.codigo)).slice(0, limite)
}

/**
 * As palavras que valem para procurar.
 *
 * "de", "ou", "e" aparecem em quase toda linha da nomenclatura — exigi-las não
 * estreita nada e só faz "caixa de papel" achar menos que "caixa papel".
 */
const LIGACAO = new Set(["de", "da", "do", "das", "dos", "e", "ou", "em", "a", "o", "para", "com"])

function palavras(termo: string) {
  const todas = termo.split(/\s+/).filter(Boolean)
  const uteis = todas.filter((p) => p.length > 1 && !LIGACAO.has(p.toLowerCase()))
  // Se sobrou nada (alguém digitou só "de"), volta ao que foi digitado.
  return uteis.length > 0 ? uteis : todas
}

function semId(n: { codigo: string; formatado: string; descricao: string; caminho: string }) {
  return { codigo: n.codigo, formatado: n.formatado, descricao: n.descricao, caminho: n.caminho }
}

/** Quantos produtos usam cada NCM — some em JS porque `groupBy` derruba o engine no Mongo. */
async function usosPorNcm() {
  const produtos = await db.produto.findMany({
    where: { ncm: { not: null } },
    select: { ncm: true },
  })
  const mapa = new Map<string, number>()
  for (const p of produtos) {
    if (!p.ncm) continue
    mapa.set(p.ncm, (mapa.get(p.ncm) ?? 0) + 1)
  }
  return mapa
}
