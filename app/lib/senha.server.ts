import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const derivar = promisify(scrypt) as (
  senha: string,
  sal: Buffer,
  tamanho: number,
  opcoes: { N: number; r: number; p: number }
) => Promise<Buffer>

/**
 * scrypt do próprio Node: sem dependência nativa, que complicaria o build do
 * Docker, e com custo de memória — o que encarece ataque por força bruta.
 * Parâmetros guardados no hash para poder aumentá-los depois sem invalidar
 * as senhas já cadastradas.
 */
const PARAMETROS = { N: 16384, r: 8, p: 1 }
const TAMANHO = 64

export const SENHA_MINIMA = 8

export async function gerarHash(senha: string) {
  const sal = randomBytes(16)
  const derivada = await derivar(senha, sal, TAMANHO, PARAMETROS)
  const { N, r, p } = PARAMETROS
  return `scrypt$${N}$${r}$${p}$${sal.toString("base64")}$${derivada.toString("base64")}`
}

export async function conferirSenha(senha: string, hash: string) {
  const partes = hash.split("$")
  if (partes.length !== 6 || partes[0] !== "scrypt") return false

  const [, N, r, p, salBase64, esperadoBase64] = partes
  const sal = Buffer.from(salBase64, "base64")
  const esperado = Buffer.from(esperadoBase64, "base64")

  const derivada = await derivar(senha, sal, esperado.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  })

  // timingSafeEqual para a comparação não vazar informação pelo tempo de resposta.
  return derivada.length === esperado.length && timingSafeEqual(derivada, esperado)
}

export function validarSenha(senha: string) {
  if (senha.length < SENHA_MINIMA) {
    return `A senha precisa de pelo menos ${SENHA_MINIMA} caracteres`
  }
  return null
}

export function normalizarEmail(email: string) {
  return email.trim().toLowerCase()
}

export function validarEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizarEmail(email))
}
