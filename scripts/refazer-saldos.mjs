/**
 * Apaga o livro de movimentos INTEIRO e o recria com uma posição inicial.
 *
 *   node scripts/refazer-saldos.mjs dados/estoque.json          # ensaio
 *   node scripts/refazer-saldos.mjs dados/estoque.json --gravar # grava
 *
 * Isto é diferente de `importar-saldos.mjs`, que ajusta o que existe até chegar
 * ao número do arquivo. Aqui o passado é descartado: a ficha de cada produto
 * passa a ter UMA linha, a da contagem. Serve para o dia em que o sistema entra
 * no ar de verdade e o histórico anterior era só teste.
 *
 * **É irreversível**, então o dump vem antes — sem `--gravar` ele nem acontece,
 * e com `--gravar` nada é apagado enquanto o arquivo de backup não estiver em
 * disco.
 *
 * Quatro decisões:
 *
 * 1. **Grava AJUSTE, não entrada.** É saldo contado, não mercadoria que chegou.
 *    E entrada carrega custo: gravá-la faria o último custo de TODO produto
 *    virar o deste arquivo, mudando a valorização do inventário inteiro sem
 *    ninguém ter pedido.
 *
 * 2. **Saldo zero não vira movimento.** Uma linha de quantidade zero não diz
 *    nada que a ausência dela já não diga, e encheria a ficha de 3 mil linhas
 *    mudas.
 *
 * 3. **Código repetido desempata pela unidade e, se não bastar, pelo ativo.**
 *    O catálogo tem 55 códigos repetidos, e em todos eles exatamente um produto
 *    está ativo — o outro é cadastro morto. Sem nenhum dos dois critérios, a
 *    linha fica de fora e é reportada: adivinhar aqui é pior que não importar.
 *
 * 4. **Saldo negativo entra como está.** Corrigir para zero na importação
 *    esconderia exatamente o que precisa ser investigado.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  console.error("uso: node scripts/refazer-saldos.mjs <arquivo.json> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")
const OPERADOR = "Posição inicial importada"

/** Os locais do sistema antigo e as lojas daqui, conferidos pela razão social. */
const LOJAS = {
  "1 - BRASSACO EMBALAGENS LTDA - MATRIZ": "QI",
  "2 - BRASSACO EMBALAGENS LTDA - FILIAL": "QNE",
  "3 - PLASTIBRA": "NRT",
  "4 - SACOBRAS": "SDS",
}

const db = new PrismaClient()
const linhas = JSON.parse(readFileSync(arquivoJson, "utf8").replace(/^﻿/, ""))
const produtos = await db.produto.findMany()

const porCodigo = new Map()
for (const p of produtos) {
  const c = p.codigo.trim()
  if (!porCodigo.has(c)) porCodigo.set(c, [])
  porCodigo.get(c).push(p)
}

const casados = []
const semPar = []
const ambiguos = []
const localDesconhecido = new Set()
let zerados = 0

for (const linha of linhas) {
  const loja = LOJAS[linha.id_local_estoque]
  if (!loja) {
    localDesconhecido.add(linha.id_local_estoque)
    continue
  }

  const alvo = Number(linha.nu_saldo_qtd)
  if (!Number.isFinite(alvo)) continue
  if (alvo === 0) {
    zerados++
    continue
  }

  const candidatos = porCodigo.get(String(linha.id_produto).trim())
  if (!candidatos) {
    semPar.push(linha)
    continue
  }

  let produto = candidatos[0]
  if (candidatos.length > 1) {
    const porUnidade = candidatos.filter(
      (p) => p.unidade.toUpperCase() === String(linha.unidade_medida).toUpperCase()
    )
    const ativos = (porUnidade.length > 0 ? porUnidade : candidatos).filter((p) => p.ativo)

    if (porUnidade.length === 1) produto = porUnidade[0]
    else if (ativos.length === 1) produto = ativos[0]
    else {
      ambiguos.push(linha)
      continue
    }
  }

  casados.push({ produtoId: produto.id, loja, quantidade: alvo })
}

