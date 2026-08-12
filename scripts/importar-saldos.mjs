/**
 * Importa a posição de estoque de um arquivo do sistema antigo.
 *
 *   node scripts/importar-saldos.mjs public/stq029_1_2.json          # ensaio
 *   node scripts/importar-saldos.mjs public/stq029_1_2.json --gravar # grava
 *
 * Duas decisões que valem explicação:
 *
 * 1. **Grava AJUSTE, não entrada.** O movimento é a diferença até o saldo do
 *    arquivo, então o livro termina exatamente no número importado e rodar duas
 *    vezes não duplica nada. Com "entrada" a segunda execução dobraria o estoque.
 *
 * 2. **A chave é código + unidade.** 55 códigos se repetem no catálogo (o mesmo
 *    produto em PC e em CX), e o arquivo traz a unidade — sem ela, 24 saldos
 *    cairiam no produto errado.
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

const [arquivoJson, ...opcoes] = process.argv.slice(2)
if (!arquivoJson) {
  console.error("uso: node scripts/importar-saldos.mjs <arquivo.json> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")
const OPERADOR = "Importação do sistema antigo"

const db = new PrismaClient()
const linhas = JSON.parse(readFileSync(arquivoJson, "utf8"))
const produtos = await db.produto.findMany()

const porCodigo = new Map()
for (const p of produtos) {
  if (!porCodigo.has(p.codigo)) porCodigo.set(p.codigo, [])
  porCodigo.get(p.codigo).push(p)
}

/** Saldo atual de cada produto, numa consulta só. */
const grupos = await db.movimentoEstoque.groupBy({
  by: ["produtoId"],
  _sum: { quantidade: true },
})
const saldoAtual = new Map(grupos.map((g) => [g.produtoId, g._sum.quantidade ?? 0]))

const casados = []
const semPar = []
const ambiguosNaoResolvidos = []

for (const linha of linhas) {
  const alvo = Number(linha.nu_saldo_qtd)
  if (!Number.isFinite(alvo)) continue

  const candidatos = porCodigo.get(linha.id_produto)
  if (!candidatos) {
    if (alvo !== 0) semPar.push(linha)
    continue
  }

  let produto = candidatos[0]
  if (candidatos.length > 1) {
    const porUnidade = candidatos.filter(
      (p) => p.unidade.toUpperCase() === String(linha.unidade_medida).toUpperCase()
    )
    if (porUnidade.length === 1) {
      produto = porUnidade[0]
    } else {
      // Sem desempate seguro, não adivinha: reporta e deixa de fora.
      if (alvo !== 0) ambiguosNaoResolvidos.push(linha)
      continue
    }
  }

  const atual = saldoAtual.get(produto.id) ?? 0
  const diferenca = Math.round((alvo - atual) * 10000) / 10000
  if (diferenca === 0) continue

  casados.push({ produto, alvo, atual, diferenca, unidadeArquivo: linha.unidade_medida })
}

const negativos = casados.filter((c) => c.alvo < 0)

console.log(`arquivo: ${arquivoJson} · ${linhas.length} linhas`)
console.log(`catálogo: ${produtos.length} produtos`)
console.log(`\na gravar: ${casados.length} ajustes`)
console.log(`  saldo positivo: ${casados.filter((c) => c.alvo > 0).length}`)
console.log(`  saldo negativo: ${negativos.length}`)
console.log(`  soma das quantidades: ${casados.reduce((a, c) => a + c.alvo, 0).toFixed(4)}`)
console.log(`\nnão importados:`)
console.log(`  ${semPar.length} com saldo != 0 e SEM produto no catálogo`)
console.log(`  ${ambiguosNaoResolvidos.length} com código repetido e sem desempate`)

if (semPar.length > 0) {
  console.log(`\nsem produto no catálogo (nada foi gravado para estes):`)
  for (const l of semPar) {
    console.log(
      `  cod ${String(l.id_produto).padEnd(6)} ${String(l.nu_saldo_qtd).padStart(10)} ${String(l.unidade_medida).padEnd(4)} ${l.descricao}`
    )
  }
}
if (negativos.length > 0) {
  console.log(`\nsaldo NEGATIVO no arquivo (importado como está, para não esconder o problema):`)
  for (const c of negativos) {
    console.log(`  cod ${c.produto.codigo.padEnd(6)} ${String(c.alvo).padStart(8)} ${c.produto.descricao}`)
  }
}

if (!gravar) {
  console.log(`\n--- ENSAIO: nada foi gravado. Rode com --gravar para valer. ---`)
  await db.$disconnect()
  process.exit(0)
}

const observacao = `Saldo inicial importado de ${arquivoJson.split("/").pop()}`
let gravados = 0

// Em lotes: 600+ inserts um a um levariam minutos contra o Mongo remoto.
const LOTE = 100
for (let i = 0; i < casados.length; i += LOTE) {
  const fatia = casados.slice(i, i + LOTE)
  await db.movimentoEstoque.createMany({
    data: fatia.map((c) => ({
      produtoId: c.produto.id,
      tipo: "ajuste",
      quantidade: c.diferenca,
      operador: OPERADOR,
      observacao: `${observacao} · saldo ${c.alvo}${c.atual !== 0 ? `, havia ${c.atual}` : ""}`,
    })),
  })
  gravados += fatia.length
  process.stdout.write(`\rgravados ${gravados}/${casados.length}`)
}
console.log()

// Confere pelo livro, não pelo que acreditamos ter gravado.
const depois = await db.movimentoEstoque.groupBy({
  by: ["produtoId"],
  _sum: { quantidade: true },
})
const saldoDepois = new Map(depois.map((g) => [g.produtoId, g._sum.quantidade ?? 0]))

let conferem = 0
const divergentes = []
for (const c of casados) {
  const real = Math.round((saldoDepois.get(c.produto.id) ?? 0) * 10000) / 10000
  if (real === c.alvo) conferem++
  else divergentes.push(`  cod ${c.produto.codigo}: esperado ${c.alvo}, livro diz ${real}`)
}
console.log(`\nconferência: ${conferem}/${casados.length} produtos com o saldo do arquivo`)
if (divergentes.length > 0) {
  console.log("DIVERGENTES:")
  divergentes.slice(0, 20).forEach((d) => console.log(d))
}
console.log(`produtos com saldo != 0 no total: ${[...saldoDepois.values()].filter((v) => v !== 0).length}`)

await db.$disconnect()
