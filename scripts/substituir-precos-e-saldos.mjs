/**
 * Substitui preço de venda, custo e saldo de TODAS as lojas pelos do arquivo
 * de estoque do sistema antigo.
 *
 *   node scripts/substituir-precos-e-saldos.mjs dados/<arquivo>.json          # ensaio
 *   node scripts/substituir-precos-e-saldos.mjs dados/<arquivo>.json --gravar # grava
 *
 * Pedido do Marcio (20/10/2026): o arquivo manda, o que está no banco sai.
 *
 * - **Saldo:** um AJUSTE por produto e loja leva o livro exatamente ao número
 *   do arquivo. Produto/loja com saldo aqui e fora do arquivo vai a zero. O
 *   livro não é apagado: as transferências conferidas e as perdas no transporte
 *   apontam para os movimentos delas, e o saldo final é o mesmo de apagar tudo.
 * - **Preço:** um só por produto, como no arquivo (o `vr_venda` é igual nas
 *   quatro lojas). Cada mudança entra em `alteracoes_preco`, como no cadastro.
 * - **Custo:** vai para `Produto.custo`, datado de agora, e passa a ser o
 *   "último custo" até chegar uma nota nova. O arquivo traz um custo por loja e
 *   eles divergem em ~350 produtos; vale o que mais se repete entre as lojas,
 *   e no empate o da matriz (QI), que é quem compra.
 *
 * Casamento: código + unidade; código repetido desempata pela unidade e depois
 * pelo ativo, como em `refazer-saldos.mjs`. O que não casa é reportado.
 *
 * Rodar com as lojas fechadas: uma venda no meio do caminho ficaria fora da
 * conta do ajuste.
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
  console.error("uso: node scripts/substituir-precos-e-saldos.mjs <arquivo.json> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")
const arquivo = arquivoJson.split("/").pop()
const OPERADOR = `Importação de ${arquivo}`

const LOJAS = {
  "1 - BRASSACO EMBALAGENS LTDA - MATRIZ": "QI",
  "2 - BRASSACO EMBALAGENS LTDA - FILIAL": "QNE",
  "3 - PLASTIBRA": "NRT",
  "4 - SACOBRAS": "SDS",
}

/** O arquivo mistura "62,860" (custo) e "87.9000" (venda). */
const numero = (v) => {
  const s = String(v ?? "").trim()
  return Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s)
}
const arredondar = (v, casas = 4) => Math.round(v * 10 ** casas) / 10 ** casas
const n = (v) => String(v).padStart(7)

const db = new PrismaClient()
const linhas = JSON.parse(readFileSync(arquivoJson, "utf8").replace(/^﻿/, ""))
const produtos = await db.produto.findMany()

const porCodigo = new Map()
for (const p of produtos) {
  const c = p.codigo.trim()
  if (!porCodigo.has(c)) porCodigo.set(c, [])
  porCodigo.get(c).push(p)
}

function casar(linha) {
  const candidatos = porCodigo.get(String(linha.id_produto).trim())
  if (!candidatos) return { erro: "sem" }
  if (candidatos.length === 1) return { produto: candidatos[0] }
  const porUnidade = candidatos.filter(
    (p) => p.unidade.toUpperCase() === String(linha.unidade_medida).toUpperCase()
  )
  if (porUnidade.length === 1) return { produto: porUnidade[0] }
  const ativos = (porUnidade.length > 0 ? porUnidade : candidatos).filter((p) => p.ativo)
  if (ativos.length === 1) return { produto: ativos[0] }
  return { erro: "ambiguo" }
}

const alvos = new Map() // produtoId|loja -> alvo
const linhasPorProduto = new Map() // produtoId -> linhas
const semPar = []
const ambiguos = []
const localDesconhecido = new Set()

for (const linha of linhas) {
  const loja = LOJAS[linha.id_local_estoque]
  if (!loja) {
    localDesconhecido.add(linha.id_local_estoque)
    continue
  }
  const { produto, erro } = casar(linha)
  if (erro === "sem") {
    semPar.push(linha)
    continue
  }
  if (erro) {
    ambiguos.push(linha)
    continue
  }
  const qtd = numero(linha.nu_saldo_qtd)
  if (Number.isFinite(qtd)) alvos.set(`${produto.id}|${loja}`, { produtoId: produto.id, loja, alvo: qtd })
  if (!linhasPorProduto.has(produto.id)) linhasPorProduto.set(produto.id, [])
  linhasPorProduto.get(produto.id).push({ ...linha, loja })
}

// ---------------------------------------------------------------------------
// Preço e custo
// ---------------------------------------------------------------------------
const produtoPorId = new Map(produtos.map((p) => [p.id, p]))
const mudancasPreco = []
const custos = []
const vendaDivergente = []

