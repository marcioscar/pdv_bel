import type { Prisma } from "@prisma/client"

import { db } from "~/lib/db.server"
import { meioDiaDe } from "~/lib/dia"
import { arredondar } from "~/lib/moeda"
import { resumoDoProcNFe } from "~/lib/sefaz.server"

/**
 * Gera contas a pagar (`Despesa`) a partir das duplicatas da NF-e — a coleção
 * `despesas` não nasceu com este projeto, é do sistema de contas a pagar que a
 * rede já usa (mesmo lugar onde alguém anexa boleto e comprovante). Aqui só
 * criamos o título a partir do que a nota prometeu pagar; o resto do ciclo
 * (marcar pago, anexar arquivo) continua sendo feito lá.
 */

export type ParcelaDaNota = {
  numero: string | null
  vencimento: string | null
  valor: number
}

/** As parcelas que a própria nota já declara — o ponto de partida da tela de geração. */
export function duplicatasDaNota(xml: string): {
  numeroFatura: string | null
  duplicatas: ParcelaDaNota[]
} {
  const resumo = resumoDoProcNFe(xml)
  if (!resumo) return { numeroFatura: null, duplicatas: [] }
  return { numeroFatura: resumo.numeroFatura, duplicatas: resumo.duplicatas }
}

/** As categorias já cadastradas no sistema de contas a pagar — fonte da lista da tela. */
export function categoriasDeDespesa() {
  return db.categoriaDeDespesa.findMany()
}

/**
 * O nome que vai no campo `fornecedor` da despesa — o nome fantasia do
 * cadastro (`Fornecedor.nomeFantasia`), não a razão social em caixa alta da
 * NF-e. É o nome curto que o sistema de contas a pagar já usa há anos
 * ("VABENE", "G-UTIL", "plazapel"): usar o da nota criaria um fornecedor com
 * cara diferente do que já existe no histórico, para a mesma empresa.
 *
 * Sem cadastro (documento não encontrado), cai no nome da nota mesmo — e diz
 * isso explicitamente, para quem está gerando saber que está usando o nome
 * "errado" por falta de opção, não por escolha.
 */
export async function fornecedorParaDespesa(
  emitenteCnpj: string,
  emitenteNomeDaNota: string
): Promise<{ nome: string; temCadastro: boolean }> {
  const fornecedor = await db.fornecedor.findFirst({ where: { documento: emitenteCnpj } })
  if (!fornecedor) return { nome: emitenteNomeDaNota, temCadastro: false }
  return { nome: fornecedor.nomeFantasia || fornecedor.razaoSocial, temCadastro: true }
}

export type LinhaDeDespesa = {
  conta: string
  tipo: string
  descricao: string
  valor: number
  data: string
  contaCorrente: string | null
}

export type ResultadoGerarDespesas = { ok: true; quantidade: number } | { ok: false; erro: string }

/**
 * De qual documento de entrada nasce a conta a pagar.
 *
 * Dois, hoje: a NF-e do fornecedor e a AF (autorização de faturamento), que é o
 * papel de quem entrega sem emitir nota. A tela é a mesma nos dois casos — o
 * que muda é de onde saem fornecedor, loja e a marca de "já gerada", e é só
 * isso que este tipo separa.
 */
export type DocumentoDeDespesa = { tipo: "nota" | "af"; id: string }

/**
 * Grava as despesas de uma vez e marca o documento — feito junto para nunca
 * deixar a nota "meio gerada": ou as duplicatas todas viram título a pagar, ou
 * nenhuma vira, sem meio-termo que confundiria quem concilia depois.
 *
 * Recusa gerar de novo para o mesmo documento: duplicar título a pagar é o tipo
 * de erro que só aparece quando alguém já pagou os dois.
 */
export async function gerarDespesas(
  documento: DocumentoDeDespesa,
  linhas: LinhaDeDespesa[],
  operador: string
): Promise<ResultadoGerarDespesas> {
  if (linhas.length === 0) return { ok: false, erro: "Nenhuma linha para gerar" }

  const origem = await origemDaDespesa(documento)
  if (!origem) return { ok: false, erro: "Documento não encontrado" }
  if (origem.despesasGeradasEm) {
    return {
      ok: false,
      erro: `Já foram geradas despesas deste documento, em ${origem.despesasGeradasEm.toLocaleDateString("pt-BR")} por ${origem.despesasGeradasPor}.`,
    }
  }

  const gravar: Prisma.DespesaCreateManyInput[] = []
  for (const linha of linhas) {
    if (!(linha.valor > 0)) return { ok: false, erro: `Valor inválido em "${linha.descricao}"` }
    const vencimento = meioDiaDe(linha.data)
    if (!vencimento) return { ok: false, erro: `Data inválida em "${linha.descricao}"` }

    gravar.push({
      conta: linha.conta,
      tipo: linha.tipo,
      descricao: linha.descricao,
      valor: arredondar(linha.valor),
      fornecedor: origem.fornecedor,
      data: vencimento,
      loja: origem.loja,
      contaCorrente: linha.contaCorrente,
      pago: false,
    })
  }

  await db.$transaction(async (tx) => {
    await tx.despesa.createMany({ data: gravar })

    const marca = { despesasGeradasEm: new Date(), despesasGeradasPor: operador }
    if (documento.tipo === "nota") {
      await tx.notaFiscalRecebida.update({ where: { id: documento.id }, data: marca })
    } else {
      await tx.autorizacaoDeFaturamento.update({ where: { id: documento.id }, data: marca })
    }
  })

  return { ok: true, quantidade: gravar.length }
}

/**
 * O que a geração precisa saber do documento, venha ele da SEFAZ ou do papel.
 *
 * A AF já guarda o nome fantasia do cadastro (foi de lá que ela escolheu o
 * fornecedor), então só a nota precisa da tradução de razão social para nome
 * curto — é a única das duas que nasce com o nome escrito pelo emitente.
 */
async function origemDaDespesa(documento: DocumentoDeDespesa) {
  if (documento.tipo === "af") {
    const af = await db.autorizacaoDeFaturamento.findUnique({ where: { id: documento.id } })
    if (!af) return null
    return {
      fornecedor: af.fornecedorNome,
      loja: af.loja,
      despesasGeradasEm: af.despesasGeradasEm,
      despesasGeradasPor: af.despesasGeradasPor,
    }
  }

  const nota = await db.notaFiscalRecebida.findUnique({ where: { id: documento.id } })
  if (!nota) return null
  const { nome } = await fornecedorParaDespesa(nota.emitenteCnpj, nota.emitenteNome)
  return {
    fornecedor: nome,
    loja: nota.loja,
    despesasGeradasEm: nota.despesasGeradasEm,
    despesasGeradasPor: nota.despesasGeradasPor,
  }
}
