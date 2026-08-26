import { db } from "~/lib/db.server"
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
 * Grava as despesas de uma vez e marca a nota — feito junto para nunca deixar
 * a nota "meio gerada": ou as duplicatas todas viram título a pagar, ou
 * nenhuma vira, sem meio-termo que confundiria quem concilia depois.
 *
 * Recusa gerar de novo para a mesma nota: duplicar título a pagar é o tipo de
 * erro que só aparece quando alguém já pagou os dois.
 */
export async function gerarDespesas(
  notaId: string,
  linhas: LinhaDeDespesa[],
  operador: string
): Promise<ResultadoGerarDespesas> {
  if (linhas.length === 0) return { ok: false, erro: "Nenhuma linha para gerar" }

  const nota = await db.notaFiscalRecebida.findUnique({ where: { id: notaId } })
  if (!nota) return { ok: false, erro: "Nota não encontrada" }
  if (nota.despesasGeradasEm) {
    return {
      ok: false,
      erro: `Já foram geradas despesas desta nota, em ${nota.despesasGeradasEm.toLocaleDateString("pt-BR")} por ${nota.despesasGeradasPor}.`,
    }
  }

  for (const linha of linhas) {
    if (!(linha.valor > 0)) return { ok: false, erro: `Valor inválido em "${linha.descricao}"` }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(linha.data)) {
      return { ok: false, erro: `Data inválida em "${linha.descricao}"` }
    }
  }

  const { nome: fornecedor } = await fornecedorParaDespesa(nota.emitenteCnpj, nota.emitenteNome)

  await db.$transaction(async (tx) => {
    await tx.despesa.createMany({
      data: linhas.map((linha) => ({
        conta: linha.conta,
        tipo: linha.tipo,
        descricao: linha.descricao,
        valor: arredondar(linha.valor),
        fornecedor,
        data: dataDoDia(linha.data),
        loja: nota.loja,
        contaCorrente: linha.contaCorrente,
        pago: false,
      })),
    })

    await tx.notaFiscalRecebida.update({
      where: { id: notaId },
      data: { despesasGeradasEm: new Date(), despesasGeradasPor: operador },
    })
  })

  return { ok: true, quantidade: linhas.length }
}

/** "aaaa-mm-dd" vira meio-dia local — mesma razão do `entregaPrometida` do pedido. */
function dataDoDia(dia: string): Date {
  const [ano, mes, diaDoMes] = dia.split("-").map(Number)
  return new Date(ano, mes - 1, diaDoMes, 12, 0, 0, 0)
}
