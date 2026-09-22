/**
 * Apaga os LANÇAMENTOS do PDV e deixa o sistema pronto para o primeiro dia.
 *
 *   node scripts/zerar-lancamentos.mjs          # ensaio
 *   node scripts/zerar-lancamentos.mjs --gravar # grava
 *
 * Serve para o dia em que o sistema sai do teste e entra em produção: o
 * movimento de ensaio some, a numeração volta ao 1, e o que fica é cadastro e
 * a posição de estoque.
 *
 * **O que NÃO é tocado, e por quê:**
 *
 * - `movimentos_estoque` — é a posição inicial, importada na mesma virada. É
 *   justamente o que se quer preservar.
 * - `receitas` e `despesas` — NÃO são deste sistema. São do brassacoAdm, com
 *   anos de histórico, e é delas que saem o faturamento e a margem do painel.
 *   Apagar aqui quebraria o outro sistema.
 * - notas recebidas, documentos da SEFAZ e o cursor de sincronização — é o que
 *   o fisco já entregou. Apagar faria a próxima sincronização baixar tudo de
 *   novo, gastando a cota de consulta por nada.
 * - `politicas_de_compra` e `fornecimentos` — derivados do histórico do sistema
 *   antigo. É deles que vivem a curva ABC e a tela de compras.
 * - cadastros em geral: produto, cliente, fornecedor, loja, usuário, grupo, NCM.
 *
 * **Os contadores voltam a zero**, então a próxima venda de cada loja é a #1.
 * Sem isso, o primeiro dia começaria na #27 sem nada antes dela.
 *
 * O dump vem ANTES de apagar, e nada é apagado enquanto ele não estiver em
 * disco. É irreversível de outro jeito.
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

const gravar = process.argv.includes("--gravar")
const db = new PrismaClient()

/** O que sai. A ordem não importa: o Mongo não tem chave estrangeira. */
const APAGAR = [
  ["venda", "vendas (com os itens dentro)"],
  ["notaFiscalEmitida", "notas fiscais emitidas"],
  ["devolucao", "devoluções"],
  ["transferencia", "transferências"],
  ["movimentoCaixa", "movimentos de caixa"],
  ["fechamentoCaixa", "fechamentos de caixa"],
  ["cobranca", "cobranças / boletos"],
  ["movimentoCredito", "créditos de cliente"],
  ["autorizacao", "autorizações de venda"],
  ["autorizacaoDeFaturamento", "AFs (entrada sem nota)"],
  ["pedidoDeCompra", "pedidos de compra"],
  ["alteracaoDePreco", "alterações de preço"],
  ["contador", "contadores de numeração"],
]

const contagens = {}
for (const [modelo] of APAGAR) contagens[modelo] = await db[modelo].count()
const total = Object.values(contagens).reduce((s, n) => s + n, 0)

console.log("A APAGAR:")
for (const [modelo, nome] of APAGAR) {
  console.log(`  ${String(contagens[modelo]).padStart(6)}  ${nome}`)
}
console.log(`  ${String(total).padStart(6)}  TOTAL`)

console.log("\nPRESERVADO:")
for (const [modelo, nome] of [
  ["movimentoEstoque", "movimentos de estoque (a posição inicial)"],
  ["receita", "receitas — do sistema de contas"],
  ["despesa", "despesas — do sistema de contas"],
  ["notaFiscalRecebida", "notas recebidas de fornecedor"],
  ["documentoDistribuido", "documentos da SEFAZ"],
  ["sincronizacaoSefaz", "cursor de sincronização"],
  ["politicaDeCompra", "política de compra (curva ABC)"],
  ["fornecimento", "fornecimentos"],
  ["produto", "produtos"],
  ["cliente", "clientes"],
  ["fornecedor", "fornecedores"],
  ["usuario", "usuários"],
  ["loja", "lojas"],
  ["grupoDeProduto", "grupos de produto"],
]) {
  console.log(`  ${String(await db[modelo].count()).padStart(6)}  ${nome}`)
}

if (!gravar) {
  console.log("\n--- ENSAIO: nada foi apagado. Rode com --gravar para valer. ---")
  await db.$disconnect()
  process.exit(0)
}

// O dump primeiro, e só depois o apagar.
mkdirSync("backups", { recursive: true })
const carimbo = new Date().toISOString().replace(/[:.]/g, "-")
const dump = {}
for (const [modelo] of APAGAR) dump[modelo] = await db[modelo].findMany()
const destino = `backups/lancamentos-${carimbo}.json`
writeFileSync(destino, JSON.stringify(dump, null, 1))
console.log(`\nbackup: ${destino}`)

let apagados = 0
for (const [modelo, nome] of APAGAR) {
  const r = await db[modelo].deleteMany({})
  apagados += r.count
  if (r.count > 0) console.log(`  ${String(r.count).padStart(6)}  ${nome}`)
}
console.log(`\napagados: ${apagados}`)

const sobrou = {}
for (const [modelo] of APAGAR) sobrou[modelo] = await db[modelo].count()
const resto = Object.values(sobrou).reduce((s, n) => s + n, 0)
console.log(`restam nas coleções apagadas: ${resto}`)
console.log(`movimentos de estoque intactos: ${await db.movimentoEstoque.count()}`)

await db.$disconnect()
