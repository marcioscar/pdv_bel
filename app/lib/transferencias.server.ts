import type { Prisma } from "@prisma/client"

import { db } from "~/lib/db.server"
import { arredondar } from "~/lib/moeda"
import type { TipoMovimento } from "~/lib/estoque.server"
import { faltaDoItem, type ItemConferido } from "~/lib/transferencias"

/**
 * Transferência entre lojas: sai na expedição, entra na conferência.
 *
 * A baixa acontece quando a carga é despachada, e não quando o destino confirma.
 * O motivo é físico: no instante em que a mercadoria entra no carro, ela deixou
 * a prateleira da origem. Com a baixa só na chegada, a origem passaria o
 * transporte inteiro podendo vender o que já foi embora — e alguém venderia.
 *
 * O preço disso é que existe um intervalo em que a mercadoria não está em loja
 * nenhuma. Esse intervalo é real, então o sistema o mostra: `saldosEmTransito`
 * responde o que está no caminho, derivado dos documentos abertos. Nenhum saldo
 * guardado, nada para dessincronizar.
 */

export type ItemParaEnviar = { produtoId: string; quantidade: number }

export type ResultadoEnvio =
  | { ok: true; numero: number; id: string }
  | { ok: false; erro: string }

/**
 * Despacha a carga: grava o documento e baixa o estoque da origem.
 *
 * NÃO recusa por falta de saldo, e isso é deliberado. O sistema já vende com
 * estoque zerado — o caixa mostra o aviso e deixa passar, porque impedir travaria
 * o balcão enquanto o cadastro não estiver em dia. Recusar a transferência pelo
 * mesmo motivo travaria a mercadoria que já está sendo carregada no carro: ela
 * existe na prateleira, mesmo quando o sistema ainda não sabe disso.
 *
 * O saldo negativo que isso pode gerar não é escondido — aparece no estoque da
 * origem e é justamente o que faz alguém ir conferir o cadastro.
 */
