/**
 * Importa a posição de estoque de um arquivo do sistema antigo, por loja.
 *
 *   node scripts/importar-saldos.mjs public/stq029_1_2.json          # ensaio
 *   node scripts/importar-saldos.mjs public/stq029_1_2.json --gravar # grava
 *
 * Quatro decisões que valem explicação:
 *
 * 1. **Grava AJUSTE, não entrada.** O movimento é a diferença até o saldo do
 *    arquivo, então o livro termina exatamente no número importado e rodar duas
 *    vezes não duplica nada. Com "entrada" a segunda execução dobraria o estoque.
 *
 * 2. **A chave é código + unidade.** Códigos se repetem no catálogo (o mesmo
 *    produto em PC e em CX), e o arquivo traz a unidade — sem ela, saldos
 *    cairiam no produto errado. Sem desempate seguro, a linha fica de fora e é
 *    reportada: adivinhar aqui é pior que não importar.
 *
 * 3. **Cada saldo vai para a SUA loja.** O arquivo traz `id_local_estoque`, e o
 *    estoque deste sistema é por loja. A versão anterior deste script é anterior
 *    à rede: ela gravava movimento sem loja, o que somaria as quatro posições num
 *    número que não corresponde a prateleira nenhuma.
 *
 * 4. **Saldo negativo entra como está.** O sistema antigo tem negativos, e
 *    "corrigir" para zero na importação esconderia exatamente o que precisa ser
 *    investigado.
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

/**
 * Os locais do sistema antigo e as lojas daqui.
 *
 * Conferido pelas razões sociais: QI e QNE são a mesma BRASSACO (matriz e
 * filial), NRT é a Plastibra e SDS é a Sacobras.
 */
const LOJAS = {
  "1 - BRASSACO EMBALAGENS LTDA - MATRIZ": "QI",
  "2 - BRASSACO EMBALAGENS LTDA - FILIAL": "QNE",
  "3 - PLASTIBRA": "NRT",
  "4 - SACOBRAS": "SDS",
}

const db = new PrismaClient()
const linhas = JSON.parse(readFileSync(arquivoJson, "utf8"))
const produtos = await db.produto.findMany()

const porCodigo = new Map()
for (const p of produtos) {
  if (!porCodigo.has(p.codigo)) porCodigo.set(p.codigo, [])
  porCodigo.get(p.codigo).push(p)
}

/** Saldo atual de cada produto EM CADA LOJA, numa consulta só. */
const grupos = await db.movimentoEstoque.groupBy({
  by: ["produtoId", "loja"],
  _sum: { quantidade: true },
})
const saldoAtual = new Map(
  grupos.map((g) => [`${g.produtoId}|${g.loja}`, g._sum.quantidade ?? 0])
)

const casados = []
const semPar = []
const ambiguos = []
const localDesconhecido = new Set()

for (const linha of linhas) {
  const loja = LOJAS[linha.id_local_estoque]
  if (!loja) {
    localDesconhecido.add(linha.id_local_estoque)
    continue
  }

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
      if (alvo !== 0) ambiguos.push(linha)
      continue
    }
  }

  const atual = saldoAtual.get(`${produto.id}|${loja}`) ?? 0
  const diferenca = Math.round((alvo - atual) * 10000) / 10000
  if (diferenca === 0) continue

  casados.push({ produto, loja, alvo, atual, diferenca })
}

const porLoja = {}
for (const c of casados) {
  porLoja[c.loja] ??= { ajustes: 0, unidades: 0, negativos: 0 }
  porLoja[c.loja].ajustes++
  porLoja[c.loja].unidades += c.alvo
  if (c.alvo < 0) porLoja[c.loja].negativos++
}