for (const [produtoId, ls] of linhasPorProduto) {
  const produto = produtoPorId.get(produtoId)

  const vendas = [...new Set(ls.map((l) => numero(l.vr_venda)).filter((v) => v > 0))]
  if (vendas.length > 1) vendaDivergente.push(produto.codigo)
  const venda = ls.map((l) => numero(l.vr_venda)).find((v) => v > 0)
  if (venda && Math.abs(arredondar(venda, 2) - produto.preco) >= 0.005) {
    mudancasPreco.push({ produto, de: produto.preco, para: arredondar(venda, 2) })
  }

  const contagem = new Map()
  for (const l of ls) {
    const c = numero(l.vr_custo)
    if (c > 0) contagem.set(c, (contagem.get(c) ?? 0) + 1)
  }
  if (contagem.size === 0) continue
  const maior = Math.max(...contagem.values())
  const empatados = [...contagem].filter(([, q]) => q === maior).map(([c]) => c)
  const daMatriz = numero(ls.find((l) => l.loja === "QI")?.vr_custo)
  const custo = empatados.includes(daMatriz) ? daMatriz : empatados[0]
  custos.push({ produto, custo: arredondar(custo) })
}

const comboQuebrado = mudancasPreco.filter((m) => m.produto.precoCombo != null && m.produto.precoCombo >= m.para)

// ---------------------------------------------------------------------------
// Saldo
// ---------------------------------------------------------------------------
const atual = new Map(
  (await db.movimentoEstoque.groupBy({ by: ["produtoId", "loja"], _sum: { quantidade: true } })).map((g) => [
    `${g.produtoId}|${g.loja}`,
    g._sum.quantidade ?? 0,
  ])
)
// Fora do arquivo: vai a zero.
for (const [chave, q] of atual) {
  if (q !== 0 && !alvos.has(chave)) {
    const [produtoId, loja] = chave.split("|")
    alvos.set(chave, { produtoId, loja, alvo: 0, foraDoArquivo: true })
  }
}

