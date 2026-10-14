import { db } from "~/lib/db.server"

/**
 * SÓ LEITURA: lista os Pix do caixa desde a fila em segundo plano.
 *
 * Destaca os "falhou" — Pix pago sem venda gravada — e os pedidos guardados
 * sem código de vendedor, que é o sintoma do bug corrigido em cdb2b51.
 *
 * uso: npx tsx --env-file=.env scripts/pix-falhos.ts
 */
const lista = await db.pixPendente.findMany({ orderBy: { criadoEm: "asc" } })

const hora = (d: Date | null) =>
  d ? d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-"

for (const p of lista) {
  const pedido = p.pedido as { vendedorCodigo?: string; emitirNota?: boolean }
  const semVendedor = !pedido.vendedorCodigo
  const marca = p.situacao === "falhou" ? "!!" : semVendedor ? "? " : "  "
  console.log(
    [
      marca,
      hora(p.criadoEm),
      p.loja,
      p.situacao.padEnd(10),
      `R$ ${p.total.toFixed(2)}`.padEnd(12),
      `vendedor=${pedido.vendedorCodigo || "(vazio)"}`,
      `nota=${pedido.emitirNota ? "sim" : "não"}`,
      p.vendaNumero ? `venda #${p.vendaNumero}` : "",
      p.pagoEm ? `pago ${hora(p.pagoEm)}` : "",
      `txid=${p.txid}`,
      p.erro ? `\n     erro: ${p.erro}` : "",
    ]
      .filter(Boolean)
      .join("  ")
  )
}

const falhos = lista.filter((p) => p.situacao === "falhou")
console.log(`\n${lista.length} Pix na fila · ${falhos.length} pago(s) SEM venda (!!)`)
await db.$disconnect()
