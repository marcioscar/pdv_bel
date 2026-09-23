/**
 * Importa o histórico de vendas do sistema antigo para `vendas_antigas`.
 *
 *   node scripts/importar-vendas-antigas.mjs dados/vendas.json dados/clientes.json          # ensaio
 *   node scripts/importar-vendas-antigas.mjs dados/vendas.json dados/clientes.json --gravar # grava
 *
 * Não cria Venda. Estoque, caixa, comissão e painel não enxergam esta coleção —
 * ela existe só para o diálogo de histórico do cliente responder "o que ele
 * levou da última vez" com o que foi comprado antes do sistema novo.
 *
 * O que entra e o que fica de fora:
 *
 * 1. **Só cliente identificado.** Oito em cada dez linhas são "CONSUMIDOR
 *    FINAL": não há de quem ser histórico, e agrupá-las por dia inventaria
 *    compras que misturam dezenas de pessoas.
 *
 * 2. **Transferência entre lojas não é compra.** A forma "TRANSFERENCIA ENTRE
 *    LOJAS" leva a Plastibra, a Sacobras e a filial como "clientes" — é
 *    mercadoria mudando de prateleira dentro da rede.
 *
 * 3. **Pedido "Em Digitação" não aconteceu.** Ficou aberto no sistema antigo.
 *    Cancelada entra, marcada: quem pergunta pelo pedido precisa saber que ele
 *    foi desfeito, e o diálogo já mostra cancelada riscada.
 *
 * 4. **A compra é reconstruída.** O arquivo é uma linha por item, sem número
 *    de pedido. Agrupa por dia, pessoa, loja, forma, vendedor, documento e
 *    status — dois pedidos iguais no mesmo dia viram um.
 *
 * 5. **O cliente é achado pelo documento.** O arquivo de vendas traz o código
 *    da pessoa no sistema antigo; o de clientes diz o CPF/CNPJ desse código; e
 *    o CPF/CNPJ acha o cadastro daqui. Os ids do sistema antigo não foram
 *    guardados na importação de clientes — o documento é a ponte.
 *
 * 6. **Pedido "Faturada" fica.** Só 2 dos 21 têm nota com os mesmos itens em
 *    até 30 dias; os outros não aparecem de outra forma no arquivo.
 *
 * 7. **`a_peso` é a quantidade.** `a_qtd_volumes` é sempre 0 ou 1; unitário ×
 *    peso − desconto fecha com o total em todas as linhas do arquivo.
 */
import { createHash } from "node:crypto"
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

const [arquivoVendas, arquivoClientes, ...opcoes] = process.argv.slice(2)
if (!arquivoVendas || !arquivoClientes) {
  console.error(
    "uso: node scripts/importar-vendas-antigas.mjs <vendas.json> <clientes.json> [--gravar]"
  )
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")

const soDigitos = (s) => (s ?? "").replace(/\D/g, "")
/**
 * O arquivo de vendas veio com UTF-8 lido como Windows-1252 e regravado:
 * "JosÃ©", "COMÃ‰RCIO". Desfeito byte a byte volta ao que era — só quando a
 * volta não produz caractere inválido; texto que já estava certo fica.
 *
 * Windows-1252, e não Latin-1: o "É" vira "Ã‰", e "‰" só existe no 1252.
 */
const CP1252 = new Map(
  [..."€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ"].map((c, i) => [c, 0x80 + i])
)
function consertar(s) {
  if (!/[ÃÂ]/.test(s)) return s
  const bytes = [...s].map((c) => CP1252.get(c) ?? c.charCodeAt(0))
  if (bytes.some((b) => b > 0xff)) return s
  const volta = Buffer.from(bytes).toString("utf8")
  return volta.includes("\uFFFD") ? s : volta
}
const limpo = (s) => consertar(s ?? "").replace(/\s+/g, " ").trim()
const centavos = (n) => Math.round(n * 100) / 100

/** "4 - CARTAO DE CREDITO VISA" → "CARTAO DE CREDITO VISA". */
const semCodigo = (s) => limpo(s).replace(/^\d+\s*-\s*/, "")

/** Os mesmos dígitos verificadores de app/lib/documento.ts. */
function validarCpf(c) {
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false
  for (const n of [9, 10]) {
    let soma = 0
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i)
    if (((soma * 10) % 11) % 10 !== Number(c[n])) return false
  }
  return true
}
function validarCnpj(c) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false
  const base = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  for (const n of [12, 13]) {
    const pesos = base.slice(base.length - n)
    let soma = 0
    for (let i = 0; i < n; i++) soma += Number(c[i]) * pesos[i]
    const resto = soma % 11
    if ((resto < 2 ? 0 : 11 - resto) !== Number(c[n])) return false
  }
  return true
}

