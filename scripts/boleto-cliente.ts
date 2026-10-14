import { db } from "~/lib/db.server"
import { chamarInter, interConfigurado } from "~/lib/inter.server"

/**
 * SÓ LEITURA: por que um boleto do sistema antigo não aparece em Inadimplentes.
 *
 * 1. O que a base do PDV tem de TODAS as filiais do cliente (raiz do CNPJ).
 * 2. O que o Inter tem, em cada conta, com vencimento no período pedido.
 *
 * uso: npx tsx --env-file=.env scripts/boleto-cliente.ts <CNPJ ou CPF> <de AAAA-MM-DD> <até AAAA-MM-DD>
 */
const [documento, de, ate] = process.argv.slice(2)
if (!documento || !de || !ate) {
  console.log("uso: npx tsx --env-file=.env scripts/boleto-cliente.ts <CNPJ ou CPF> <de AAAA-MM-DD> <até AAAA-MM-DD>")
  process.exit(1)
}
const digitos = documento.replace(/\D/g, "")
// CNPJ: as filiais têm a mesma raiz (8 primeiros dígitos). CPF fica inteiro.
const RAIZ = digitos.length === 14 ? digitos.slice(0, 8) : digitos
const dia = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-"

console.log("=== 1. Base do PDV (boletos_externos) ===")
const naBase = await db.boletoExterno.findMany({
  where: {
    pagadorCpfCnpj: { startsWith: RAIZ },
  },
  orderBy: { vencimento: "asc" },
})
for (const b of naBase) {
  console.log(
    [
      b.conta,
      b.pagadorCpfCnpj,
      `seu=${b.seuNumero ?? "-"}`,
      `nosso=${b.nossoNumero ?? "-"}`,
      `venc=${dia(b.vencimento)}`,
      `R$ ${b.valor.toFixed(2)}`,
      b.situacao,
      `conferido=${b.conferidoEm.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
      b.baixadoEm ? `BAIXADO ${dia(b.baixadoEm)} por ${b.baixadoPor}` : "",
    ]
      .filter(Boolean)
      .join("  ")
  )
}
console.log(`${naBase.length} boleto(s) do cliente na base\n`)

console.log(`=== 2. Inter, vencimento de ${de} a ${ate} ===`)
const lojas = await db.loja.findMany({ select: { conta: true } })
const contas = [...new Set(lojas.map((l) => l.conta))].filter(interConfigurado)

type Item = {
  cobranca: {
    codigoSolicitacao?: string
    seuNumero?: string
    situacao: string
    dataVencimento?: string
    valorNominal: string | number
    pagador: { nome: string; cpfCnpj: string }
  }
  boleto?: { nossoNumero?: string }
}

for (const conta of contas) {
  const achados: Item[] = []
  for (let pagina = 0; ; pagina++) {
    const busca = new URLSearchParams({
      dataInicial: de,
      dataFinal: ate,
      filtrarDataPor: "VENCIMENTO",
      "paginacao.itensPorPagina": "1000",
      "paginacao.paginaAtual": String(pagina),
    })
    const r = await chamarInter<{ ultimaPagina?: boolean; cobrancas: Item[] }>(
      `/cobranca/v3/cobrancas?${busca}`,
      { conta, escopos: ["boleto-cobranca.read"] }
    )
    const lote = r?.cobrancas ?? []
    achados.push(
      ...lote.filter((i) =>
        (i.cobranca.pagador?.cpfCnpj ?? "").replace(/\D/g, "").startsWith(RAIZ)
      )
    )
    if (r?.ultimaPagina !== false || lote.length < 1000) break
  }
  console.log(`-- conta ${conta}: ${achados.length} do cliente`)
  for (const i of achados) {
    const c = i.cobranca
    console.log(
      `   ${c.pagador.cpfCnpj}  seu=${c.seuNumero ?? "-"}  nosso=${i.boleto?.nossoNumero ?? "-"}  ` +
        `venc=${c.dataVencimento}  R$ ${Number(c.valorNominal).toFixed(2)}  ${c.situacao}  ` +
        `cod=${c.codigoSolicitacao}`
    )
  }
}

await db.$disconnect()
