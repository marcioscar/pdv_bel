/**
 * Recomeça vendas e estoque a partir dos saldos do sistema antigo, sem tocar
 * nos boletos.
 *
 *   node scripts/recomecar-vendas-e-estoque.mjs dados/<arquivo>.json          # ensaio
 *   node scripts/recomecar-vendas-e-estoque.mjs dados/<arquivo>.json --gravar # grava
 *
 * Pedido do Marcio (05/10/2026), com as escolhas dele:
 *
 * - **Vendas:** apaga todas, MENOS as que geraram boleto. O boleto não guarda o
 *   cliente — nome, documento e a ligação com o cadastro vêm da venda. Apagá-la
 *   deixaria o boleto sem dono em Inadimplentes e fora da trava do caixa.
 * - **Junto:** notas fiscais das vendas apagadas, movimentos e fechamentos de
 *   caixa, devoluções, créditos de cliente, liberações do gerente e Pix
 *   pendentes. Notas SEM venda ligada ficam (não se sabe de onde vieram).
 * - **Numeração:** cada loja continua do maior número entre as vendas que
 *   ficaram (sem nenhuma, volta ao 1). Voltar ao 1 com vendas mantidas faria a
 *   venda nova #12 colidir com a #12 que o boleto mostra. O contador de
 *   devolução volta ao 1, porque as devoluções somem todas.
 * - **Estoque:** apaga os movimentos de venda, estorno e ajuste. Ficam entradas,
 *   transferências, uso e devolução, como histórico. Por cima, um AJUSTE por
 *   produto e loja leva o saldo exatamente ao número do arquivo.
 * - **Intactos:** `cobrancas` e `boletos_externos`, cadastros, compras,
 *   transferências, notas recebidas, receitas e despesas.
 *
 * O backup de TUDO que sai é gravado em disco antes de qualquer exclusão; sem o
 * arquivo escrito, nada é apagado. Rodar com as lojas fechadas: uma venda no
 * meio do caminho ficaria fora da conta do estoque.
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
  console.error("uso: node scripts/recomecar-vendas-e-estoque.mjs <arquivo.json> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")
const OPERADOR = "Recomeço com saldos do sistema antigo"
const TIPOS_APAGADOS = ["venda", "estorno", "ajuste"]

/** Os locais do sistema antigo e as lojas daqui, conferidos pela razão social. */
const LOJAS = {
  "1 - BRASSACO EMBALAGENS LTDA - MATRIZ": "QI",
  "2 - BRASSACO EMBALAGENS LTDA - FILIAL": "QNE",
  "3 - PLASTIBRA": "NRT",
  "4 - SACOBRAS": "SDS",
}

const db = new PrismaClient()
const n = (v) => String(v).padStart(7)

// ---------------------------------------------------------------------------
// O arquivo
// ---------------------------------------------------------------------------
const linhas = JSON.parse(readFileSync(arquivoJson, "utf8").replace(/^﻿/, ""))
const datas = linhas.map((l) => l.dt_saldo ?? "").filter(Boolean).sort()
const maisRecente = datas[datas.length - 1] ?? "?"
const diasDeIdade = Math.floor((Date.now() - new Date(`${maisRecente}T12:00:00`).getTime()) / 86_400_000)

console.log(`ARQUIVO: ${arquivoJson} · ${linhas.length} linhas · saldo mais recente ${maisRecente}`)
if (!(diasDeIdade <= 3)) {
  console.log(`  ⚠ O saldo mais recente tem ${diasDeIdade} dias. Confira se é a exportação de hoje.`)
}

// ---------------------------------------------------------------------------
// Vendas: quais ficam
// ---------------------------------------------------------------------------
const comBoleto = [...new Set((await db.cobranca.findMany({ select: { vendaId: true } })).map((c) => c.vendaId))]
const mantidas = await db.venda.findMany({
  where: { id: { in: comBoleto } },
  select: { id: true, loja: true, numero: true },
})
const idsMantidos = mantidas.map((v) => v.id)
const vendasApagar = { id: { notIn: idsMantidos } }
const idsApagados = (await db.venda.findMany({ where: vendasApagar, select: { id: true } })).map((v) => v.id)
const notasApagar = { vendaId: { in: idsApagados } }
// Campo ausente não é null para o Mongo: os dois estados contam como "sem venda".
const semVenda = { OR: [{ vendaId: null }, { vendaId: { isSet: false } }] }

const maiorPorLoja = {}
for (const v of mantidas) maiorPorLoja[v.loja] = Math.max(maiorPorLoja[v.loja] ?? 0, v.numero)

const contadoresVenda = await db.contador.findMany({ where: { nome: { startsWith: "venda:" } } })
const contadoresDevolucao = await db.contador.findMany({ where: { nome: { startsWith: "devolucao:" } } })

