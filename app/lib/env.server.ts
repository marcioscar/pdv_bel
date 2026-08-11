import { existsSync } from "node:fs"

/**
 * Carrega o .env para `process.env` em desenvolvimento.
 *
 * Até aqui o app funcionava porque o Prisma Client carrega o .env como efeito
 * colateral ao ser instanciado — o que só valia para quem importasse o Prisma
 * antes, e por acaso. Em produção não há .env: as variáveis vêm do ambiente.
 */
const ARQUIVO = ".env"

if (process.env.NODE_ENV !== "production" && existsSync(ARQUIVO)) {
  process.loadEnvFile(ARQUIVO)
}

export {}