console.log(`arquivo: ${arquivoJson} · ${linhas.length} linhas`)
console.log(`catálogo: ${produtos.length} produtos\n`)
console.log("loja   ajustes   unidades   negativos")
for (const [loja, g] of Object.entries(porLoja)) {
  console.log(
    `${loja.padEnd(6)} ${String(g.ajustes).padStart(7)} ${g.unidades.toFixed(0).padStart(10)} ${String(g.negativos).padStart(11)}`
  )
}
console.log(`\na gravar: ${casados.length} ajustes`)

console.log(`\nnão importados:`)
console.log(`  ${semPar.length} com saldo != 0 e SEM produto no catálogo`)
console.log(`  ${ambiguos.length} com código repetido e sem desempate pela unidade`)
if (localDesconhecido.size > 0) {
  console.log(`  locais não mapeados: ${[...localDesconhecido].join(", ")}`)
}

if (semPar.length > 0) {
  console.log(`\nsem produto no catálogo (nada foi gravado para estes):`)
  for (const l of semPar) {
    console.log(
      `  ${String(LOJAS[l.id_local_estoque]).padEnd(4)} cod ${String(l.id_produto).padEnd(6)} ${String(l.nu_saldo_qtd).padStart(10)} ${String(l.unidade_medida).padEnd(4)} ${l.descricao}`
    )
  }
}
if (ambiguos.length > 0) {
  console.log(`\ncódigo repetido sem desempate:`)
  for (const l of ambiguos) {
    console.log(`  cod ${l.id_produto} ${l.unidade_medida} ${l.nu_saldo_qtd} · ${l.descricao}`)
  }
}

if (!gravar) {
  console.log(`\n--- ENSAIO: nada foi gravado. Rode com --gravar para valer. ---`)
  await db.$disconnect()
  process.exit(0)
}

const arquivo = arquivoJson.split("/").pop()
let gravados = 0

// Em lotes: milhares de inserts um a um levariam minutos contra o Mongo remoto.
const LOTE = 200
for (let i = 0; i < casados.length; i += LOTE) {
  const fatia = casados.slice(i, i + LOTE)
  await db.movimentoEstoque.createMany({
    data: fatia.map((c) => ({
      produtoId: c.produto.id,
      loja: c.loja,
      tipo: "ajuste",
      quantidade: c.diferenca,
      operador: OPERADOR,
      observacao: `Saldo inicial de ${arquivo} · ${c.loja} ficou com ${c.alvo}${c.atual !== 0 ? `, havia ${c.atual}` : ""}`,
    })),
  })
  gravados += fatia.length
  process.stdout.write(`\rgravados ${gravados}/${casados.length}`)
}
console.log()

// Confere pelo LIVRO, não pelo que acreditamos ter gravado.
const depois = await db.movimentoEstoque.groupBy({
  by: ["produtoId", "loja"],
  _sum: { quantidade: true },
})
const saldoDepois = new Map(
  depois.map((g) => [`${g.produtoId}|${g.loja}`, g._sum.quantidade ?? 0])
)

let conferem = 0
const divergentes = []
for (const c of casados) {
  const real = Math.round((saldoDepois.get(`${c.produto.id}|${c.loja}`) ?? 0) * 10000) / 10000
  if (real === c.alvo) conferem++
  else divergentes.push(`  ${c.loja} cod ${c.produto.codigo}: esperado ${c.alvo}, livro diz ${real}`)
}
console.log(`\nconferência: ${conferem}/${casados.length} saldos batem com o arquivo`)
if (divergentes.length > 0) {
  console.log("DIVERGENTES:")
  divergentes.slice(0, 20).forEach((d) => console.log(d))
}

const comSaldo = [...saldoDepois.entries()].filter(([, v]) => v !== 0)
const porLojaDepois = {}
for (const [chave] of comSaldo) {
  const loja = chave.split("|")[1]
  porLojaDepois[loja] = (porLojaDepois[loja] ?? 0) + 1
}
console.log(`\nprodutos com saldo != 0 depois da importação:`)
for (const [loja, n] of Object.entries(porLojaDepois)) console.log(`  ${loja}: ${n}`)

await db.$disconnect()
