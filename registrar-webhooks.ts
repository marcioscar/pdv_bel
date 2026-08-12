import { consultarWebhooks, registrarWebhookCobranca } from "~/lib/inter.server"

/**
 * Registra o webhook de Cobrança. O de Pix não é gerenciado aqui: a chave Pix
 * desta conta é compartilhada com outro sistema da empresa, e o Inter aceita um
 * destino por chave.
 */
// A conta é obrigatória: são três, e registrar na conta errada aponta o retorno
// de pagamento de uma loja para a outra.
const conta = process.argv[2]
const url = process.argv[3]

if (!conta) {
  console.log("uso: npx tsx registrar-webhooks.ts <CONTA> [https://dominio]")
  console.log("     CONTA é o código em ContaInter: MATRIZ, NRT ou SDS")
  process.exit(1)
}

if (!url) {
  console.log(`webhooks atuais da conta ${conta}:`)
  console.log(JSON.stringify(await consultarWebhooks(conta), null, 2))
  process.exit(0)
}

const r = await registrarWebhookCobranca(conta, url)
console.log("cobrança ->", r.webhookUrl, r.anterior ? `(antes: ${r.anterior})` : "(novo)")
console.log("\nconfirmando:")
console.log(JSON.stringify(await consultarWebhooks(conta), null, 2))
