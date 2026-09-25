import {
  consultarWebhooks,
  registrarWebhookCobranca,
  registrarWebhookPix,
} from "~/lib/inter.server"

/**
 * Registra o webhook de Cobrança e, com `--pix`, o de Pix.
 *
 * O de Pix só vai na chave ALEATÓRIA criada para o PDV: a chave antiga é
 * compartilhada com outro sistema da empresa, e o Inter aceita um destino por
 * chave. `registrarWebhookPix` recusa qualquer outra.
 */
// A conta é obrigatória: são três, e registrar na conta errada aponta o retorno
// de pagamento de uma loja para a outra.
const conta = process.argv[2]
const url = process.argv[3]

if (!conta) {
  console.log("uso: npx tsx registrar-webhooks.ts <CONTA> [https://dominio] [--pix]")
  console.log("     CONTA é o código em ContaInter: MATRIZ, NRT ou SDS")
  process.exit(1)
}

if (!url) {
  console.log(`webhooks atuais da conta ${conta}:`)
  console.log(JSON.stringify(await consultarWebhooks(conta), null, 2))
  process.exit(0)
}

if (process.argv.includes("--pix")) {
  const r = await registrarWebhookPix(conta, url)
  console.log(`pix (${r.chave}) ->`, r.webhookUrl, r.anterior ? `(antes: ${r.anterior})` : "(novo)")
} else {
  const r = await registrarWebhookCobranca(conta, url)
  console.log("cobrança ->", r.webhookUrl, r.anterior ? `(antes: ${r.anterior})` : "(novo)")
}
console.log("\nconfirmando:")
console.log(JSON.stringify(await consultarWebhooks(conta), null, 2))
