/**
 * Importa os grupos de produto do sistema antigo e prende cada produto ao seu.
 *
 *   node scripts/importar-grupos.mjs dados/produtos.json          # ensaio
 *   node scripts/importar-grupos.mjs dados/produtos.json --gravar # grava
 *
 * O arquivo é o export de produtos do sistema antigo, com "Cód. Produto",
 * "Grupo" e "Descrição Grupo" em cada linha. Os grupos saem de lá por dedução:
 * não existe um arquivo só deles, mas cada produto carrega o par código/nome.
 *
 * Quatro decisões:
 *
 * 1. **A chave do grupo é o código, não o nome.** O nome é editável na tela
 *    ("Papel Higiênico " tem um espaço sobrando, e alguém vai corrigir). Casar
 *    por nome faria a próxima importação criar um grupo novo ao lado do
 *    corrigido.
 *
 * 2. **A chave do produto é o `codigo`.** É como todo o resto do sistema casa
 *    com o legado. Os 55 códigos repetidos do catálogo não atrapalham: nenhum
 *    código do arquivo aparece com dois grupos diferentes — foi conferido — e
 *    portanto os homônimos vão todos para a mesma gaveta.
 *
 * 3. **"Encomenda" nasce com `tipo: "encomenda"`.** É o único grupo cujo
 *    conteúdo não é mercadoria de prateleira, e é justamente o que precisa
 *    ficar fora da curva ABC. A tela permite mudar depois; o que o script não
 *    faz é MEXER no tipo de um grupo que já existe — a classificação passa a
 *    ser humana no instante em que alguém a revisa.
 *
 * 4. **Não desfaz vínculo.** Produto que o arquivo não menciona fica com o
 *    grupo que tiver. Rodar de novo com um export parcial não pode esvaziar a
 *    classificação do catálogo inteiro.
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

const [arquivo, ...opcoes] = process.argv.slice(2)
if (!arquivo) {
  console.error("uso: node scripts/importar-grupos.mjs <produtos.json> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")

const db = new PrismaClient()

// O BOM do export do sistema antigo vira um caractere invisível na primeira
// chave do primeiro objeto, e "Cód. Produto" deixa de ser encontrado.
const linhas = JSON.parse(readFileSync(arquivo, "utf8").replace(/^﻿/, ""))

/** código do grupo → { nome, produtos: [código do produto] } */
const doArquivo = new Map()
let semGrupo = 0

for (const linha of linhas) {
  const codigoGrupo = String(linha["Grupo"] ?? "").trim()
  const nome = String(linha["Descrição Grupo"] ?? "").trim()
  const codigoProduto = String(linha["Cód. Produto"] ?? "").trim()

  if (!codigoGrupo || !nome) {
    semGrupo++
    continue
  }
  // Conjunto, e não lista: o arquivo repete 55 códigos em linhas diferentes, e
  // contá-los duas vezes daria um relatório maior que o catálogo.
  if (!doArquivo.has(codigoGrupo)) doArquivo.set(codigoGrupo, { nome, produtos: new Set() })
  if (codigoProduto) doArquivo.get(codigoGrupo).produtos.add(codigoProduto)
}

const existentes = await db.grupoDeProduto.findMany()
const porCodigo = new Map(existentes.map((g) => [g.codigo, g]))

const produtos = await db.produto.findMany({ select: { id: true, codigo: true, grupoId: true } })
const produtosPorCodigo = new Map()
for (const p of produtos) {
  const c = p.codigo.trim()
  if (!produtosPorCodigo.has(c)) produtosPorCodigo.set(c, [])
  produtosPorCodigo.get(c).push(p)
}

console.log(`Arquivo: ${linhas.length} linhas, ${doArquivo.size} grupos, ${semGrupo} sem grupo`)
console.log(`Banco: ${produtos.length} produtos, ${existentes.length} grupos já cadastrados\n`)

let criados = 0
let renomeados = 0
let vinculos = 0
let jaVinculados = 0
let semProduto = 0

/** Produtos já tratados nesta rodada, para nenhum ser contado duas vezes. */
const tratados = new Set()

const ordenados = [...doArquivo.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))

for (const [codigo, { nome, produtos: codigosDoGrupo }] of ordenados) {
  const existente = porCodigo.get(codigo)
  // Só na criação: revisar o tipo é trabalho humano, e a próxima importação
  // não pode desfazê-lo.
  const tipo = /encomenda/i.test(nome) ? "encomenda" : "padrao"

  let grupoId = existente?.id ?? null
  if (!existente) {
    criados++
    if (gravar) {
      const criado = await db.grupoDeProduto.create({ data: { codigo, nome, tipo } })
      grupoId = criado.id
    }
  } else if (existente.nome !== nome) {
    renomeados++
    if (gravar) await db.grupoDeProduto.update({ where: { id: existente.id }, data: { nome } })
  }

  let aVincular = 0
  for (const codigoProduto of codigosDoGrupo) {
    const achados = produtosPorCodigo.get(codigoProduto)
    if (!achados) {
      semProduto++
      continue
    }
    for (const p of achados) {
      if (tratados.has(p.id)) continue
      tratados.add(p.id)
      if (p.grupoId && p.grupoId === grupoId) {
        jaVinculados++
        continue
      }
      aVincular++
      if (gravar && grupoId) {
        await db.produto.update({ where: { id: p.id }, data: { grupoId } })
      }
    }
  }
  vinculos += aVincular

  const marca = existente ? (existente.nome !== nome ? "renomeia" : "existe  ") : "cria    "
  console.log(
    `${marca} ${codigo.padStart(3)} ${nome.padEnd(28)} ${String(aVincular).padStart(5)} produtos`
  )
}

const semNenhum = produtos.filter((p) => !p.grupoId && !tratados.has(p.id)).length
console.log(
  `\n${criados} grupo(s) a criar · ${renomeados} a renomear · ${vinculos} vínculo(s) de produto` +
    ` · ${jaVinculados} já no lugar`
)
console.log(
  `${semProduto} linha(s) do arquivo sem produto no catálogo · ` +
    `${semNenhum} produto(s) do catálogo ainda sem grupo`
)
if (!gravar) console.log("\nEnsaio: nada foi gravado. Rode com --gravar para valer.")

await db.$disconnect()
