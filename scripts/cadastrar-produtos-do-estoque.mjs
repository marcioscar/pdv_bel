/**
 * Cadastra os produtos que o arquivo de estoque do sistema antigo tem COM
 * saldo e o catálogo daqui não tem — fora as encomendas.
 *
 *   node scripts/cadastrar-produtos-do-estoque.mjs dados/<arquivo>.json          # ensaio
 *   node scripts/cadastrar-produtos-do-estoque.mjs dados/<arquivo>.json --gravar # grava
 *
 * Pedido do Marcio (20/10/2026), depois de `substituir-precos-e-saldos.mjs`
 * deixar de fora os códigos sem produto: mercadoria de prateleira que está nas
 * lojas e não podia ser vendida pelo PDV.
 *
 * - **Só com saldo, só fora do grupo Encomenda.** Código parado no sistema
 *   antigo não precisa de cadastro; encomenda é feita para um cliente e não
 *   volta (ver `GrupoDeProduto`).
 * - **Tudo do arquivo:** descrição, unidade, preço, custo (o mais repetido
 *   entre as lojas, empate fica com a QI), grupo e o saldo de cada loja, como
 *   AJUSTE.
 * - **Sem NCM.** O arquivo não traz, e a venda no caixa não depende dele; a
 *   nota fiscal desses produtos depende.
 * - Rodar duas vezes não duplica: código + unidade já no catálogo é pulado.
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
  console.error("uso: node scripts/cadastrar-produtos-do-estoque.mjs <arquivo.json> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")
const arquivo = arquivoJson.split("/").pop()
const OPERADOR = `Importação de ${arquivo}`
const GRUPO_ENCOMENDA = "19"
/** "PRODUTO TESTE SEMPRE" do sistema antigo: cadastrado aqui, seria vendável. */
const IGNORAR = new Set(["300"])

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

const db = new PrismaClient()
const linhas = JSON.parse(readFileSync(arquivoJson, "utf8").replace(/^﻿/, ""))
const catalogo = new Set(
  (await db.produto.findMany({ select: { codigo: true, unidade: true } })).map(
    (p) => `${p.codigo.trim()}|${p.unidade.toUpperCase()}`
  )
)
const codigosNoCatalogo = new Set([...catalogo].map((k) => k.split("|")[0]))
const grupos = new Map((await db.grupoDeProduto.findMany()).map((g) => [g.codigo, g]))

const porChave = new Map()
for (const l of linhas) {
  const codigo = String(l.id_produto).trim()
  if (codigosNoCatalogo.has(codigo) || IGNORAR.has(codigo)) continue
  const chave = `${codigo}|${String(l.unidade_medida).trim().toUpperCase()}`
  if (!porChave.has(chave)) porChave.set(chave, [])
  porChave.get(chave).push(l)
}

const novos = []
for (const [chave, ls] of porChave) {
  const grupoCodigo = String(ls[0].id_grupo).split(" - ")[0].trim()
  if (grupoCodigo === GRUPO_ENCOMENDA) continue
  const saldos = ls
    .map((l) => ({ loja: LOJAS[l.id_local_estoque], quantidade: numero(l.nu_saldo_qtd) }))
    .filter((s) => s.loja && Number.isFinite(s.quantidade) && s.quantidade !== 0)
  if (saldos.length === 0) continue

  const contagem = new Map()
  for (const l of ls) {
    const c = numero(l.vr_custo)
    if (c > 0) contagem.set(c, (contagem.get(c) ?? 0) + 1)
  }
  let custo = null
  if (contagem.size > 0) {
    const maior = Math.max(...contagem.values())
    const empatados = [...contagem].filter(([, q]) => q === maior).map(([c]) => c)
    const daMatriz = numero(ls.find((l) => LOJAS[l.id_local_estoque] === "QI")?.vr_custo)
    custo = arredondar(empatados.includes(daMatriz) ? daMatriz : empatados[0])
  }

  const [codigo, unidade] = chave.split("|")
  novos.push({
    codigo,
    unidade,
    descricao: String(ls[0].descricao).trim(),
    preco: arredondar(Math.max(...ls.map((l) => numero(l.vr_venda) || 0)), 2),
    custo,
    grupo: grupos.get(grupoCodigo) ?? null,
    grupoArquivo: ls[0].id_grupo,
    saldos,
  })
}

console.log(`ARQUIVO: ${arquivoJson}`)
console.log(`A CADASTRAR: ${novos.length} produtos\n`)
for (const p of novos.sort((a, b) => a.grupoArquivo.localeCompare(b.grupoArquivo))) {
  const saldos = p.saldos.map((s) => `${s.loja} ${s.quantidade}`).join(", ")
  console.log(
    `  ${p.codigo.padEnd(6)} ${p.unidade.padEnd(3)} ${String(p.preco).padStart(8)} custo ${String(p.custo ?? "—").padStart(8)}  ${(p.grupo?.nome ?? `⚠ ${p.grupoArquivo}`).padEnd(22)} ${p.descricao}  [${saldos}]`
  )
}
const semPreco = novos.filter((p) => !(p.preco > 0))
const semGrupo = novos.filter((p) => !p.grupo)
if (semPreco.length) console.log(`\n⚠ ${semPreco.length} sem preço de venda: ${semPreco.map((p) => p.codigo).join(", ")}`)
if (semGrupo.length) console.log(`⚠ ${semGrupo.length} com grupo que não existe aqui (entram sem grupo)`)

if (!gravar) {
  console.log("\n--- ENSAIO: nada foi gravado. Rode com --gravar para valer. ---")
  await db.$disconnect()
  process.exit(0)
}

const agora = new Date()
let movimentos = 0
for (const p of novos) {
  const produto = await db.produto.create({
    data: {
      codigo: p.codigo,
      descricao: p.descricao,
      unidade: p.unidade,
      preco: p.preco,
      ...(p.custo ? { custo: p.custo, custoEm: agora } : {}),
      ...(p.grupo ? { grupoId: p.grupo.id } : {}),
    },
  })
  await db.movimentoEstoque.createMany({
    data: p.saldos.map((s) => ({
      produtoId: produto.id,
      loja: s.loja,
      tipo: "ajuste",
      quantidade: s.quantidade,
      operador: OPERADOR,
      observacao: `Cadastro com saldo de ${arquivo} · ${s.loja} ficou com ${s.quantidade}`,
    })),
  })
  movimentos += p.saldos.length
}
console.log(`\ncadastrados: ${novos.length} produtos · ${movimentos} saldos gravados`)

await db.$disconnect()
