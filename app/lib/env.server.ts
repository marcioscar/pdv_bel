import { existsSync, readFileSync } from "node:fs"

/**
 * Preenche o `process.env` a partir do .env, para desenvolvimento.
 *
 * Duas regras, ambas aprendidas na prática:
 *
 * 1. **O ambiente ganha do arquivo.** Só chaves ausentes são preenchidas. Antes
 *    o .env sobrescrevia, e um arquivo esquecido no servidor passaria a mandar na
 *    configuração de produção sem ninguém notar.
 * 2. **Não dá para confiar em NODE_ENV aqui.** Este módulo é carregado antes de o
 *    `react-router-serve` definir NODE_ENV=production, então a checagem por
 *    ambiente não protege nada nesse instante — a regra 1 é que protege.
 */
const ARQUIVO = ".env"

if (existsSync(ARQUIVO)) {
  for (const linha of readFileSync(ARQUIVO, "utf8").split("\n")) {
    const texto = linha.trim()
    if (!texto || texto.startsWith("#")) continue

    const separador = texto.indexOf("=")
    if (separador < 1) continue

    const chave = texto.slice(0, separador).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) continue
    if (process.env[chave] !== undefined) continue

    let valor = texto.slice(separador + 1).trim()
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1)
    }
    process.env[chave] = valor
  }
}

/**
 * O endereço público do sistema, para montar link que sai daqui — hoje, o da
 * fila de autorizações que vai no aviso do Telegram.
 *
 * `APP_URL` vem primeiro porque o link precisa funcionar no celular de quem
 * recebe, e o que o servidor enxerga do request não serve: atrás do proxy do
 * easypanel o `request.url` chega como `http://0.0.0.0:3000`, um endereço que só
 * existe dentro do container. Os cabeçalhos do proxy são o segundo melhor
 * palpite, e o request cru é o último recurso — em desenvolvimento ele é o certo.
 */
export function enderecoDoApp(request: Request) {
  const configurado = process.env.APP_URL?.trim()
  if (configurado) return configurado.replace(/\/+$/, "")

  const url = new URL(request.url)
  const host = request.headers.get("x-forwarded-host") ?? url.host
  const protocolo = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")
  return `${protocolo}://${host}`
}
