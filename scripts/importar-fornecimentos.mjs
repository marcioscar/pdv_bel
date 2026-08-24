/**
 * Liga produto a fornecedor a partir do histórico de compras.
 *
 *   node scripts/importar-fornecimentos.mjs dados/produtos_fornecedores.csv          # ensaio
 *   node scripts/importar-fornecimentos.mjs dados/produtos_fornecedores.csv --gravar
 *
 * Quatro decisões que valem explicação:
 *
 * 1. **O principal é quem forneceu por último.** Um produto pode ter quatro
 *    fornecedores, e alguém precisa ser o padrão do pedido. "O último" ganha de
 *    "o mais barato" porque preço velho não é preço: o mais barato de 2024 pode
 *    ter reajustado, e o último é o único de quem se sabe que ainda vende. Os
 *    outros continuam guardados — é o que serve para negociar.
 *
 * 2. **O custo é o da última compra, não a média.** Média de dois anos e meio
 *    ignora reajuste, e o pedido sairia com um número que ninguém vai cobrar.
 *
 * 3. **O código do fornecedor vem colado ao nome** ("10001-WIDA"), sem os zeros
 *    à esquerda que o cadastro usa ("010001"). Casado sem os zeros dos dois
 *    lados — com eles, nenhum dos 58 encontraria par.
 *
 * 4. **Recalcula tudo.** Fornecimento é derivado: produto que sumiu do histórico
 *    perde o vínculo, senão fica para sempre apontando para um fornecedor que
 *    não o vende mais.
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
  console.error("uso: node scripts/importar-fornecimentos.mjs <arquivo.csv> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")

function campos(linha) {
  const saida = []
  let atual = ""
  let dentroDeAspas = false
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]
    if (c === '"') {
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

const numero = (bruto) => {
  const limpo = (bruto ?? "").replace(/\./g, "").replace(",", ".").trim()
  const valor = Number(limpo)
  return Number.isFinite(valor) ? valor : 0
}
const data = (bruto) => {
  const [d, m, a] = (bruto ?? "").split("/").map(Number)
  if (!d || !m || !a) return null
  return new Date(Date.UTC(a, m - 1, d))
}

const linhas = readFileSync(arquivo, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")
const cabecalho = campos(linhas[0]).map((c) => c.trim())

const COL = {
  fornecedor: cabecalho.findIndex((c) => c.startsWith("Fornecedor")),
  data: cabecalho.indexOf("Data"),
  codigo: cabecalho.findIndex((c) => c.startsWith("Cód")),
  unidade: cabecalho.indexOf("Unidade"),
  quantidade: cabecalho.indexOf("Quantidade"),
  custo: cabecalho.findIndex((c) => c.startsWith("Vr.Unit")),
}
for (const [nome, indice] of Object.entries(COL)) {
  if (indice < 0) {
    console.error(`coluna "${nome}" não encontrada — o layout mudou?`)
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

const fornecedores = await db.fornecedor.findMany()
// Sem zeros à esquerda dos dois lados: o cadastro usa "010001", o histórico
// escreve "10001-WIDA". Com os zeros, nenhum dos 58 casaria.
const porCodigoForn = new Map(fornecedores.map((f) => [f.codigo.replace(/^0+/, ""), f]))

/** chave "produtoId|fornecedorId" → acumulado */
const vinculos = new Map()
const produtosSemPar = new Set()
const fornecedoresSemPar = new Set()
let linhasUsadas = 0

for (const linha of linhas.slice(1)) {
  const c = campos(linha)
  if (c.length < cabecalho.length) continue

  const [codForn] = c[COL.fornecedor].split("-")
  const fornecedor = porCodigoForn.get(codForn.trim().replace(/^0+/, ""))
  if (!fornecedor) {
    fornecedoresSemPar.add(c[COL.fornecedor].trim())
    continue
  }

  const codigo = c[COL.codigo].replace(/\./g, "").trim()
  const unidade = c[COL.unidade].trim()
  const candidatos = porCodigo.get(codigo) ?? []
  const produto =
    candidatos.length === 1
      ? candidatos[0]
      : candidatos.find((p) => p.unidade.toUpperCase() === unidade.toUpperCase())
  if (!produto) {
    produtosSemPar.add(`${codigo} ${unidade}`)
    continue
  }

  const quando = data(c[COL.data])
  const custo = numero(c[COL.custo])
  const quantidade = numero(c[COL.quantidade])
  linhasUsadas++

  const chave = `${produto.id}|${fornecedor.id}`
  if (!vinculos.has(chave)) {
    vinculos.set(chave, {
      produtoId: produto.id,
      fornecedorId: fornecedor.id,
      ultimoCusto: 0,
      ultimaCompra: null,
      quantidadeTotal: 0,
      compras: 0,
      principal: false,
    })
  }
  const v = vinculos.get(chave)
  v.quantidadeTotal += quantidade
  v.compras++
  // O custo acompanha a data: a linha mais recente é que manda, e as linhas não
  // vêm ordenadas.
  if (quando && (!v.ultimaCompra || quando >= v.ultimaCompra)) {
    v.ultimaCompra = quando
    if (custo > 0) v.ultimoCusto = custo
  }
}

