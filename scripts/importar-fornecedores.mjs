/**
 * Importa o cadastro de fornecedores do sistema antigo.
 *
 *   node scripts/importar-fornecedores.mjs dados/fornecedores.csv          # ensaio
 *   node scripts/importar-fornecedores.mjs dados/fornecedores.csv --gravar # grava
 *
 * Quatro decisões que valem explicação:
 *
 * 1. **A chave é o código, não o documento.** Onze cadastros vieram com o
 *    placeholder `000.000.000-00`, e o CNPJ 36.770.055/0001-28 aparece em dois
 *    códigos (um cadastro antigo e o atual da mesma empresa). Casar por
 *    documento juntaria empresas diferentes e recusaria doze cadastros reais.
 *
 * 2. **Placeholder não vira documento.** `000.000.000-00` entra como ausente.
 *    Gravá-lo seria guardar uma mentira com cara de CNPJ — e um dia alguém
 *    emitiria alguma coisa com ela.
 *
 * 3. **Nome fantasia é opcional.** Metade dos cadastros não tem, e a razão
 *    social deles é reconhecível ("KNAUF ISOPOR", "TRIPACK FILMES"). Copiar a
 *    razão para o campo fantasia encheria a tela de texto repetido.
 *
 * 4. **Atualiza quem já existe, em vez de duplicar.** Rodar duas vezes deixa o
 *    banco no mesmo estado. O que foi editado à mão na tela é sobrescrito pelo
 *    arquivo: quem roda a importação está dizendo que o arquivo é a verdade.
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
  console.error("uso: node scripts/importar-fornecedores.mjs <arquivo.csv> [--gravar]")
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

const soDigitos = (s) => (s ?? "").replace(/\D/g, "")

/** Os mesmos dígitos verificadores de app/lib/documento.ts. */
function validarCpf(c) {
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false
  for (const n of [9, 10]) {
    let soma = 0
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i)
    if (((soma * 10) % 11) % 10 !== Number(c[n])) return false
  }
  return true
}
function validarCnpj(c) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false
  const base = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  for (const n of [12, 13]) {
    const pesos = base.slice(base.length - n)
    let soma = 0
    for (let i = 0; i < n; i++) soma += Number(c[i]) * pesos[i]
    const resto = soma % 11
    if ((resto < 2 ? 0 : 11 - resto) !== Number(c[n])) return false
  }
  return true
}

/** "24/08/2026" → Date, ou null. */
function data(bruto) {
  const [d, m, a] = (bruto ?? "").split("/").map(Number)
  if (!d || !m || !a) return null
  return new Date(Date.UTC(a, m - 1, d))
}

const linhas = readFileSync(arquivo, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")
const cabecalho = campos(linhas[0])

const COL = {
  codigo: cabecalho.findIndex((c) => c.includes("Código")),
  razao: cabecalho.findIndex((c) => c.includes("Razão")),
  fantasia: cabecalho.findIndex((c) => c.includes("Fantasia")),
  cidade: cabecalho.indexOf("Cidade"),
  bairro: cabecalho.indexOf("Bairro"),
  documento: cabecalho.findIndex((c) => c.includes("CNPJ")),
  ultimaCompra: cabecalho.findIndex((c) => c.includes("Ult. Compra")),
}
for (const [nome, indice] of Object.entries(COL)) {
  if (indice < 0) {
    console.error(`coluna "${nome}" não encontrada — o layout mudou?`)
    console.error(`  cabeçalho lido: ${cabecalho.join(" | ")}`)
    process.exit(1)
  }
}

const registros = []
const semDocumento = []
const documentoInvalido = []
const codigosVistos = new Map()
const codigosRepetidos = []

for (const linha of linhas.slice(1)) {
  const c = campos(linha)
  if (c.length < cabecalho.length) continue

  const codigo = c[COL.codigo].trim()
  if (!codigo) continue
  if (codigosVistos.has(codigo)) {
    codigosRepetidos.push(codigo)
    continue
  }

  const razaoSocial = c[COL.razao].trim()
  const fantasia = c[COL.fantasia].trim()
  const bruto = c[COL.documento].trim()
  const digitos = soDigitos(bruto)

  let documento = null
  let tipoPessoa = null
  if (digitos.length === 11 && validarCpf(digitos)) {
    documento = digitos
    tipoPessoa = "FISICA"
  } else if (digitos.length === 14 && validarCnpj(digitos)) {
    documento = digitos
    tipoPessoa = "JURIDICA"
  } else if (!bruto || /^0+$/.test(digitos)) {
    // Placeholder do sistema antigo: ausente é mais honesto que zeros.
    semDocumento.push({ codigo, nome: fantasia || razaoSocial })
  } else {
    documentoInvalido.push({ codigo, nome: fantasia || razaoSocial, bruto })
  }

  registros.push({
    codigo,
    razaoSocial,
    // Só guarda a fantasia quando ela acrescenta alguma coisa.
    nomeFantasia: fantasia && fantasia !== razaoSocial ? fantasia : null,
    cidade: c[COL.cidade].trim(),
    bairro: c[COL.bairro].trim(),
    documento,
    tipoPessoa,
    ultimaCompra: data(c[COL.ultimaCompra]),
  })

  codigosVistos.set(codigo, true)
}

const comCompra = registros.filter((r) => r.ultimaCompra)
console.log(`arquivo: ${arquivo}`)
console.log()
console.log(`  fornecedores lidos ......... ${registros.length}`)
console.log(`  com documento válido ....... ${registros.filter((r) => r.documento).length}`)
console.log(`  sem documento (placeholder). ${semDocumento.length}`)
console.log(`  documento inválido ......... ${documentoInvalido.length}`)
console.log(`  com nome fantasia próprio .. ${registros.filter((r) => r.nomeFantasia).length}`)
console.log(`  já compraram alguma vez .... ${comCompra.length}`)
console.log(`  nunca compraram ............ ${registros.length - comCompra.length}`)
if (codigosRepetidos.length) {
  console.log(`  códigos repetidos (ignorados): ${codigosRepetidos.join(", ")}`)
}

if (documentoInvalido.length) {
  console.log()
  console.log("documento não confere (entra sem documento):")
  for (const d of documentoInvalido) console.log(`  ${d.codigo}  ${d.bruto}  ${d.nome}`)
}

if (semDocumento.length) {
  console.log()
  console.log(`sem CNPJ no cadastro antigo — precisam ser completados à mão:`)
  for (const d of semDocumento) console.log(`  ${d.codigo}  ${d.nome}`)
}

if (!gravar) {
  console.log()
  console.log("ENSAIO — nada gravado. Use --gravar para aplicar.")
  process.exit(0)
}

const db = new PrismaClient()

// O índice único do código, garantido antes de gravar — mesma escolha do script
// de política de compra: createIndexes toca só esta coleção, e é idempotente.
await db.$runCommandRaw({
  createIndexes: "fornecedores",
  indexes: [{ key: { codigo: 1 }, name: "codigo_1", unique: true }],
})

let criados = 0
let atualizados = 0
for (const r of registros) {
  const existente = await db.fornecedor.findUnique({ where: { codigo: r.codigo } })
  if (existente) {
    await db.fornecedor.update({ where: { codigo: r.codigo }, data: r })
    atualizados++
  } else {
    await db.fornecedor.create({ data: r })
    criados++
  }
}

console.log()
console.log(`GRAVADO: ${criados} criados, ${atualizados} atualizados.`)
await db.$disconnect()
