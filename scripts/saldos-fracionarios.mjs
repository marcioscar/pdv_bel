/**
 * Lista os saldos com casa decimal em produto que se conta inteiro.
 *
 *   node scripts/saldos-fracionarios.mjs            # na tela
 *   node scripts/saldos-fracionarios.mjs --csv      # grava dados/saldos-fracionarios.csv
 *
 * Fração num produto medido em PC ou UN é sintoma, não dado: ou a unidade do
 * cadastro está errada (bobina e fitilho se vendem por quilo e por metro), ou
 * alguém lançou fração de uma peça. As duas coisas querem conserto diferente,
 * e por isso a lista separa em três grupos em vez de só apontar o decimal.
 *
 * Lê do BANCO, e não do arquivo importado: depois do primeiro ajuste as duas
 * coisas divergem, e quem confere quer saber o que está valendo agora.
 */
import { mkdirSync, writeFileSync } from "node:fs"
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

const csv = process.argv.includes("--csv")
const db = new PrismaClient()

/** Unidades que não admitem fração. Quilo e metro admitem, e ficam de fora. */
const INTEIRAS = new Set(["PC", "UN", "CX", "PCT", "FD"])

/** Quanto conta como sujeira de arredondamento, e não como saldo. */
const QUASE_ZERO = 0.15

const produtos = await db.produto.findMany({
  select: { id: true, codigo: true, descricao: true, unidade: true, ativo: true },
})
const porId = new Map(produtos.map((p) => [p.id, p]))

const saldos = await db.movimentoEstoque.groupBy({
  by: ["produtoId", "loja"],
  _sum: { quantidade: true },
})

const linhas = []
for (const s of saldos) {
  const produto = porId.get(s.produtoId)
  if (!produto) continue
  if (!INTEIRAS.has(produto.unidade.toUpperCase())) continue

  const saldo = s._sum.quantidade ?? 0
  if (saldo === 0) continue
  if (Math.abs(saldo - Math.round(saldo)) < 1e-9) continue

  linhas.push({ produto, loja: s.loja, saldo })
}

/*
 * Produto fracionado em VÁRIAS lojas quase nunca é engano de contagem: é a
 * unidade do cadastro que está errada. Fitilho "No Kilo" e bobina por metro
 * aparecem fracionados nas quatro, e nenhuma contagem conserta isso.
 */
const lojasPorProduto = new Map()
for (const l of linhas) {
  lojasPorProduto.set(l.produto.id, (lojasPorProduto.get(l.produto.id) ?? 0) + 1)
}

function grupoDe(l) {
  if (lojasPorProduto.get(l.produto.id) > 1) return "unidade"
  if (Math.abs(l.saldo) < QUASE_ZERO) return "quase zero"
  return "conferir"
}

const SUGESTAO = {
  unidade: "Trocar a unidade no cadastro (KG ou MT) — a fração é legítima",
  "quase zero": "Zerar por ajuste: é resto de arredondamento",
  conferir: "Contar na prateleira e ajustar pelo inventário",
}

const porGrupo = { unidade: [], "quase zero": [], conferir: [] }
for (const l of linhas) porGrupo[grupoDe(l)].push(l)

const totalRede = new Map()
for (const s of saldos) {
  totalRede.set(s.produtoId, (totalRede.get(s.produtoId) ?? 0) + (s._sum.quantidade ?? 0))
}

const ordem = (a, b) =>
  a.produto.codigo.localeCompare(b.produto.codigo, "pt-BR", { numeric: true }) ||
  a.loja.localeCompare(b.loja)

console.log(`${linhas.length} saldos fracionários em ${lojasPorProduto.size} produtos\n`)
for (const [grupo, itens] of Object.entries(porGrupo)) {
  if (itens.length === 0) continue
  console.log(`=== ${grupo.toUpperCase()} (${itens.length}) — ${SUGESTAO[grupo]}`)
  for (const l of itens.sort(ordem)) {
    console.log(
      `  ${l.produto.codigo.padStart(6)} ${l.loja.padEnd(4)} ${l.saldo.toFixed(4).padStart(12)} ` +
        `${l.produto.unidade.padEnd(4)} ${l.produto.descricao.slice(0, 44)}`
    )
  }
  console.log()
}

if (!csv) {
  console.log("Rode com --csv para gravar a planilha.")
  await db.$disconnect()
  process.exit(0)
}

// Ponto e vírgula e vírgula decimal: é como o Excel em português abre sem
// pedir nada. O BOM no começo é o que faz o acento aparecer certo nele.
const numero = (n) => n.toFixed(4).replace(".", ",")
const campo = (v) => `"${String(v).replace(/"/g, '""')}"`

const cabecalho = [
  "Grupo", "Código", "Descrição", "Unidade", "Loja",
  "Saldo", "Saldo na rede", "Contado", "Sugestão",
]

const corpo = []
for (const [grupo, itens] of Object.entries(porGrupo)) {
  for (const l of itens.sort(ordem)) {
    corpo.push([
      campo(grupo),
      campo(l.produto.codigo),
      campo(l.produto.descricao),
      campo(l.produto.unidade),
      campo(l.loja),
      campo(numero(l.saldo)),
      campo(numero(totalRede.get(l.produto.id) ?? 0)),
      // Coluna vazia de propósito: é onde quem for à prateleira escreve.
      campo(""),
      campo(SUGESTAO[grupo]),
    ].join(";"))
  }
}

mkdirSync("dados", { recursive: true })
const destino = "dados/saldos-fracionarios.csv"
writeFileSync(destino, "﻿" + [cabecalho.map(campo).join(";"), ...corpo].join("\r\n") + "\r\n")
console.log(`planilha: ${destino} · ${corpo.length} linhas`)

await db.$disconnect()
