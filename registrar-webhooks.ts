import { registrarWebhooks, consultarWebhooks } from "~/lib/inter.server"

const url = process.argv[2]
if (!url) {
  console.log("uso: npx tsx registrar-webhooks.ts https://seu-dominio.com.br")
  console.log("\nwebhooks atuais:")
  console.log(JSON.stringify(await consultarWebhooks(), null, 2))
  process.exit(0)
}

console.log("registrando webhooks para", url)
await registrarWebhooks(url)
console.log("\nconfirmando no Inter:")
console.log(JSON.stringify(await consultarWebhooks(), null, 2))