/** A mesma leitura de scripts/importar-clientes.mjs — tem que dar o mesmo documento. */
const PARECE_EMPRESA = /\b(BANCO|LTDA|S\.?\/?A|EIRELI|ME|EPP)\b/i
function documento(bruto, nome) {
  const d = soDigitos(bruto)
  if (!d || /^0+$/.test(d)) return null
  if (d.length < 14 && PARECE_EMPRESA.test(nome) && validarCnpj(d.padStart(14, "0"))) {
    return d.padStart(14, "0")
  }
  if (d.length <= 11 && validarCpf(d.padStart(11, "0"))) return d.padStart(11, "0")
  if (d.length <= 14 && validarCnpj(d.padStart(14, "0"))) return d.padStart(14, "0")
  return null
}

const LOJA_DO_CENTRO = { 1: "QI", 2: "QNE", 3: "NRT", 4: "SDS" }

const linhas = JSON.parse(readFileSync(arquivoVendas, "utf8"))
const pessoas = JSON.parse(readFileSync(arquivoClientes, "utf8"))

const documentoDaPessoa = new Map(
  pessoas.map((p) => [
    p.nu_id_pessoa,
    documento(p.tx_cnpj_cpf, limpo(p.tx_razao_social) || limpo(p.tx_nm_fantasia)),
  ])
)

const fora = { consumidorFinal: 0, transferencia: 0, emDigitacao: 0, lojaDesconhecida: 0 }
const compras = new Map()

for (const l of linhas) {
  const [pessoaCodigo, ...resto] = l.a_id_pessoa.split(" - ")
  if (pessoaCodigo.trim() === "1") {
    fora.consumidorFinal++
    continue
  }
  if (/TRANSFERENCIA ENTRE LOJAS/i.test(l.a_id_forma)) {
    fora.transferencia++
    continue
  }
  if (/digita/i.test(l.a_status)) {
    fora.emDigitacao++
    continue
  }
  const loja = LOJA_DO_CENTRO[parseInt(l.a_id_centro_custo)]
  if (!loja) {
    fora.lojaDesconhecida++
    continue
  }

  const partes = [
    l.a_dt_venda,
    pessoaCodigo.trim(),
    loja,
    l.a_id_forma,
    l.a_id_vendedor,
    l.a_tipo_pedido,
    l.a_status,
  ]
  const chave = createHash("sha1").update(partes.join("|")).digest("hex")

  let compra = compras.get(chave)
  if (!compra) {
    const vendedor = semCodigo(l.a_id_vendedor)
    compra = {
      chave,
      pessoaCodigo: pessoaCodigo.trim(),
      // "RAZÃO - FANTASIA": a primeira metade é a razão social.
      pessoaNome: limpo(resto[0] ?? ""),
      loja,
      // Meio-dia de Brasília: a data cai no mesmo dia em qualquer fuso de tela,
      // e ordena junto das vendas do sistema novo sem fingir uma hora exata.
      data: new Date(`${l.a_dt_venda}T12:00:00-03:00`),
      forma: semCodigo(l.a_id_forma),
      documento: limpo(l.a_tipo_pedido),
      status: limpo(l.a_status),
      cancelada: /cancel/i.test(l.a_status),
      vendedorNome: vendedor && vendedor !== "PADRAO" ? vendedor : null,
      itens: [],
    }
    compras.set(chave, compra)
  }

  compra.itens.push({
    codigo: limpo(l.a_id_produto),
    descricao: limpo(l.desc_prod_item),
    quantidade: Number(l.a_peso),
    preco: Number(l.a_vr_unitario),
    desconto: Number(l.a_vr_desconto),
    subtotal: Number(l.a_vr_total),
  })
}

const lista = [...compras.values()]
for (const c of lista) {
  c.total = centavos(c.itens.reduce((s, i) => s + i.subtotal, 0))
  c.desconto = centavos(c.itens.reduce((s, i) => s + i.desconto, 0))
}