const APAGAR = [
  ["venda", "vendas (sem boleto)", vendasApagar],
  ["notaFiscalEmitida", "notas fiscais das vendas apagadas", notasApagar],
  ["movimentoCaixa", "movimentos de caixa", {}],
  ["fechamentoCaixa", "fechamentos de caixa", {}],
  ["devolucao", "devoluções", {}],
  ["movimentoCredito", "créditos de cliente", {}],
  ["autorizacao", "liberações do gerente", {}],
  ["pixPendente", "Pix pendentes", {}],
  ["movimentoEstoque", `movimentos de estoque (${TIPOS_APAGADOS.join(", ")})`, { tipo: { in: TIPOS_APAGADOS } }],
]

console.log("\nA APAGAR:")
for (const [modelo, nome, where] of APAGAR) console.log(`${n(await db[modelo].count({ where }))}  ${nome}`)

console.log("\nFICA:")
console.log(`${n(mantidas.length)}  vendas com boleto`)
console.log(`${n(await db.cobranca.count())}  boletos do PDV (cobrancas)`)
console.log(`${n(await db.boletoExterno.count())}  boletos do sistema antigo`)
console.log(`${n(await db.notaFiscalEmitida.count({ where: semVenda }))}  notas fiscais sem venda ligada`)
console.log(`${n(await db.notaFiscalEmitida.count({ where: { vendaId: { in: idsMantidos } } }))}  notas fiscais das vendas com boleto`)
const tiposQueFicam = await db.movimentoEstoque.groupBy({
  by: ["tipo"],
  where: { tipo: { notIn: TIPOS_APAGADOS } },
  _count: { _all: true },
})
for (const t of tiposQueFicam) console.log(`${n(t._count._all)}  movimentos de estoque "${t.tipo}"`)

console.log("\nNUMERAÇÃO (próxima venda):")
const lojasComContador = new Set([
  ...contadoresVenda.map((c) => c.nome.slice("venda:".length)),
  ...Object.keys(maiorPorLoja),
])
for (const loja of [...lojasComContador].sort()) {
  const atual = contadoresVenda.find((c) => c.nome === `venda:${loja}`)?.valor ?? 0
  const novo = maiorPorLoja[loja] ?? 0
  console.log(`  ${loja.padEnd(5)} hoje #${atual + 1} -> #${novo + 1}`)
}
console.log(`  devoluções: ${contadoresDevolucao.length} contador(es) voltam ao 1`)

// ---------------------------------------------------------------------------
// Estoque: casar o arquivo com o catálogo e calcular os ajustes
// ---------------------------------------------------------------------------
const produtos = await db.produto.findMany()
const porCodigo = new Map()
for (const p of produtos) {
  const c = p.codigo.trim()
  if (!porCodigo.has(c)) porCodigo.set(c, [])
  porCodigo.get(c).push(p)
}

/** O que sobra no livro depois de apagar venda, estorno e ajuste. */
const restante = new Map(
  (
    await db.movimentoEstoque.groupBy({
      by: ["produtoId", "loja"],
      where: { tipo: { notIn: TIPOS_APAGADOS } },
      _sum: { quantidade: true },
    })
  ).map((g) => [`${g.produtoId}|${g.loja}`, g._sum.quantidade ?? 0])
)

const alvos = new Map()
const semPar = []
const ambiguos = []
const localDesconhecido = new Set()

for (const linha of linhas) {
  const loja = LOJAS[linha.id_local_estoque]
  if (!loja) {
    localDesconhecido.add(linha.id_local_estoque)
    continue
  }
  const alvo = Number(String(linha.nu_saldo_qtd).replace(",", "."))
  if (!Number.isFinite(alvo)) continue

  const candidatos = porCodigo.get(String(linha.id_produto).trim())
  if (!candidatos) {
    if (alvo !== 0) semPar.push(linha)
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
      if (alvo !== 0) ambiguos.push(linha)
      continue
    }
  }
  alvos.set(`${produto.id}|${loja}`, { produtoId: produto.id, loja, alvo })
}

const ajustes = []
for (const { produtoId, loja, alvo } of alvos.values()) {
  const sobra = restante.get(`${produtoId}|${loja}`) ?? 0
  const diferenca = Math.round((alvo - sobra) * 10000) / 10000
  if (diferenca !== 0) ajustes.push({ produtoId, loja, alvo, sobra, diferenca })
}

// Produto com saldo no PDV que o arquivo não traz: fica com o que sobrar.
const foraDoArquivo = [...restante].filter(([chave, q]) => q !== 0 && !alvos.has(chave)).length

