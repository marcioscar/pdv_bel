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

export {}
