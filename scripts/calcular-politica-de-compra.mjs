/**
 * Calcula ponto de pedido, estoque mínimo e lote de compra a partir do histórico
 * de faturamento do sistema antigo.
 *
 *   node scripts/calcular-politica-de-compra.mjs "dados/ano 2026.csv"          # ensaio
 *   node scripts/calcular-politica-de-compra.mjs "dados/ano 2026.csv" --gravar # grava
 *
 * Os arquivos ficam em /dados, fora de /public: são faturamento com razão social
 * e CNPJ de cliente, e tudo em /public o servidor entrega a quem pedir pela URL.
 *
 * Quatro decisões que valem explicação:
 *
 * 1. **Transferência não é venda.** A matriz fatura para a filial, a Plastibra e
 *    a Sacobras, e essas notas estão no relatório junto com as reais. Contá-las
 *    dobraria o consumo da rede: a mercadoria seria contada quando sai da matriz
 *    e de novo quando a loja vende ao cliente final. São reconhecidas pelo nome
 *    do cliente ser uma das empresas do grupo.
 *
 * 2. **O consumo é da REDE somada.** A compra é central — é justamente por isso
 *    que existem as transferências do item 1. Um ponto de pedido por loja
 *    responderia "quando repor a prateleira", que é outra pergunta.
 *
 * 3. **O período sai do arquivo, não do calendário.** Os dias são contados entre
 *    a primeira e a última data presentes. Dividir por "30" um arquivo de 24
 *    dias inflaria a média em 25% sem ninguém perceber.
 *
 * 4. **Nota cancelada não conta**, e produto que não casa com o catálogo é
 *    reportado em vez de ignorado em silêncio — é assim que se descobre um
 *    cadastro faltando.
 */
import { readFileSync } from "node:fs"
import { PrismaClient } from "@prisma/client"

