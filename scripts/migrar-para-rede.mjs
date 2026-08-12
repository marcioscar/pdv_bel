/**
 * Migra o banco de loja única para rede de quatro lojas.
 *
 *   node scripts/migrar-para-rede.mjs            # ensaio
 *   node scripts/migrar-para-rede.mjs --gravar
 *
 * O que faz:
 *  - cadastra as 3 contas do Inter e as 4 lojas
 *  - dá `loja` aos documentos que já existem (vendas, movimentos, cobranças)
 *  - dá `lojas: []` (rede toda) aos usuários que já existem
 *  - renomeia o contador "venda" para "venda:<loja>"
 *  - APAGA os movimentos da importação de teste, que não têm loja
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

const gravar = process.argv.includes("--gravar")

/** A loja que herda o que já existe no banco: a matriz. */
const LOJA_DOS_DADOS_ATUAIS = "QI"

const CONTAS = [
  { codigo: "MATRIZ", nome: "BrasSaco Matriz (atende QI e QNE)", cnpj: "32907479000130", chavePix: "32907479000130" },
  { codigo: "NRT", nome: "BrasSaco Norte", cnpj: "", chavePix: null },
  { codigo: "SDS", nome: "BrasSaco SDS", cnpj: "", chavePix: null },
]

const LOJAS = [
  { codigo: "QI", nome: "QI", conta: "MATRIZ" },
  { codigo: "QNE", nome: "QNE", conta: "MATRIZ" },
  { codigo: "NRT", nome: "NRT", conta: "NRT" },
  { codigo: "SDS", nome: "SDS", conta: "SDS" },
]

const db = new PrismaClient()

// A importação de teste do estoque não tem loja e será refeita por loja; deixá-la
// somaria saldo numa prateleira que não existe.
const IMPORTACAO_DE_TESTE = "Importação do sistema antigo"

const paraApagar = await db.movimentoEstoque.count({ where: { operador: IMPORTACAO_DE_TESTE } })
const movimentos = await db.movimentoEstoque.count()
const vendas = await db.venda.count()
const cobrancas = await db.cobranca.count()
const usuarios = await db.usuario.count()

console.log("SITUAÇÃO ATUAL")
console.log(`  ${vendas} vendas, ${cobrancas} cobranças, ${movimentos} movimentos, ${usuarios} usuários`)
console.log(`  dos movimentos, ${paraApagar} são da importação de teste (serão APAGADOS)`)
console.log(`  os ${movimentos - paraApagar} restantes recebem loja=${LOJA_DOS_DADOS_ATUAIS}`)
console.log("\nA CADASTRAR")
for (const c of CONTAS) console.log(`  conta ${c.codigo.padEnd(7)} ${c.nome}`)
for (const l of LOJAS) console.log(`  loja  ${l.codigo.padEnd(7)} conta ${l.conta}`)

if (!gravar) {
  console.log("\n--- ENSAIO: nada gravado. Use --gravar. ---")
  await db.$disconnect()
  process.exit(0)
}

for (const conta of CONTAS) {
  await db.contaInter.upsert({
    where: { codigo: conta.codigo },
    update: { nome: conta.nome },
    create: conta,
  })
}
for (const loja of LOJAS) {
  await db.loja.upsert({
    where: { codigo: loja.codigo },
    update: { conta: loja.conta },
    // O CNPJ é @unique; vazio em três lojas colidiria. Fica o código até você
    // informar os documentos reais de cada uma.
    create: { ...loja, cnpj: `pendente-${loja.codigo}` },
  })
}
console.log(`cadastradas ${CONTAS.length} contas e ${LOJAS.length} lojas`)

const apagados = await db.movimentoEstoque.deleteMany({ where: { operador: IMPORTACAO_DE_TESTE } })
console.log(`movimentos da importação de teste apagados: ${apagados.count}`)

// $set direto: `loja` é obrigatório no schema, então o Prisma não deixa gravar
// documento sem ele — e é justamente o que estamos consertando.
for (const [colecao, rotulo] of [
  ["vendas", "vendas"],
  ["movimentos_estoque", "movimentos"],
  ["cobrancas", "cobranças"],
]) {
  const r = await db.$runCommandRaw({
    update: colecao,
    updates: [
      {
        q: { loja: { $exists: false } },
        u: { $set: { loja: LOJA_DOS_DADOS_ATUAIS } },
        multi: true,
      },
    ],
  })
  console.log(`${rotulo}: ${r.nModified} com loja=${LOJA_DOS_DADOS_ATUAIS}`)
}

// A cobrança precisa saber de qual conta saiu, para consulta/PDF/cancelamento.
const contaDaLoja = LOJAS.find((l) => l.codigo === LOJA_DOS_DADOS_ATUAIS).conta
const rc = await db.$runCommandRaw({
  update: "cobrancas",
  updates: [{ q: { conta: { $exists: false } }, u: { $set: { conta: contaDaLoja } }, multi: true }],
})
console.log(`cobranças: ${rc.nModified} com conta=${contaDaLoja}`)

// Usuário sem lojas = rede toda. É o que os cadastros atuais devem ser.
const ru = await db.$runCommandRaw({
  update: "usuarios",
  updates: [{ q: { lojas: { $exists: false } }, u: { $set: { lojas: [] } }, multi: true }],
})
console.log(`usuários: ${ru.nModified} com acesso à rede toda`)

// Contador por loja. O valor atual pertence à loja que herdou os dados.
const antigo = await db.contador.findUnique({ where: { nome: "venda" } })
for (const loja of LOJAS) {
  const nome = `venda:${loja.codigo}`
  const valor = loja.codigo === LOJA_DOS_DADOS_ATUAIS ? (antigo?.valor ?? 0) : 0
  await db.contador.upsert({ where: { nome }, update: {}, create: { nome, valor } })
  console.log(`contador ${nome} = ${valor}`)
}
if (antigo) {
  await db.contador.delete({ where: { nome: "venda" } })
  console.log('contador "venda" (global) removido')
}

console.log("\nCONFERÊNCIA")
for (const colecao of ["vendas", "movimentos_estoque", "cobrancas"]) {
  const r = await db.$runCommandRaw({ count: colecao, query: { loja: { $exists: false } } })
  console.log(`  ${colecao}: ${r.n} documento(s) ainda sem loja`)
}
const porLoja = await db.movimentoEstoque.groupBy({ by: ["loja"], _count: { _all: true } })
console.log("  movimentos por loja:", porLoja.map((g) => `${g.loja}=${g._count._all}`).join(" ") || "(nenhum)")

await db.$disconnect()