// Sem data não dá para saber se é o mais recente, e sem custo não serve ao
// pedido. Fora dos dois casos o vínculo seria um registro que ninguém pode usar.
for (const [chave, v] of vinculos) {
  if (!v.ultimaCompra || v.ultimoCusto <= 0) vinculos.delete(chave)
}

/** O principal de cada produto: o fornecimento mais recente. */
const porProduto = new Map()
for (const v of vinculos.values()) {
  if (!porProduto.has(v.produtoId)) porProduto.set(v.produtoId, [])
  porProduto.get(v.produtoId).push(v)
}
for (const lista of porProduto.values()) {
  lista.sort((a, b) => b.ultimaCompra - a.ultimaCompra || b.quantidadeTotal - a.quantidadeTotal)
  lista[0].principal = true
}

const politicas = await db.politicaDeCompra.findMany({ select: { produtoId: true } })
const comPolitica = new Set(politicas.map((p) => p.produtoId))
const cobertos = [...porProduto.keys()].filter((id) => comPolitica.has(id))

const varios = [...porProduto.values()].filter((l) => l.length > 1)

console.log(`arquivo: ${arquivo}`)
console.log()
console.log(`  linhas de compra lidas ....... ${linhas.length - 1}`)
console.log(`  aproveitadas ................. ${linhasUsadas}`)
console.log(`  vínculos produto×fornecedor .. ${vinculos.size}`)
console.log(`  produtos com fornecedor ...... ${porProduto.size}`)
console.log(`  com mais de um fornecedor .... ${varios.length}`)
console.log(`  produtos do catálogo sem par . ${produtosSemPar.size}`)
console.log(`  fornecedores sem cadastro .... ${fornecedoresSemPar.size}`)
console.log()
console.log(`  dos ${comPolitica.size} produtos com política de compra:`)
console.log(`    ganham fornecedor e custo .. ${cobertos.length}`)
console.log(`    ficam sem .................. ${comPolitica.size - cobertos.length}`)

if (fornecedoresSemPar.size) {
  console.log()
  console.log("fornecedores do histórico sem cadastro:")
  for (const f of fornecedoresSemPar) console.log(`  ${f}`)
}

if (varios.length) {
  console.log()
  console.log("exemplos com mais de um fornecedor (→ é o principal):")
  const nomes = new Map(fornecedores.map((f) => [f.id, f.nomeFantasia || f.razaoSocial]))
  const desc = new Map(produtos.map((p) => [p.id, p.descricao]))
  for (const lista of varios.slice(0, 5)) {
    console.log(`  ${desc.get(lista[0].produtoId)}`)
    for (const v of lista) {
      const d = v.ultimaCompra.toISOString().slice(0, 10).split("-").reverse().join("/")
      console.log(
        `    ${v.principal ? "→" : " "} ${(nomes.get(v.fornecedorId) ?? "").slice(0, 26).padEnd(26)}` +
          ` R$ ${v.ultimoCusto.toFixed(2).padStart(9)}  última ${d}  ${v.compras}x`
      )
    }
  }
}

if (!gravar) {
  console.log()
  console.log("ENSAIO — nada gravado. Use --gravar para aplicar.")
  await db.$disconnect()
  process.exit(0)
}

await db.$runCommandRaw({
  createIndexes: "fornecimentos",
  indexes: [
    { key: { produtoId: 1, fornecedorId: 1 }, name: "produtoId_1_fornecedorId_1", unique: true },
    { key: { fornecedorId: 1 }, name: "fornecedorId_1" },
    { key: { produtoId: 1, principal: 1 }, name: "produtoId_1_principal_1" },
  ],
})

// Recalcula: o vínculo é derivado, e o que saiu do histórico tem que sair daqui.
const apagados = await db.fornecimento.deleteMany({})

let gravados = 0
for (const v of vinculos.values()) {
  await db.fornecimento.create({ data: v })
  gravados++
}

console.log()
console.log(`GRAVADO: ${gravados} vínculos (${apagados.count} anteriores substituídos).`)
await db.$disconnect()
