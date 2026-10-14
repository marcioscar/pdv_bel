import { db } from "~/lib/db.server"
import { chamarInter, interConfigurado } from "~/lib/inter.server"

/**
 * SÓ LEITURA: o tamanho dos boletos EXPIRADOS no Inter — vencidos, fora do
 * prazo de pagamento do boleto e sem registro de pagamento.
 *
 * Hoje eles não contam em Inadimplentes nem travam a venda a prazo. Este
 * script mostra quanto passaria a contar, por conta e por ano de vencimento,
 * e os maiores devedores, para decidir se (e desde quando) devem entrar.
 *
 * uso: npx tsx --env-file=.env scripts/boletos-expirados.ts
 */
type Item = {
  cobranca: {
    situacao: string
    dataVencimento?: string
    valorNominal: string | number
    pagador: { nome: string; cpfCnpj: string }
  }
}

async function janela(conta: string, de: string, ate: string): Promise<Item[]> {
  const todas: Item[] = []
  for (let pagina = 0; ; pagina++) {
    const busca = new URLSearchParams({
      dataInicial: de,
      dataFinal: ate,
      filtrarDataPor: "VENCIMENTO",
      situacao: "EXPIRADO",
      "paginacao.itensPorPagina": "1000",
      "paginacao.paginaAtual": String(pagina),
    })
    const r = await chamarInter<{ ultimaPagina?: boolean; cobrancas: Item[] }>(
      `/cobranca/v3/cobrancas?${busca}`,
      { conta, escopos: ["boleto-cobranca.read"] }
    )
    const lote = r?.cobrancas ?? []
    todas.push(...lote)
    if (r?.ultimaPagina !== false || lote.length < 1000) break
  }
  return todas
}

const lojas = await db.loja.findMany({ select: { conta: true } })
const contas = [...new Set(lojas.map((l) => l.conta))].filter(interConfigurado)
const hoje = new Date().toISOString().slice(0, 10)
const anoAtual = Number(hoje.slice(0, 4))

const todos: (Item & { conta: string })[] = []
for (const conta of contas) {
  // Ano a ano: a consulta do Inter recusa janelas longas.
  for (let ano = 2015; ano <= anoAtual; ano++) {
    const ate = ano === anoAtual ? hoje : `${ano}-12-31`
    for (const i of await janela(conta, `${ano}-01-01`, ate)) todos.push({ ...i, conta })
  }
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })

console.log("=== Expirados por conta e ano de vencimento ===")
const porContaAno = new Map<string, { n: number; v: number }>()
for (const i of todos) {
  const chave = `${i.conta} ${i.cobranca.dataVencimento?.slice(0, 4)}`
  const g = porContaAno.get(chave) ?? { n: 0, v: 0 }
  g.n++
  g.v += Number(i.cobranca.valorNominal)
  porContaAno.set(chave, g)
}
for (const [chave, g] of [...porContaAno].sort()) {
  console.log(`${chave.padEnd(12)} ${String(g.n).padStart(5)} boletos  ${brl(g.v).padStart(16)}`)
}
const total = todos.reduce((s, i) => s + Number(i.cobranca.valorNominal), 0)
console.log(`TOTAL        ${String(todos.length).padStart(5)} boletos  ${brl(total).padStart(16)}`)

console.log("\n=== 20 maiores devedores em expirados (pela raiz do CNPJ) ===")
const porCliente = new Map<string, { nome: string; n: number; v: number; ultimo: string }>()
for (const i of todos) {
  const doc = i.cobranca.pagador.cpfCnpj.replace(/\D/g, "")
  const chave = doc.length === 14 ? doc.slice(0, 8) : doc
  const g = porCliente.get(chave) ?? { nome: i.cobranca.pagador.nome, n: 0, v: 0, ultimo: "" }
  g.n++
  g.v += Number(i.cobranca.valorNominal)
  if ((i.cobranca.dataVencimento ?? "") > g.ultimo) g.ultimo = i.cobranca.dataVencimento ?? ""
  porCliente.set(chave, g)
}
for (const g of [...porCliente.values()].sort((a, b) => b.v - a.v).slice(0, 20)) {
  console.log(
    `${g.nome.slice(0, 40).padEnd(40)} ${String(g.n).padStart(4)} bol.  ${brl(g.v).padStart(14)}  último venc. ${g.ultimo}`
  )
}
console.log(`\n${porCliente.size} clientes com boleto expirado`)

await db.$disconnect()
