export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const

export type TipoPessoa = "FISICA" | "JURIDICA"

/** Tira máscara e normaliza: o CNPJ alfanumérico usa letras maiúsculas. */
export function limparDocumento(valor: string) {
  return valor.toUpperCase().replace(/[^0-9A-Z]/g, "")
}

/**
 * Dígito verificador de CPF/CNPJ. Cada caractere entra como `código ASCII − 48`,
 * o que dá 0–9 para dígitos e 17–42 para letras — é exatamente a regra do CNPJ
 * alfanumérico, que passou a ser emitido em 2026. Para documentos só numéricos o
 * resultado é idêntico ao cálculo tradicional.
 */
function digito(base: string, pesos: number[]) {
  const soma = base
    .split("")
    .reduce((acc, char, i) => acc + (char.charCodeAt(0) - 48) * pesos[i], 0)

  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

function repetido(valor: string) {
  return new Set(valor).size === 1
}

export function validarCpf(bruto: string) {
  const cpf = limparDocumento(bruto)
  if (!/^\d{11}$/.test(cpf) || repetido(cpf)) return false

  const d1 = digito(cpf.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = digito(cpf.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2])

  return cpf === cpf.slice(0, 9) + d1 + d2
}

export function validarCnpj(bruto: string) {
  const cnpj = limparDocumento(bruto)
  // 12 posições alfanuméricas + 2 dígitos verificadores, sempre numéricos.
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || repetido(cnpj)) return false

  const d1 = digito(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = digito(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])

  return cnpj === cnpj.slice(0, 12) + d1 + d2
}

export function validarCpfCnpj(bruto: string) {
  const doc = limparDocumento(bruto)
  if (doc.length === 11) return validarCpf(doc)
  if (doc.length === 14) return validarCnpj(doc)
  return false
}

export function tipoPessoaDe(bruto: string): TipoPessoa | null {
  const doc = limparDocumento(bruto)
  if (doc.length === 11) return "FISICA"
  if (doc.length === 14) return "JURIDICA"
  return null
}

export function formatarCpfCnpj(bruto: string) {
  const doc = limparDocumento(bruto)

  if (doc.length === 11) {
    return `${doc.slice(0, 3)}.${doc.slice(3, 6)}.${doc.slice(6, 9)}-${doc.slice(9)}`
  }
  if (doc.length === 14) {
    return `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5, 8)}/${doc.slice(8, 12)}-${doc.slice(12)}`
  }
  return doc
}

export function limparCep(bruto: string) {
  return bruto.replace(/\D/g, "")
}

export function validarCep(bruto: string) {
  return /^\d{8}$/.test(limparCep(bruto))
}

export function formatarCep(bruto: string) {
  const cep = limparCep(bruto)
  return cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep
}

export function validarUf(bruto: string) {
  return (UFS as readonly string[]).includes(bruto.toUpperCase())
}

/**
 * Máscara de digitação: formata o que já foi digitado, sem exigir o documento
 * completo. Até 11 caracteres é CPF; daí para cima, CNPJ — que desde 2026 pode
 * trazer letras nas doze primeiras posições.
 */
export function mascararCpfCnpj(bruto: string) {
  const doc = limparDocumento(bruto).slice(0, 14)

  if (doc.length <= 11 && !/[A-Z]/.test(doc)) {
    return doc
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4")
  }

  return doc
    .replace(/^([0-9A-Z]{2})([0-9A-Z])/, "$1.$2")
    .replace(/^([0-9A-Z]{2})\.([0-9A-Z]{3})([0-9A-Z])/, "$1.$2.$3")
    .replace(/^([0-9A-Z]{2})\.([0-9A-Z]{3})\.([0-9A-Z]{3})([0-9A-Z])/, "$1.$2.$3/$4")
    .replace(
      /^([0-9A-Z]{2})\.([0-9A-Z]{3})\.([0-9A-Z]{3})\/([0-9A-Z]{4})([0-9A-Z])/,
      "$1.$2.$3/$4-$5"
    )
}

/** Máscara de digitação do CEP: 99999-999. */
export function mascararCep(bruto: string) {
  const cep = limparCep(bruto).slice(0, 8)
  return cep.length > 5 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep
}

/** Máscara de digitação do telefone, sem DDD: 99999-9999 ou 9999-9999. */
export function mascararTelefone(bruto: string) {
  const numero = bruto.replace(/\D/g, "").slice(0, 9)
  if (numero.length <= 4) return numero
  const corte = numero.length > 8 ? 5 : 4
  return `${numero.slice(0, corte)}-${numero.slice(corte)}`
}

/**
 * Inscrição estadual: só dígitos, ou a palavra ISENTO. O formato varia por UF
 * (de 8 a 14 dígitos, com regras de dígito verificador diferentes em cada uma),
 * então aqui só se guarda o que foi digitado, sem máscara — validar as 27 regras
 * seria prometer uma conferência que este cadastro não faz.
 */
export function limparInscricaoEstadual(bruto: string) {
  const valor = bruto.trim().toUpperCase()
  if (/^ISENT[AO]$/.test(valor)) return "ISENTO"
  return valor.replace(/\D/g, "")
}

export function validarInscricaoEstadual(bruto: string) {
  const ie = limparInscricaoEstadual(bruto)
  return ie === "ISENTO" || /^\d{8,14}$/.test(ie)
}
