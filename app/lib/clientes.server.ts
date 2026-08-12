import { db } from "~/lib/db.server"
import {
  limparCep,
  limparDocumento,
  tipoPessoaDe,
  validarCep,
  validarCpfCnpj,
  validarUf,
} from "~/lib/documento"

export type ClienteEntrada = {
  nome: string
  cpfCnpj: string
  endereco: string
  bairro: string
  cidade: string
  uf: string
  cep: string
  numero?: string
  complemento?: string
  email?: string
  ddd?: string
  telefone?: string
}

export type ResultadoCliente =
  | { ok: true; cliente: Awaited<ReturnType<typeof db.cliente.create>> }
  | { ok: false; erro: string; campo?: keyof ClienteEntrada }

function texto(valor: FormDataEntryValue | null) {
  return typeof valor === "string" ? valor.trim() : ""
}

export function lerCliente(form: FormData): ClienteEntrada {
  return {
    nome: texto(form.get("nome")),
    cpfCnpj: texto(form.get("cpfCnpj")),
    endereco: texto(form.get("endereco")),
    bairro: texto(form.get("bairro")),
    cidade: texto(form.get("cidade")),
    uf: texto(form.get("uf")),
    cep: texto(form.get("cep")),
    numero: texto(form.get("numero")) || undefined,
    complemento: texto(form.get("complemento")) || undefined,
    email: texto(form.get("email")) || undefined,
    ddd: texto(form.get("ddd")) || undefined,
    telefone: texto(form.get("telefone")) || undefined,
  }
}

/**
 * Valida o que o boleto vai exigir. É melhor recusar aqui, no cadastro, do que
 * descobrir na emissão que o endereço está incompleto e a cobrança foi rejeitada.
 *
 * Compartilhada entre criar e atualizar: se fossem duas listas, editar um cliente
 * poderia deixá-lo com menos dados do que o cadastro aceita.
 */
function validarEntrada(entrada: ClienteEntrada): { ok: false; erro: string; campo?: keyof ClienteEntrada } | null {
  if (entrada.nome.length < 3) {
    return { ok: false, erro: "Informe o nome completo", campo: "nome" }
  }
  if (!validarCpfCnpj(entrada.cpfCnpj)) {
    return { ok: false, erro: "CPF/CNPJ inválido", campo: "cpfCnpj" }
  }
  if (entrada.endereco.length < 3) {
    return { ok: false, erro: "Informe o endereço", campo: "endereco" }
  }
  if (!entrada.bairro) return { ok: false, erro: "Informe o bairro", campo: "bairro" }
  if (!entrada.cidade) return { ok: false, erro: "Informe a cidade", campo: "cidade" }
  if (!validarUf(entrada.uf)) return { ok: false, erro: "UF inválida", campo: "uf" }
  if (!validarCep(entrada.cep)) {
    return { ok: false, erro: "CEP deve ter 8 dígitos", campo: "cep" }
  }
  return null
}

export async function criarCliente(entrada: ClienteEntrada): Promise<ResultadoCliente> {
  const problema = validarEntrada(entrada)
  if (problema) return problema

  const cpfCnpj = limparDocumento(entrada.cpfCnpj)
  const tipoPessoa = tipoPessoaDe(cpfCnpj)
  if (!tipoPessoa) return { ok: false, erro: "CPF/CNPJ inválido", campo: "cpfCnpj" }

  const jaExiste = await db.cliente.findUnique({ where: { cpfCnpj } })
  if (jaExiste) {
    return { ok: false, erro: `${jaExiste.nome} já está cadastrado`, campo: "cpfCnpj" }
  }

  const cliente = await db.cliente.create({
    data: {
      nome: entrada.nome,
      cpfCnpj,
      tipoPessoa,
      endereco: entrada.endereco,
      bairro: entrada.bairro,
      cidade: entrada.cidade,
      uf: entrada.uf.toUpperCase(),
      cep: limparCep(entrada.cep),
      numero: entrada.numero,
      complemento: entrada.complemento,
      email: entrada.email,
      ddd: entrada.ddd,
      telefone: entrada.telefone,
    },
  })

  return { ok: true, cliente }
}

export function listarClientes() {
  return db.cliente.findMany({ orderBy: { nome: "asc" } })
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * Atualiza o cadastro. Vale mais do que parece: endereço incompleto ou errado faz
 * o Inter recusar o boleto, e antes disto só havia como corrigir no banco à mão.
 *
 * As mesmas validações do cadastro, porque o boleto exige o mesmo dos dois.
 */
export async function atualizarCliente(
  id: string,
  entrada: ClienteEntrada
): Promise<ResultadoCliente> {
  if (!OBJECT_ID.test(id)) return { ok: false, erro: "Cliente inválido" }

  const existente = await db.cliente.findUnique({ where: { id } })
  if (!existente) return { ok: false, erro: "Cliente não encontrado" }

  const problema = validarEntrada(entrada)
  if (problema) return problema

  const cpfCnpj = limparDocumento(entrada.cpfCnpj)
  const tipoPessoa = tipoPessoaDe(cpfCnpj)
  if (!tipoPessoa) return { ok: false, erro: "CPF/CNPJ inválido", campo: "cpfCnpj" }

  // Trocar o documento para o de outro cadastro violaria o índice único.
  const outro = await db.cliente.findUnique({ where: { cpfCnpj } })
  if (outro && outro.id !== id) {
    return { ok: false, erro: `${outro.nome} já usa esse CPF/CNPJ`, campo: "cpfCnpj" }
  }

  const cliente = await db.cliente.update({
    where: { id },
    data: {
      nome: entrada.nome,
      cpfCnpj,
      tipoPessoa,
      endereco: entrada.endereco,
      bairro: entrada.bairro,
      cidade: entrada.cidade,
      uf: entrada.uf.toUpperCase(),
      cep: limparCep(entrada.cep),
      numero: entrada.numero ?? null,
      complemento: entrada.complemento ?? null,
      email: entrada.email ?? null,
      ddd: entrada.ddd ?? null,
      telefone: entrada.telefone ?? null,
    },
  })

  return { ok: true, cliente }
}