const db = new PrismaClient()

const clientePorDocumento = new Map(
  (await db.cliente.findMany({ select: { id: true, cpfCnpj: true } })).map((c) => [
    c.cpfCnpj,
    c.id,
  ])
)
// Ativo primeiro: se o código se repetir, o que está à venda hoje é o que o
// "repetir no caixa" deve pôr no carrinho.
const produtoPorCodigo = new Map()
for (const p of await db.produto.findMany({
  select: { id: true, codigo: true, unidade: true, ativo: true },
  orderBy: { ativo: "asc" },
})) {
  produtoPorCodigo.set(p.codigo, p)
}

const semCadastro = new Map()
for (const c of lista) {
  const doc = documentoDaPessoa.get(c.pessoaCodigo)
  c.clienteId = (doc && clientePorDocumento.get(doc)) || null
  if (!c.clienteId) semCadastro.set(c.pessoaCodigo, c.pessoaNome)
  c.itens = c.itens.map((item) => {
    const produto = produtoPorCodigo.get(item.codigo)
    return { ...item, produtoId: produto?.id ?? null, unidade: produto?.unidade ?? "PC" }
  })
}

const itens = lista.flatMap((c) => c.itens)
const validas = lista.filter((c) => !c.cancelada)
const clientesComHistorico = new Set(lista.filter((c) => c.clienteId).map((c) => c.clienteId))
const datas = lista.map((c) => c.data.getTime())

console.log(`arquivo: ${arquivoVendas}`)
console.log()
console.log(`  linhas no arquivo ............ ${linhas.length}`)
console.log(`    consumidor final ........... ${fora.consumidorFinal}  (fora)`)
console.log(`    transferência entre lojas .. ${fora.transferencia}  (fora)`)
console.log(`    em digitação ............... ${fora.emDigitacao}  (fora)`)
if (fora.lojaDesconhecida) console.log(`    loja desconhecida .......... ${fora.lojaDesconhecida}  (fora)`)
console.log(`    itens de cliente ........... ${itens.length}`)
console.log()
console.log(`  compras reconstruídas ........ ${lista.length}`)
console.log(`    canceladas ................. ${lista.length - validas.length}`)
console.log(`    valor (sem canceladas) ..... R$ ${centavos(validas.reduce((s, c) => s + c.total, 0)).toLocaleString("pt-BR")}`)
console.log(`    período .................... ${new Date(Math.min(...datas)).toLocaleDateString("pt-BR")} a ${new Date(Math.max(...datas)).toLocaleDateString("pt-BR")}`)
console.log(`  clientes com histórico ....... ${clientesComHistorico.size}`)
console.log(`  pessoas sem cadastro aqui .... ${semCadastro.size}  (${lista.filter((c) => !c.clienteId).length} compras guardadas sem vínculo)`)
console.log(`  itens com produto no catálogo  ${itens.filter((i) => i.produtoId).length} de ${itens.length}`)

if (semCadastro.size) {
  console.log()
  console.log("pessoas sem cadastro aqui:")
  for (const [codigo, nome] of semCadastro) console.log(`  ${codigo}  ${nome}`)
}

if (!gravar) {
  console.log()
  console.log("ENSAIO — nada gravado. Use --gravar para aplicar.")
  await db.$disconnect()
  process.exit(0)
}

// Os índices não nascem com o deploy (o build só roda `prisma generate`):
// criados aqui, onde são necessários. createIndexes é idempotente.
await db.$runCommandRaw({
  createIndexes: "vendas_antigas",
  indexes: [
    { key: { chave: 1 }, name: "chave_1", unique: true },
    { key: { clienteId: 1, data: 1 }, name: "clienteId_1_data_1" },
  ],
})

const existentes = new Set(
  (await db.vendaAntiga.findMany({ select: { chave: true } })).map((v) => v.chave)
)
const novas = lista.filter((c) => !existentes.has(c.chave))

let criadas = 0
for (let i = 0; i < novas.length; i += 500) {
  const { count } = await db.vendaAntiga.createMany({ data: novas.slice(i, i + 500) })
  criadas += count
}

console.log()
console.log(`GRAVADO: ${criadas} compras criadas, ${lista.length - novas.length} já existiam.`)
await db.$disconnect()
