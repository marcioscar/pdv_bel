import { db } from "~/lib/db.server"
import { limparDocumento, tipoPessoaDe, validarCpfCnpj } from "~/lib/documento"

export type FornecedorEntrada = {
  codigo: string
  razaoSocial: string
  nomeFantasia?: string
  cidade: string
  bairro: string
  documento?: string
  observacao?: string
}

export type ResultadoFornecedor =
  | { ok: true; fornecedor: Awaited<ReturnType<typeof db.fornecedor.create>> }
  | { ok: false; erro: string; campo?: keyof FornecedorEntrada }

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

function texto(valor: FormDataEntryValue | null) {
  return typeof valor === "string" ? valor.trim() : ""
}

export function lerFornecedor(form: FormData): FornecedorEntrada {
  return {
    codigo: texto(form.get("codigo")),
    razaoSocial: texto(form.get("razaoSocial")),
    nomeFantasia: texto(form.get("nomeFantasia")) || undefined,
    cidade: texto(form.get("cidade")),
    bairro: texto(form.get("bairro")),
    documento: texto(form.get("documento")) || undefined,
    observacao: texto(form.get("observacao")) || undefined,
  }
}

/**
 * O documento é opcional, mas mentira não passa.
 *
 * Onze cadastros vieram do sistema antigo com `000.000.000-00`. Exigir CNPJ
 * recusaria fornecedores reais que ninguém nunca completou; aceitar qualquer
 * coisa deixaria o placeholder entrar de novo pela tela, agora parecendo
 * documento de verdade. Vazio é vazio, e preenchido tem que ser válido.
 */
function validarEntrada(
  entrada: FornecedorEntrada
): { ok: false; erro: string; campo?: keyof FornecedorEntrada } | null {
  if (!entrada.codigo) {
    return { ok: false, erro: "Informe o código", campo: "codigo" }
  }
  if (entrada.razaoSocial.length < 2) {
    return { ok: false, erro: "Informe a razão social", campo: "razaoSocial" }
  }
  if (!entrada.cidade) return { ok: false, erro: "Informe a cidade", campo: "cidade" }
  if (!entrada.bairro) return { ok: false, erro: "Informe o bairro", campo: "bairro" }

  if (entrada.documento && !validarCpfCnpj(entrada.documento)) {
    return { ok: false, erro: "CNPJ/CPF inválido", campo: "documento" }
  }
  return null
}

/** Documento e tipo de pessoa, ou os dois nulos quando não há documento. */
function documentoDe(bruto?: string) {
  if (!bruto) return { documento: null, tipoPessoa: null }
  const limpo = limparDocumento(bruto)
  return { documento: limpo, tipoPessoa: tipoPessoaDe(limpo) }
}

export async function criarFornecedor(
  entrada: FornecedorEntrada
): Promise<ResultadoFornecedor> {
  const problema = validarEntrada(entrada)
  if (problema) return problema

  const jaExiste = await db.fornecedor.findUnique({ where: { codigo: entrada.codigo } })
  if (jaExiste) {
    return {
      ok: false,
      erro: `O código ${entrada.codigo} já é de ${jaExiste.nomeFantasia || jaExiste.razaoSocial}`,
      campo: "codigo",
    }
  }

  const fornecedor = await db.fornecedor.create({
    data: {
      codigo: entrada.codigo,
      razaoSocial: entrada.razaoSocial,
      nomeFantasia: entrada.nomeFantasia ?? null,
      cidade: entrada.cidade,
      bairro: entrada.bairro,
      observacao: entrada.observacao ?? null,
      ...documentoDe(entrada.documento),
    },
  })

  return { ok: true, fornecedor }
}

export async function atualizarFornecedor(
  id: string,
  entrada: FornecedorEntrada
): Promise<ResultadoFornecedor> {
  if (!OBJECT_ID.test(id)) return { ok: false, erro: "Fornecedor inválido" }

  const existente = await db.fornecedor.findUnique({ where: { id } })
  if (!existente) return { ok: false, erro: "Fornecedor não encontrado" }

  const problema = validarEntrada(entrada)
  if (problema) return problema

  // Trocar o código para o de outro cadastro violaria o índice único.
  const outro = await db.fornecedor.findUnique({ where: { codigo: entrada.codigo } })
  if (outro && outro.id !== id) {
    return {
      ok: false,
      erro: `O código ${entrada.codigo} já é de ${outro.nomeFantasia || outro.razaoSocial}`,
      campo: "codigo",
    }
  }

  const fornecedor = await db.fornecedor.update({
    where: { id },
    data: {
      codigo: entrada.codigo,
      razaoSocial: entrada.razaoSocial,
      nomeFantasia: entrada.nomeFantasia ?? null,
      cidade: entrada.cidade,
      bairro: entrada.bairro,
      observacao: entrada.observacao ?? null,
      ...documentoDe(entrada.documento),
    },
  })

  return { ok: true, fornecedor }
}

/**
 * Ordenados por quem comprou mais recentemente, e não por nome.
 *
 * Dos 128 cadastros, 69 nunca compraram nada. Em ordem alfabética eles se
 * misturam aos vivos e a lista vira um arquivo morto que alguém tem que
 * garimpar; por atividade, quem se usa toda semana está no topo.
 */
export function listarFornecedores({ incluirInativos = false } = {}) {
  return db.fornecedor.findMany({
    where: incluirInativos ? {} : { ativo: true },
    orderBy: [{ ultimaCompra: "desc" }, { razaoSocial: "asc" }],
  })
}

/** Desativa ou reativa. Não existe apagar. */
export async function alternarFornecedor(id: string) {
  if (!OBJECT_ID.test(id)) return { ok: false as const, erro: "Fornecedor inválido" }

  const fornecedor = await db.fornecedor.findUnique({ where: { id } })
  if (!fornecedor) return { ok: false as const, erro: "Fornecedor não encontrado" }

  const atualizado = await db.fornecedor.update({
    where: { id },
    data: { ativo: !fornecedor.ativo },
  })
  const nome = atualizado.nomeFantasia || atualizado.razaoSocial
  return {
    ok: true as const,
    mensagem: `${nome} ${atualizado.ativo ? "reativado" : "desativado"}`,
  }
}