const porLoja = {}
for (const c of casados) {
  porLoja[c.loja] ??= { linhas: 0, unidades: 0, negativos: 0 }
  porLoja[c.loja].linhas++
  porLoja[c.loja].unidades += c.quantidade
  if (c.quantidade < 0) porLoja[c.loja].negativos++
}

const aApagar = await db.movimentoEstoque.count()
const porTipo = await db.movimentoEstoque.groupBy({ by: ["tipo"], _count: { _all: true } })

console.log(`arquivo: ${arquivoJson} · ${linhas.length} linhas`)
console.log(`catálogo: ${produtos.length} produtos\n`)

console.log(`A APAGAR: ${aApagar} movimentos de estoque`)
for (const t of porTipo.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`   ${t.tipo.padEnd(24)} ${t._count._all}`)
}

console.log("\nA GRAVAR:")
console.log("loja    linhas    unidades   negativos")
for (const [loja, g] of Object.entries(porLoja)) {
  console.log(
    `${loja.padEnd(6)} ${String(g.linhas).padStart(7)} ${g.unidades.toFixed(0).padStart(11)} ${String(g.negativos).padStart(11)}`
  )
}
console.log(`total: ${casados.length} ajustes de posição inicial`)

console.log("\nfora da importação:")
console.log(`  ${zerados} linhas com saldo zero (não viram movimento)`)
console.log(`  ${semPar.length} linhas com saldo e SEM produto no catálogo`)
console.log(`  ${ambiguos.length} linhas de código repetido sem desempate`)
if (localDesconhecido.size > 0) {
  console.log(`  locais não mapeados: ${[...localDesconhecido].join(", ")}`)
}

const comSaldoDepois = new Set(casados.map((c) => c.produtoId))
const zeradosNoCatalogo = produtos.filter((p) => !comSaldoDepois.has(p.id))
console.log(`  ${zeradosNoCatalogo.length} produtos do catálogo ficarão com saldo zero em todas as lojas`)

if (semPar.length > 0) {
  const codigos = [...new Set(semPar.map((l) => String(l.id_produto).trim()))]
  console.log(`\ncódigos do arquivo sem produto aqui (${codigos.length}): ${codigos.slice(0, 20).join(", ")}${codigos.length > 20 ? "…" : ""}`)
}
if (ambiguos.length > 0) {
  console.log("\nambíguos:")
  for (const l of ambiguos) console.log(`  cod ${l.id_produto} ${l.unidade_medida} ${l.nu_saldo_qtd} · ${l.descricao}`)
}

if (!gravar) {
  console.log("\n--- ENSAIO: nada foi apagado nem gravado. Rode com --gravar para valer. ---")
  await db.$disconnect()
  process.exit(0)
}

/*
 * O dump vem ANTES de apagar, e o apagar só acontece depois de ele estar em
 * disco. É a única coisa que separa "refazer a posição" de "perder o histórico".
 */
mkdirSync("backups", { recursive: true })
const carimbo = new Date().toISOString().replace(/[:.]/g, "-")
const destino = `backups/movimentos-estoque-${carimbo}.json`
const antigos = await db.movimentoEstoque.findMany()
writeFileSync(destino, JSON.stringify(antigos, null, 1))
console.log(`\nbackup: ${destino} · ${antigos.length} movimentos`)

const apagados = await db.movimentoEstoque.deleteMany({})
console.log(`apagados: ${apagados.count}`)

const observacao = `Posição inicial de ${arquivoJson.split("/").pop()}`
const LOTE = 200
let gravados = 0
for (let i = 0; i < casados.length; i += LOTE) {
  const fatia = casados.slice(i, i + LOTE)
  await db.movimentoEstoque.createMany({
    data: fatia.map((c) => ({
      produtoId: c.produtoId,
      loja: c.loja,
      tipo: "ajuste",
      quantidade: c.quantidade,
      operador: OPERADOR,
      observacao,
    })),
  })
  gravados += fatia.length
  if (gravados % 1000 === 0 || gravados === casados.length) console.log(`  gravados ${gravados}/${casados.length}`)
}

const final = await db.movimentoEstoque.count()
console.log(`\nlivro agora: ${final} movimentos`)
await db.$disconnect()