for (const linha of readFileSync(".env", "utf8").split("\n")) {
  const i = linha.indexOf("=")
  if (i < 1 || linha.trim().startsWith("#")) continue
  const chave = linha.slice(0, i).trim()
  if (process.env[chave] === undefined) {
    process.env[chave] = linha.slice(i + 1).trim().replace(/^["']|["']$/g, "")
  }
}

const [arquivo, ...opcoes] = process.argv.slice(2)
if (!arquivo) {
  console.error("uso: node scripts/calcular-politica-de-compra.mjs <arquivo.csv> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")

/** Os mesmos parâmetros de app/lib/compras.ts — o script não pode divergir da tela. */
const DIAS_DE_ENTREGA = 15
const DIAS_DE_COBERTURA = 30
const DIAS_DE_SEGURANCA = 7

/**
 * As empresas do próprio grupo. Nota emitida para elas é remessa, não venda.
 *
 * Comparado por trecho e sem acento porque a razão social vem grafada de formas
 * diferentes no cadastro do cliente ("BRASSACO EMBALAGENS LTDA - FILIAL",
 * "BRASSACO EMBALAGENS LTDA FILIAL").
 */
const EMPRESAS_DO_GRUPO = ["PLASTIBRA", "SACOBRAS", "BRASSACO"]

function ehTransferencia(cliente) {
  const limpo = cliente
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
  return EMPRESAS_DO_GRUPO.some((empresa) => limpo.includes(empresa))
}

/** "2.985" → "2985". O relatório põe separador de milhar em código de produto. */
function normalizarCodigo(bruto) {
  return bruto.replace(/\./g, "").trim()
}

/** "1.234,500" → 1234.5 */
function numero(bruto) {
  const limpo = bruto.replace(/\./g, "").replace(",", ".").trim()
  const valor = Number(limpo)
  return Number.isFinite(valor) ? valor : 0
}

/** "24/08/2026" → Date. Sem fuso: só a data importa para contar dias. */
function data(bruto) {
  const [d, m, a] = bruto.split("/").map(Number)
  if (!d || !m || !a) return null
  return new Date(Date.UTC(a, m - 1, d))
}

/** CSV com aspas e ponto-e-vírgula, campo a campo — sem depender de biblioteca. */
function campos(linha) {
  const saida = []
  let atual = ""
  let dentroDeAspas = false
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]
    if (c === '"') {
      // Aspas duplicadas dentro do campo são um literal, não o fim dele.
      if (dentroDeAspas && linha[i + 1] === '"') {
        atual += '"'
        i++
      } else dentroDeAspas = !dentroDeAspas
    } else if (c === ";" && !dentroDeAspas) {
      saida.push(atual)
      atual = ""
    } else atual += c
  }
  saida.push(atual)
  return saida
}

const texto = readFileSync(arquivo, "utf8")
const linhas = texto.split(/\r?\n/).filter((l) => l.trim() !== "")
const cabecalho = campos(linhas[0])

const COL = {
  codigo: cabecalho.findIndex((c) => c.includes("Código Prd")),
  descricao: cabecalho.findIndex((c) => c.includes("Descrição Prod")),
  unidade: cabecalho.indexOf("Unidade"),
  quantidade: cabecalho.indexOf("Quantidade"),
  valor: cabecalho.includes("Valor total") ? cabecalho.indexOf("Valor total") : -1,
  data: cabecalho.findIndex((c) => c.includes("Data da venda")),
  cliente: cabecalho.indexOf("Cliente"),
  status: cabecalho.indexOf("Status"),
}

for (const [nome, indice] of Object.entries(COL)) {
  if (indice < 0) {
    console.error(`coluna "${nome}" não encontrada no cabeçalho — o layout mudou?`)
    console.error(`  cabeçalho lido: ${cabecalho.join(" | ")}`)
    process.exit(1)
  }
}

const db = new PrismaClient()
const produtos = await db.produto.findMany({ where: { ativo: true } })

const porCodigo = new Map()
for (const p of produtos) {
  if (!porCodigo.has(p.codigo)) porCodigo.set(p.codigo, [])
  porCodigo.get(p.codigo).push(p)
}

/** produtoId → { vendido, dias com venda, valor } */
const consumo = new Map()
const semPar = new Map()
let transferencias = 0
let valorTransferido = 0
let canceladas = 0
let reais = 0
let valorReal = 0
let primeiraData = null
let ultimaData = null

for (const linha of linhas.slice(1)) {
  const c = campos(linha)
  if (c.length < cabecalho.length) continue

  const quando = data(c[COL.data])
  if (quando) {
    if (!primeiraData || quando < primeiraData) primeiraData = quando
    if (!ultimaData || quando > ultimaData) ultimaData = quando
  }

  const status = c[COL.status].trim().toUpperCase()
  if (status.includes("CANCEL")) {
    canceladas++
    continue
  }

  const valor = numero(c[COL.valor])

  if (ehTransferencia(c[COL.cliente])) {
    transferencias++
    valorTransferido += valor
    continue
  }

  reais++
  valorReal += valor

  const codigo = normalizarCodigo(c[COL.codigo])
  const unidade = c[COL.unidade].trim()
  const quantidade = numero(c[COL.quantidade])
  if (quantidade <= 0) continue

  const candidatos = porCodigo.get(codigo) ?? []
  // O mesmo código existe em unidades diferentes (PC e CX); a unidade desempata.
  const produto =
    candidatos.length === 1
      ? candidatos[0]
      : candidatos.find((p) => p.unidade.toUpperCase() === unidade.toUpperCase())

  if (!produto) {
    const chave = `${codigo} ${unidade}`
    if (!semPar.has(chave)) {
      semPar.set(chave, { descricao: c[COL.descricao], linhas: 0, quantidade: 0 })
    }
    const registro = semPar.get(chave)
    registro.linhas++
    registro.quantidade += quantidade
    continue
  }

  if (!consumo.has(produto.id)) {
    consumo.set(produto.id, {
      produto,
      vendido: 0,
      valor: 0,
      dias: new Set(),
    })
  }
  const registro = consumo.get(produto.id)
  registro.vendido += quantidade
  registro.valor += valor
  if (quando) registro.dias.add(quando.toISOString().slice(0, 10))
}

const DIA = 24 * 60 * 60 * 1000
// +1 porque o intervalo é inclusivo: 01/08 a 24/08 são 24 dias, não 23.
const diasDoPeriodo =
  primeiraData && ultimaData
    ? Math.round((ultimaData - primeiraData) / DIA) + 1
    : 0

if (diasDoPeriodo < 1) {
  console.error("não consegui determinar o período — nenhuma data válida no arquivo")
  process.exit(1)
}

const formatarData = (d) => d.toISOString().slice(0, 10).split("-").reverse().join("/")
const reais2 = (v) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

console.log(`arquivo: ${arquivo}`)
console.log(`período: ${formatarData(primeiraData)} a ${formatarData(ultimaData)} — ${diasDoPeriodo} dias`)
console.log()
console.log(`  linhas lidas ............. ${linhas.length - 1}`)
console.log(`  canceladas ............... ${canceladas}`)
console.log(`  transferências (fora) .... ${transferencias}  R$ ${reais2(valorTransferido)}`)
console.log(`  vendas reais ............. ${reais}  R$ ${reais2(valorReal)}`)
console.log(`  produtos com consumo ..... ${consumo.size}`)
console.log(`  sem par no catálogo ...... ${semPar.size}`)

if (diasDoPeriodo < 90) {
  console.log()
  console.log(`  ⚠ ${diasDoPeriodo} dias é pouco para média confiável.`)
  console.log(`    Produto de giro lento vira sorteio, e sazonalidade não aparece.`)
}

if (semPar.size > 0) {
  console.log()
  console.log("produtos vendidos que não estão no catálogo:")
  const ordenados = [...semPar.entries()].sort((a, b) => b[1].quantidade - a[1].quantidade)
  for (const [chave, r] of ordenados.slice(0, 20)) {
    console.log(`  ${chave.padEnd(14)} ${r.descricao.slice(0, 44).padEnd(44)} ${r.linhas} nota(s), ${r.quantidade}`)
  }
  if (ordenados.length > 20) console.log(`  ... e mais ${ordenados.length - 20}`)
}

// Os dez maiores, para conferir de olho antes de gravar.
const calculadas = [...consumo.values()].map((r) => {
  const cmd = r.vendido / diasDoPeriodo
  return {
    ...r,
    consumoMedioDiario: cmd,
    estoqueMinimo: Math.ceil(cmd * DIAS_DE_SEGURANCA),
    pontoDePedido: Math.ceil(cmd * (DIAS_DE_ENTREGA + DIAS_DE_SEGURANCA)),
    loteDeCompra: Math.ceil(cmd * (DIAS_DE_COBERTURA + DIAS_DE_ENTREGA + DIAS_DE_SEGURANCA)),
  }
})
calculadas.sort((a, b) => b.vendido - a.vendido)

console.log()
console.log("os dez de maior giro:")
console.log(`  ${"código".padEnd(8)} ${"produto".padEnd(38)} ${"vendido".padStart(9)} ${"por dia".padStart(8)} ${"mínimo".padStart(7)} ${"pedir em".padStart(9)} ${"lote".padStart(7)}`)
for (const r of calculadas.slice(0, 10)) {
  console.log(
    `  ${r.produto.codigo.padEnd(8)} ${r.produto.descricao.slice(0, 38).padEnd(38)} ` +
      `${r.vendido.toFixed(0).padStart(9)} ${r.consumoMedioDiario.toFixed(1).padStart(8)} ` +
      `${String(r.estoqueMinimo).padStart(7)} ${String(r.pontoDePedido).padStart(9)} ${String(r.loteDeCompra).padStart(7)}`
  )
}

if (!gravar) {
  console.log()
  console.log("ENSAIO — nada gravado. Use --gravar para aplicar.")
  await db.$disconnect()
  process.exit(0)
}

/**
 * O índice único de produtoId, garantido antes de gravar.
 *
 * Fica aqui, e não num `prisma db push`, porque o push sincroniza os índices do
 * banco INTEIRO: num banco em produção com quinze coleções, ele é uma operação
 * ampla para conseguir uma coisa estreita. `createIndexes` toca só esta coleção
 * (e a cria, se ainda não existir), e é idempotente — rodar de novo não faz nada.
 *
 * Sem o índice, dois upserts simultâneos do mesmo produto criariam duas
 * políticas, e a tela passaria a mostrar o produto duas vezes com números
 * diferentes, sem nada indicando qual está certo.
 */
await db.$runCommandRaw({
  createIndexes: "politicas_de_compra",
  indexes: [{ key: { produtoId: 1 }, name: "produtoId_1", unique: true }],
})

const calculadoEm = new Date()
let gravadas = 0
for (const r of calculadas) {
  const dados = {
    consumoMedioDiario: r.consumoMedioDiario,
    estoqueMinimo: r.estoqueMinimo,
    pontoDePedido: r.pontoDePedido,
    loteDeCompra: r.loteDeCompra,
    calculadoEm,
    diasAnalisados: diasDoPeriodo,
    diasComVenda: r.dias.size,
    vendidoNoPeriodo: r.vendido,
  }
  await db.politicaDeCompra.upsert({
    where: { produtoId: r.produto.id },
    create: { produtoId: r.produto.id, ...dados },
    update: dados,
  })
  gravadas++
}

// Recálculo inteiro: quem saiu do histórico perde a política junto, senão um
// produto que parou de vender guarda para sempre o consumo do período antigo.
const fora = await db.politicaDeCompra.deleteMany({
  where: { produtoId: { notIn: calculadas.map((r) => r.produto.id) } },
})

console.log()
console.log(`GRAVADO: ${gravadas} políticas, ${fora.count} obsoletas removidas.`)
await db.$disconnect()