const ajustes = []
for (const [chave, a] of alvos) {
  const diferenca = arredondar(a.alvo - (atual.get(chave) ?? 0))
  if (diferenca !== 0) ajustes.push({ ...a, diferenca })
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const datas = linhas.map((l) => l.dt_saldo ?? "").filter(Boolean).sort()
console.log(`ARQUIVO: ${arquivoJson} · ${linhas.length} linhas · saldo mais recente ${datas.at(-1)}`)
console.log(`catálogo: ${produtos.length} produtos · ${linhasPorProduto.size} casados com o arquivo\n`)

console.log("SALDO")
console.log("  loja   ajustes   unidades no fim   negativos   zerados (fora do arquivo)")
const porLoja = {}
for (const a of alvos.values()) {
  porLoja[a.loja] ??= { ajustes: 0, unidades: 0, negativos: 0, fora: 0 }
  porLoja[a.loja].unidades += a.alvo
  if (a.alvo < 0) porLoja[a.loja].negativos++
  if (a.foraDoArquivo) porLoja[a.loja].fora++
}
for (const a of ajustes) porLoja[a.loja].ajustes++
for (const [loja, g] of Object.entries(porLoja).sort()) {
  console.log(
    `  ${loja.padEnd(5)} ${n(g.ajustes)} ${g.unidades.toFixed(0).padStart(17)} ${String(g.negativos).padStart(11)} ${String(g.fora).padStart(11)}`
  )
}

console.log(`\nPREÇO: ${mudancasPreco.length} produtos mudam de preço`)
for (const m of mudancasPreco.slice(0, 15)) {
  console.log(`  ${m.produto.codigo.padEnd(6)} ${String(m.de).padStart(9)} → ${String(m.para).padEnd(9)} ${m.produto.descricao}`)
}
if (mudancasPreco.length > 15) console.log(`  … e mais ${mudancasPreco.length - 15}`)
if (vendaDivergente.length) console.log(`  ⚠ venda diferente entre lojas (vale a primeira): ${vendaDivergente.join(", ")}`)
if (comboQuebrado.length) {
  console.log(`  ⚠ ${comboQuebrado.length} com preço de combo ≥ novo preço (combo fica como está):`)
  for (const m of comboQuebrado) console.log(`    ${m.produto.codigo} combo ${m.produto.precoCombo} · novo ${m.para}`)
}

const custoMuda = custos.filter((c) => c.produto.custo !== c.custo)
console.log(`\nCUSTO: ${custos.length} produtos recebem custo (${custoMuda.length} diferentes do que está gravado)`)

console.log("\nFORA:")
const codigosSem = [...new Set(semPar.map((l) => String(l.id_produto).trim()))]
console.log(`  ${codigosSem.length} códigos do arquivo sem produto no catálogo (${semPar.filter((l) => numero(l.nu_saldo_qtd) !== 0).length} linhas com saldo)`)
console.log(`  ${ambiguos.length} linhas com código repetido sem desempate`)
if (localDesconhecido.size) console.log(`  locais não mapeados: ${[...localDesconhecido].join(", ")}`)
const comSaldoSemPar = semPar.filter((l) => numero(l.nu_saldo_qtd) !== 0)
for (const l of comSaldoSemPar.slice(0, 15)) {
  console.log(`    sem produto: ${LOJAS[l.id_local_estoque]} cod ${l.id_produto} ${numero(l.nu_saldo_qtd)} ${l.unidade_medida} ${l.descricao}`)
}

if (!gravar) {
  console.log("\n--- ENSAIO: nada foi gravado. Rode com --gravar para valer. ---")
  await db.$disconnect()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Gravação: backup primeiro
// ---------------------------------------------------------------------------
const responsavel = await db.usuario.findFirst({
  where: { papel: "gerente", ativo: true },
  orderBy: { criadoEm: "asc" },
  select: { id: true, nome: true },
})
if (!responsavel) throw new Error("nenhum gerente ativo para assinar as alterações de preço")

mkdirSync("backups", { recursive: true })
const carimbo = new Date().toISOString().replace(/[:.]/g, "-")
const destino = `backups/precos-e-saldos-${carimbo}.json`
writeFileSync(
  destino,
  JSON.stringify(
    {
      produtos: produtos.map((p) => ({ id: p.id, codigo: p.codigo, preco: p.preco, custo: p.custo, custoEm: p.custoEm })),
      saldos: Object.fromEntries(atual),
    },
    null,
    1
  )
)
console.log(`\nbackup: ${destino}`)

const agora = new Date()
let feitos = 0
for (const m of mudancasPreco) {
  await db.$transaction([
    db.produto.update({ where: { id: m.produto.id }, data: { preco: m.para } }),
    db.alteracaoDePreco.create({
      data: { produtoId: m.produto.id, de: m.de, para: m.para, operador: OPERADOR, operadorId: responsavel.id },
    }),
  ])
  process.stdout.write(`\r  preços ${++feitos}/${mudancasPreco.length}`)
}
console.log()

feitos = 0
for (const c of custos) {
  await db.produto.update({ where: { id: c.produto.id }, data: { custo: c.custo, custoEm: agora } })
  if (++feitos % 50 === 0 || feitos === custos.length) process.stdout.write(`\r  custos ${feitos}/${custos.length}`)
}
console.log()

const datado = datas.at(-1)
for (let i = 0; i < ajustes.length; i += 200) {
  const fatia = ajustes.slice(i, i + 200)
  await db.movimentoEstoque.createMany({
    data: fatia.map((a) => ({
      produtoId: a.produtoId,
      loja: a.loja,
      tipo: "ajuste",
      quantidade: a.diferenca,
      operador: OPERADOR,
      observacao: a.foraDoArquivo
        ? `Fora de ${arquivo}: zerado`
        : `Saldo de ${arquivo} (${datado}) · ${a.loja} ficou com ${a.alvo}`,
    })),
  })
  process.stdout.write(`\r  ajustes ${Math.min(i + 200, ajustes.length)}/${ajustes.length}`)
}
console.log()

// Confere pelo LIVRO, não pelo que acreditamos ter gravado.
const depois = new Map(
  (await db.movimentoEstoque.groupBy({ by: ["produtoId", "loja"], _sum: { quantidade: true } })).map((g) => [
    `${g.produtoId}|${g.loja}`,
    g._sum.quantidade ?? 0,
  ])
)
const divergentes = [...alvos.values()].filter(
  ({ produtoId, loja, alvo }) => Math.round(((depois.get(`${produtoId}|${loja}`) ?? 0) - alvo) * 10000) !== 0
)
const sobrando = [...depois].filter(([k, q]) => q !== 0 && !alvos.has(k))
console.log(`\nconferência: ${alvos.size - divergentes.length} de ${alvos.size} saldos batem · ${sobrando.length} saldos fora do arquivo`)
for (const d of divergentes.slice(0, 20)) {
  console.log(`  DIVERGE ${d.loja} ${d.produtoId}: arquivo ${d.alvo}, livro ${depois.get(`${d.produtoId}|${d.loja}`) ?? 0}`)
}
console.log(`preços assinados por ${responsavel.nome}`)

await db.$disconnect()