console.log("\nESTOQUE (depois de apagar, por cima do que sobra):")
const porLoja = {}
for (const a of ajustes) {
  porLoja[a.loja] ??= { ajustes: 0, unidades: 0, negativos: 0 }
  porLoja[a.loja].ajustes++
  if (a.alvo < 0) porLoja[a.loja].negativos++
}
for (const { loja, alvo } of alvos.values()) {
  porLoja[loja] ??= { ajustes: 0, unidades: 0, negativos: 0 }
  porLoja[loja].unidades += alvo
}
console.log("  loja   ajustes   unidades no fim   negativos")
for (const [loja, g] of Object.entries(porLoja).sort()) {
  console.log(`  ${loja.padEnd(5)} ${n(g.ajustes)} ${String(g.unidades.toFixed(0)).padStart(17)} ${String(g.negativos).padStart(11)}`)
}
console.log(`\n  ${semPar.length} linhas com saldo e SEM produto no catálogo (não entram)`)
console.log(`  ${ambiguos.length} linhas com código repetido sem desempate (não entram)`)
console.log(`  ${foraDoArquivo} produto/loja com saldo no PDV que o arquivo não traz (ficam como estão)`)
if (localDesconhecido.size > 0) console.log(`  locais não mapeados: ${[...localDesconhecido].join(", ")}`)
for (const l of semPar.slice(0, 30)) {
  console.log(`    sem produto: ${LOJAS[l.id_local_estoque]} cod ${l.id_produto} ${l.nu_saldo_qtd} ${l.unidade_medida} ${l.descricao}`)
}
for (const l of ambiguos.slice(0, 30)) {
  console.log(`    ambíguo: cod ${l.id_produto} ${l.unidade_medida} ${l.nu_saldo_qtd} ${l.descricao}`)
}

if (!gravar) {
  console.log("\n--- ENSAIO: nada foi apagado nem gravado. Rode com --gravar para valer. ---")
  await db.$disconnect()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Gravação: backup primeiro, depois apagar, depois ajustar
// ---------------------------------------------------------------------------
mkdirSync("backups", { recursive: true })
const carimbo = new Date().toISOString().replace(/[:.]/g, "-")
const dump = { contadores: [...contadoresVenda, ...contadoresDevolucao] }
for (const [modelo, , where] of APAGAR) dump[modelo] = await db[modelo].findMany({ where })
const destino = `backups/recomeco-${carimbo}.json`
writeFileSync(destino, JSON.stringify(dump, null, 1))
console.log(`\nbackup: ${destino}`)

for (const [modelo, nome, where] of APAGAR) {
  const r = await db[modelo].deleteMany({ where })
  console.log(`  apagados ${n(r.count)}  ${nome}`)
}

for (const c of contadoresVenda) {
  const loja = c.nome.slice("venda:".length)
  if (maiorPorLoja[loja]) await db.contador.update({ where: { id: c.id }, data: { valor: maiorPorLoja[loja] } })
  else await db.contador.delete({ where: { id: c.id } })
}
for (const [loja, valor] of Object.entries(maiorPorLoja)) {
  if (!contadoresVenda.some((c) => c.nome === `venda:${loja}`)) {
    await db.contador.create({ data: { nome: `venda:${loja}`, valor } })
  }
}
await db.contador.deleteMany({ where: { nome: { startsWith: "devolucao:" } } })
console.log("  numeração ajustada")

const arquivo = arquivoJson.split("/").pop()
let gravados = 0
for (let i = 0; i < ajustes.length; i += 200) {
  const fatia = ajustes.slice(i, i + 200)
  await db.movimentoEstoque.createMany({
    data: fatia.map((a) => ({
      produtoId: a.produtoId,
      loja: a.loja,
      tipo: "ajuste",
      quantidade: a.diferenca,
      operador: OPERADOR,
      observacao: `Saldo de ${arquivo} (${maisRecente}) · ${a.loja} ficou com ${a.alvo}`,
    })),
  })
  gravados += fatia.length
  process.stdout.write(`\r  ajustes gravados ${gravados}/${ajustes.length}`)
}
console.log()

// Confere pelo LIVRO, não pelo que acreditamos ter gravado.
const depois = new Map(
  (await db.movimentoEstoque.groupBy({ by: ["produtoId", "loja"], _sum: { quantidade: true } })).map(
    (g) => [`${g.produtoId}|${g.loja}`, g._sum.quantidade ?? 0]
  )
)
const divergentes = [...alvos.values()].filter(
  ({ produtoId, loja, alvo }) =>
    Math.round(((depois.get(`${produtoId}|${loja}`) ?? 0) - alvo) * 10000) !== 0
)
console.log(`\nconferência: ${alvos.size - divergentes.length} de ${alvos.size} saldos batem com o arquivo`)
for (const d of divergentes.slice(0, 20)) {
  console.log(`  DIVERGE ${d.loja} ${d.produtoId}: arquivo ${d.alvo}, livro ${depois.get(`${d.produtoId}|${d.loja}`) ?? 0}`)
}
console.log(`vendas restantes: ${await db.venda.count()} · boletos do PDV intactos: ${await db.cobranca.count()}`)

await db.$disconnect()
