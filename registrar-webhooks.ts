import { consultarWebhooks, registrarWebhookCobranca } from "~/lib/inter.server"

/**
 * Registra o webhook de Cobrança. O de Pix não é gerenciado aqui: a chave Pix
 * desta conta é compartilhada com outro sistema da empresa, e o Inter aceita um
 * destino por chave.
 */
const url = process.argv[2]

if (!url) {
  console.log("uso: npx tsx registrar-webhooks.ts https://seu-dominio.com.br")
  console.log("\nwebhooks atuais:")
  console.log(JSON.stringify(await consultarWebhooks(), null, 2))
  process.exit(0)
}

const r = await registrarWebhookCobranca(url)
console.log("cobrança ->", r.webhookUrl, r.anterior ? `(antes: ${r.anterior})` : "(novo)")
console.log("\nconfirmando:")
console.log(JSON.stringify(await consultarWebhooks(), null, 2))