export async function enviarTransferencia(entrada: {
  origem: string
  destino: string
  itens: ItemParaEnviar[]
  operador: string
  operadorId: string
  observacao?: string | null
}): Promise<ResultadoEnvio> {
  if (entrada.origem === entrada.destino) {
    return { ok: false, erro: "Origem e destino são a mesma loja" }
  }
  if (entrada.itens.length === 0) {
    return { ok: false, erro: "Transferência sem itens" }
  }

  const produtos = await db.produto.findMany({
    where: { id: { in: entrada.itens.map((i) => i.produtoId) } },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const itens: {
    produtoId: string
    codigo: string
    descricao: string
    unidade: string
    enviada: number
    recebida: number | null
  }[] = []

  for (const pedido of entrada.itens) {
    const produto = porId.get(pedido.produtoId)
    if (!produto) return { ok: false, erro: "Produto não encontrado no catálogo" }
    if (!(pedido.quantidade > 0)) {
      return { ok: false, erro: `Quantidade inválida em ${produto.descricao}` }
    }

    itens.push({
      produtoId: produto.id,
      codigo: produto.codigo,
      descricao: produto.descricao,
      unidade: produto.unidade,
      enviada: arredondar(pedido.quantidade),
      recebida: null,
    })
  }

  const numero = await proximoNumero()

  // Documento e baixas na MESMA transação: um documento sem as baixas deixaria a
  // origem com saldo que já saiu, e baixas sem documento deixariam mercadoria
  // fora de qualquer prateleira sem nada que dissesse para onde foi.
  const transferencia = await db.$transaction(async (tx) => {
    const doc = await tx.transferencia.create({
      data: {
        numero,
        origem: entrada.origem,
        destino: entrada.destino,
        enviadaPor: entrada.operador,
        enviadaPorId: entrada.operadorId,
        observacao: entrada.observacao?.trim() || null,
        itens,
      },
    })

    await tx.movimentoEstoque.createMany({
      data: itens.map((item) => ({
        produtoId: item.produtoId,
        loja: entrada.origem,
        tipo: "transferencia_saida" satisfies TipoMovimento,
        quantidade: -item.enviada,
        operador: entrada.operador,
        transferenciaId: doc.id,
        transferenciaNumero: numero,
        observacao: `Transferência #${numero} para ${entrada.destino}`,
      })),
    })

    return doc
  })

  return { ok: true, numero: transferencia.numero, id: transferencia.id }
}

/**
 * O contador é o mesmo padrão da venda: `$inc` atômico num documento só, fora da
 * transação. Dentro dela, o rollback devolveria o contador e a tentativa
 * seguinte repetiria o número para sempre.
 */
async function proximoNumero() {
  const contador = await db.contador.upsert({
    where: { nome: "transferencia" },
    update: { valor: { increment: 1 } },
    create: { nome: "transferencia", valor: 1 },
  })
  return contador.valor
}

export type ResultadoConferencia =
  | { ok: true; faltou: boolean; itensComFalta: number }
  | { ok: false; erro: string }

/**
 * O destino confere a carga e assume o que chegou.
 *
 * Entra no estoque o que foi CONTADO, nunca o que foi enviado. É a única
 * escolha honesta: se entrasse o enviado, a conferência seria teatro e a
 * diferença sumiria para dentro do saldo do destino, onde ninguém mais acha.
 *
 * Quem confere não pode ser quem enviou — não por desconfiança de pessoa, mas
 * porque uma conferência que a mesma pessoa faz dos dois lados não é conferência.
 */
export async function conferirTransferencia(entrada: {
  id: string
  conferidos: ItemConferido[]
  operador: string
  operadorId: string
  lojasPermitidas: string[]
}): Promise<ResultadoConferencia> {
  const doc = await db.transferencia.findUnique({ where: { id: entrada.id } })
  if (!doc) return { ok: false, erro: "Transferência não encontrada" }
  if (doc.situacao !== "em_transito") {
    return { ok: false, erro: `Esta transferência já está como "${doc.situacao}"` }
  }
  if (!entrada.lojasPermitidas.includes(doc.destino)) {
    return { ok: false, erro: `Só quem opera em ${doc.destino} confere esta carga` }
  }
  if (doc.enviadaPorId === entrada.operadorId) {
    return {
      ok: false,
      erro: "Quem enviou não confere a própria carga — peça a outra pessoa do destino",
    }
  }

  const contado = new Map(entrada.conferidos.map((i) => [i.produtoId, i.recebida]))

  const itens = doc.itens.map((item) => {
    const recebida = contado.get(item.produtoId)
    if (recebida === undefined || !Number.isFinite(recebida) || recebida < 0) {
      return { ...item, recebida: 0 }
    }
    // Chegar MAIS do que saiu não é sobra: é erro de contagem de um dos dois
    // lados. O excedente não entra — entra o que foi despachado, e a diferença
    // fica para as pessoas resolverem olhando o papel.
    return { ...item, recebida: arredondar(Math.min(recebida, item.enviada)) }
  })

  const itensComFalta = itens.filter((i) => faltaDoItem(i) > 0).length
  const faltou = itensComFalta > 0

  await db.$transaction(async (tx) => {
    await tx.transferencia.update({
      where: { id: doc.id },
      data: {
        itens,
        situacao: faltou ? "recebida_com_falta" : "recebida",
        recebidaEm: new Date(),
        recebidaPor: entrada.operador,
        recebidaPorId: entrada.operadorId,
      },
    })

    /**
     * A observação registra a divergência quando há.
     *
     * Sem isso, quem olha o extrato de estoque do destino vê uma entrada de 8 e
     * nada que a distinga de uma remessa de 8 que chegou inteira. A falta ficaria
     * só no documento — verdade, mas invisível para quem estivesse investigando
     * a partir do produto, que é por onde a pergunta costuma começar ("cadê o
     * saco de 40 que sumiu?").
     */
    const entradas = itens
      .filter((item) => (item.recebida ?? 0) > 0)
      .map((item) => {
        const falta = faltaDoItem(item)
        return {
          produtoId: item.produtoId,
          loja: doc.destino,
          tipo: "transferencia_entrada" satisfies TipoMovimento,
          quantidade: item.recebida as number,
          operador: entrada.operador,
          transferenciaId: doc.id,
          transferenciaNumero: doc.numero,
          observacao:
            falta > 0
              ? `Transferência #${doc.numero} de ${doc.origem} — saíram ${item.enviada}, chegaram ${item.recebida}: faltaram ${falta} ${item.unidade}`
              : `Transferência #${doc.numero} de ${doc.origem}`,
        }
      })

    if (entradas.length > 0) await tx.movimentoEstoque.createMany({ data: entradas })
  })

  return { ok: true, faltou, itensComFalta }
}

/**
 * O gerente decide o destino do que não chegou.
 *
 * Repare que o SALDO já está certo antes desta função rodar: a origem baixou 10
 * na expedição e o destino creditou 8 na conferência, então as 2 unidades que
 * sumiram já saíram do inventário da rede sozinhas. Não há lançamento de perda a
 * fazer — o livro não precisa de ajuda para dizer que a mercadoria não existe.
 *
 * O que falta é humano: alguém precisa OLHAR a diferença e dizer o que houve.
 * Por isso a decisão vive no documento, e não no livro de movimentos. As duas
 * saídas:
 *
 * - `perda`: some mesmo. Nada muda no saldo, e o documento passa a registrar
 *   quem assumiu e por quê. É o rastro que permite descobrir, três meses depois,
 *   que some mercadoria sempre na mesma rota.
 * - `apareceu`: estava embaixo de outra caixa. Aí sim há lançamento: o destino
 *   recebe o que faltava.
 */
export async function resolverFalta(entrada: {
  id: string
  decisao: "perda" | "apareceu"
  operador: string
  observacao?: string | null
}) {
  const doc = await db.transferencia.findUnique({ where: { id: entrada.id } })
  if (!doc) return { ok: false as const, erro: "Transferência não encontrada" }
  if (doc.situacao !== "recebida_com_falta") {
    return { ok: false as const, erro: "Esta transferência não tem falta a resolver" }
  }
  if (doc.faltaResolvidaEm) {
    return { ok: false as const, erro: `A falta já foi resolvida por ${doc.faltaResolvidaPor}` }
  }

  const faltantes = doc.itens
    .map((item) => ({ item, falta: faltaDoItem(item) }))
    .filter((x) => x.falta > 0)

  await db.$transaction(async (tx) => {
    if (entrada.decisao === "apareceu") {
      await tx.movimentoEstoque.createMany({
        data: faltantes.map(({ item, falta }) => ({
          produtoId: item.produtoId,
          loja: doc.destino,
          tipo: "transferencia_entrada" satisfies TipoMovimento,
          quantidade: falta,
          operador: entrada.operador,
          transferenciaId: doc.id,
          transferenciaNumero: doc.numero,
          observacao: `Transferência #${doc.numero}: apareceu depois da conferência`,
        })),
      })
      // O documento passa a dizer que tudo chegou, porque tudo chegou.
      await tx.transferencia.update({
        where: { id: doc.id },
        data: { itens: doc.itens.map((i) => ({ ...i, recebida: i.enviada })) },
      })
    }
    // No caso da perda não há lançamento nenhum: a baixa da origem sem o
    // crédito do destino já é a perda. Um movimento de quantidade zero só para
    // "registrar" sujaria o livro com uma linha que não move saldo — o registro
    // é o documento, logo abaixo.

    await tx.transferencia.update({
      where: { id: doc.id },
      data: {
        faltaResolvidaEm: new Date(),
        faltaResolvidaPor: entrada.operador,
        faltaObservacao: entrada.observacao?.trim() || null,
      },
    })
  })

  return { ok: true as const, itens: faltantes.length }
}

/** Cancela a remessa e devolve tudo para a origem. Só enquanto no caminho. */
export async function cancelarTransferencia(entrada: {
  id: string
  operador: string
}) {
  const doc = await db.transferencia.findUnique({ where: { id: entrada.id } })
  if (!doc) return { ok: false as const, erro: "Transferência não encontrada" }
  if (doc.situacao !== "em_transito") {
    return {
      ok: false as const,
      erro: "Só dá para cancelar o que ainda está no caminho — esta já foi conferida",
    }
  }

  await db.$transaction(async (tx) => {
    // Estorno, e não apagar a saída: o livro nunca é reescrito.
    await tx.movimentoEstoque.createMany({
      data: doc.itens.map((item) => ({
        produtoId: item.produtoId,
        loja: doc.origem,
        tipo: "estorno" satisfies TipoMovimento,
        quantidade: item.enviada,
        operador: entrada.operador,
        transferenciaId: doc.id,
        transferenciaNumero: doc.numero,
        observacao: `Transferência #${doc.numero} cancelada — a carga voltou`,
      })),
    })
    await tx.transferencia.update({
      where: { id: doc.id },
      data: {
        situacao: "cancelada",
        canceladaEm: new Date(),
        canceladaPor: entrada.operador,
      },
    })
  })

  return { ok: true as const }
}

/**
 * O que está no caminho, por produto — o pedaço do inventário da rede que não
 * está em prateleira nenhuma.
 *
 * Derivado dos documentos abertos, e não de um saldo guardado: é a mesma escolha
 * do livro de movimentos, pelo mesmo motivo. Saldo guardado é saldo que um dia
 * discorda da realidade e ninguém sabe quando começou.
 */
export async function saldosEmTransito(): Promise<Map<string, number>> {
  const abertas = await db.transferencia.findMany({
    where: { situacao: "em_transito" },
    select: { itens: true },
  })

  const mapa = new Map<string, number>()
  for (const doc of abertas) {
    for (const item of doc.itens) {
      mapa.set(item.produtoId, arredondar((mapa.get(item.produtoId) ?? 0) + item.enviada))
    }
  }
  return mapa
}

/** Quantas cargas estão a caminho desta loja esperando alguém conferir. */
export function cargasAConferir(loja: string) {
  return db.transferencia.count({ where: { situacao: "em_transito", destino: loja } })
}

/**
 * Sem decisão: o campo é `null` OU está ausente.
 *
 * No Mongo, uma transferência que nunca foi resolvida não tem o campo no
 * documento — e ausente NÃO casa com `null` no Prisma. É a mesma armadilha que
 * `NAO_CANCELADA` documenta nas vendas, e com o mesmo desfecho silencioso: a
 * contagem devolvia zero, o aviso nunca aparecia, e a falta ficaria esperando
 * uma decisão que ninguém saberia que precisava tomar.
 */
const SEM_DECISAO: Prisma.TransferenciaWhereInput = {
  OR: [{ faltaResolvidaEm: null }, { faltaResolvidaEm: { isSet: false } }],
}

/** Faltas que ninguém decidiu ainda — a lista que cobra o gerente. */
export function faltasEmAberto(lojasPermitidas: string[]) {
  return db.transferencia.count({
    where: {
      situacao: "recebida_com_falta",
      AND: [
        SEM_DECISAO,
        { OR: [{ origem: { in: lojasPermitidas } }, { destino: { in: lojasPermitidas } }] },
      ],
    },
  })
}

export type PerdaNoTransporte = Awaited<ReturnType<typeof perdasNoTransporte>>

/**
 * O histórico de tudo que saiu e não chegou.
 *
 * Existe porque o saldo, sozinho, não explica nada: ele diz que a rede tem duas
 * unidades a menos, e não que elas sumiram entre QI e NRT numa terça-feira. Sem
 * um lugar que junte as faltas, cada uma vira um episódio isolado — e o padrão,
 * que é a informação que interessa, nunca aparece.
 *
 * Por isso o agrupamento por ROTA: perder mercadoria de vez em quando é
 * transporte; perder sempre no mesmo trecho é outra coisa.
 */
export async function perdasNoTransporte(lojasPermitidas: string[], desde?: Date) {
  const docs = await db.transferencia.findMany({
    where: {
      situacao: "recebida_com_falta",
      ...(desde ? { criadaEm: { gte: desde } } : {}),
      OR: [{ origem: { in: lojasPermitidas } }, { destino: { in: lojasPermitidas } }],
    },
    orderBy: { criadaEm: "desc" },
    take: 200,
  })

  const rotas = new Map<
    string,
    { rota: string; ocorrencias: number; unidades: number; produtos: Set<string> }
  >()

  const ocorrencias = docs.map((doc) => {
    const faltantes = doc.itens
      .map((item) => ({
        codigo: item.codigo,
        descricao: item.descricao,
        unidade: item.unidade,
        enviada: item.enviada,
        recebida: item.recebida ?? 0,
        falta: faltaDoItem(item),
      }))
      .filter((i) => i.falta > 0)

    const rota = `${doc.origem} → ${doc.destino}`
    const atual = rotas.get(rota) ?? {
      rota,
      ocorrencias: 0,
      unidades: 0,
      produtos: new Set<string>(),
    }
    atual.ocorrencias += 1
    for (const f of faltantes) {
      atual.unidades = arredondar(atual.unidades + f.falta)
      atual.produtos.add(f.descricao)
    }
    rotas.set(rota, atual)

    return {
      id: doc.id,
      numero: doc.numero,
      rota,
      criadaEm: doc.criadaEm,
      enviadaPor: doc.enviadaPor,
      recebidaPor: doc.recebidaPor,
      recebidaEm: doc.recebidaEm,
      resolvidaEm: doc.faltaResolvidaEm,
      resolvidaPor: doc.faltaResolvidaPor,
      observacao: doc.faltaObservacao,
      faltantes,
    }
  })

  return {
    ocorrencias,
    porRota: [...rotas.values()]
      .map((r) => ({ ...r, produtos: [...r.produtos] }))
      .sort((a, b) => b.unidades - a.unidades),
  }
}

export type TransferenciaListada = Awaited<ReturnType<typeof listarTransferencias>>[number]

export function listarTransferencias(lojasPermitidas: string[], limite = 60) {
  return db.transferencia.findMany({
    where: {
      OR: [
        { origem: { in: lojasPermitidas } },
        { destino: { in: lojasPermitidas } },
      ],
    },
    // Em trânsito primeiro seria o ideal, mas o Mongo não ordena por lista de
    // valores: a tela separa em seções, que é mais claro de qualquer forma.
    orderBy: { criadaEm: "desc" },
    take: limite,
  })
}
