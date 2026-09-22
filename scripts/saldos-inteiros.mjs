/**
 * Tira a casa decimal dos saldos, para o estoque voltar a ser contável.
 *
 *   node scripts/saldos-inteiros.mjs                      # ensaio
 *   node scripts/saldos-inteiros.mjs --gravar             # trunca e grava
 *   node scripts/saldos-inteiros.mjs --arredondar --gravar
 *
 * **Truncar é o padrão porque foi o pedido**: "usar somente a parte inteira".
 * Vale saber o que isso custa — truncar descarta a fração inteira, então 0,78
 * vira zero e 71,9 vira 71. Arredondar preservaria mais, e a opção existe para
 * quem quiser trocar depois de ver a conta.
 *
 * Negativo trunca PARA ZERO, não para baixo: −0,66 vira 0, não −1. Um estoque
 * que não existe é zero; inventar uma unidade negativa para "arredondar
 * corretamente" seria piorar o dado para agradar a matemática.
 *
 * Corrige o PRÓPRIO movimento da posição inicial em vez de lançar um ajuste em
 * cima. Os dois seriam defensáveis, mas aqui não há movimento nenhum depois da
 * importação — nenhuma venda, nenhuma entrada — então isto não reescreve
 * história: é a mesma contagem, sem o lixo decimal. Duas linhas na ficha do
 * produto para consertar um dado que nunca chegou a ser usado seria ruído.
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
const arredondar = process.argv.includes("--arredondar")
const inteiro = (n) => (arredondar ? Math.round(n) : Math.trunc(n))

const db = new PrismaClient()

const produtos = await db.produto.findMany({ select: { id: true, codigo: true, descricao: true } })
const porId = new Map(produtos.map((p) => [p.id, p]))

const saldos = await db.movimentoEstoque.groupBy({
  by: ["produtoId", "loja"],
  _sum: { quantidade: true },
})

const fracionarios = saldos.filter((s) => {
  const q = s._sum.quantidade ?? 0
  return q !== 0 && Math.abs(q - Math.round(q)) > 1e-9
})

console.log(`modo: ${arredondar ? "ARREDONDAR" : "TRUNCAR (parte inteira)"}`)
console.log(`${fracionarios.length} saldos com casa decimal\n`)

let perdidas = 0
let zeram = 0
const planos = []

for (const s of fracionarios) {
  const atual = s._sum.quantidade ?? 0
  const alvo = inteiro(atual)
  const produto = porId.get(s.produtoId)
  if (!produto) continue

  /*
   * Um movimento só por produto/loja é o esperado, porque a posição inicial foi
   * importada agora e nada se moveu depois. Se houver mais de um, o script NÃO
   * escolhe qual reescrever — lança um ajuste, que é a forma correta de
   * corrigir um livro que já tem história.
   */
  const movimentos = await db.movimentoEstoque.findMany({
    where: { produtoId: s.produtoId, loja: s.loja },
    select: { id: true, tipo: true, quantidade: true },
  })

  perdidas += atual - alvo
  if (alvo === 0) zeram++

  planos.push({
    produtoId: s.produtoId,
    loja: s.loja,
    codigo: produto.codigo,
    descricao: produto.descricao,
    atual,
    alvo,
    unico: movimentos.length === 1 ? movimentos[0] : null,
    quantos: movimentos.length,
  })
}

for (const p of planos.sort((a, b) => Math.abs(b.atual) - Math.abs(a.atual))) {
  const como = p.unico ? "corrige" : `ajuste (${p.quantos} movimentos)`
  console.log(
    `  ${p.codigo.padStart(6)} ${p.loja.padEnd(4)} ${p.atual.toFixed(4).padStart(10)} → ` +
      `${String(p.alvo).padStart(5)}  ${como.padEnd(22)} ${p.descricao.slice(0, 38)}`
  )
}

console.log(`\nunidades descartadas: ${perdidas.toFixed(4)}`)
console.log(`saldos que ficam em zero: ${zeram}`)

if (!gravar) {
  console.log("\n--- ENSAIO: nada foi gravado. Rode com --gravar para valer. ---")
  await db.$disconnect()
  process.exit(0)
}

let corrigidos = 0
let ajustados = 0

for (const p of planos) {
  if (p.unico) {
    const nova = p.unico.quantidade - (p.atual - p.alvo)
    await db.movimentoEstoque.update({
      where: { id: p.unico.id },
      data: { quantidade: Math.round(nova * 10000) / 10000 },
    })
    corrigidos++
  } else {
    await db.movimentoEstoque.create({
      data: {
        produtoId: p.produtoId,
        loja: p.loja,
        tipo: "ajuste",
        quantidade: Math.round((p.alvo - p.atual) * 10000) / 10000,
        operador: "Correção de saldo fracionário",
        observacao: `De ${p.atual} para ${p.alvo}: produto não se vende fracionado`,
      },
    })
    ajustados++
  }
}

console.log(`\nmovimentos corrigidos: ${corrigidos} · ajustes lançados: ${ajustados}`)

const depois = await db.movimentoEstoque.groupBy({
  by: ["produtoId", "loja"],
  _sum: { quantidade: true },
})
const sobrou = depois.filter((s) => {
  const q = s._sum.quantidade ?? 0
  return q !== 0 && Math.abs(q - Math.round(q)) > 1e-9
})
console.log(`saldos fracionários restantes: ${sobrou.length}`)

await db.$disconnect()
