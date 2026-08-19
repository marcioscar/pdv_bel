import type { Prisma } from "@prisma/client"

import {
  aprovacaoValida,
  descontoExigeAutorizacao,
  DIAS_DE_CARENCIA,
  formaEstendeCredito,
  percentualDoDesconto,
  type MotivoDeAutorizacao,
} from "~/lib/autorizacao"
import { db } from "~/lib/db.server"
import { diaAtras, diaDeHoje, emDia, inicioDoDia } from "~/lib/dia"
import { arredondar } from "~/lib/moeda"
import { SITUACOES_EM_ABERTO } from "~/lib/recebiveis"

/**
 * A dívida vencida de um cliente, em toda a rede.
 *
 * Rede e não loja: é o mesmo CNPJ comprando, e o cliente que deve em QI não
 * deixa de dever porque atravessou a rua e entrou em QNE. Foi para isso que a
 * cobrança guardou `vendaId` — o pagador vem da venda, e a venda tem cliente.
 */
export type Divida = {
  valor: number
  parcelas: number
  /** Dias de atraso da parcela MAIS VELHA: é ela que mede o tamanho do problema. */
  diasAtraso: number
  vencidaEm: Date | null
}

const SEM_DIVIDA: Divida = { valor: 0, parcelas: 0, diasAtraso: 0, vencidaEm: null }

/**
 * O que o cliente deve, considerando a carência.
 *
 * O corte é `vencimento < hoje - carência`: boleto que venceu ontem não trava
 * nada, porque o retorno do banco ainda pode estar a caminho.
 */
export async function dividaDoCliente(clienteId: string | null): Promise<Divida> {
  if (!clienteId) return SEM_DIVIDA

  // As vendas do cliente em qualquer loja — é por elas que se chega às cobranças.
  const vendas = await db.venda.findMany({
    where: { clienteId },
    select: { id: true },
  })
  if (vendas.length === 0) return SEM_DIVIDA

  const limite = inicioDoDia(diaAtras(DIAS_DE_CARENCIA))

  const vencidas = await db.cobranca.findMany({
    where: {
      vendaId: { in: vendas.map((venda) => venda.id) },
      situacao: { in: SITUACOES_EM_ABERTO },
      vencimento: { lt: limite },
    },
    orderBy: { vencimento: "asc" },
    select: { valor: true, vencimento: true },
  })

  if (vencidas.length === 0) return SEM_DIVIDA

  const maisVelha = vencidas[0].vencimento
  return {
    valor: arredondar(vencidas.reduce((acc, c) => acc + c.valor, 0)),
    parcelas: vencidas.length,
    // Pelos dias do calendário local, não pela diferença de instantes: o
    // vencimento é gravado com hora, e subtrair `Date`s crus daria 2,7 dias.
    diasAtraso: Math.round(
      (inicioDoDia(diaDeHoje()).getTime() - inicioDoDia(emDia(maisVelha)).getTime()) /
        86_400_000
    ),
    vencidaEm: maisVelha,
  }
}

export type AvaliacaoDaVenda = {
  motivos: MotivoDeAutorizacao[]
  divida: Divida
  descontoPercentual: number
}

/**
 * Por que esta venda precisaria do gerente — a pergunta única do sistema.
 *
 * Chamada pela tela (para avisar) e pela gravação (para recusar). Uma função só
 * porque um aviso que não corresponde ao bloqueio é pior que nenhum aviso: o
 * vendedor aprende a ignorar a tela e descobre o problema com o cliente na frente.
 */
export async function avaliarVenda(entrada: {
  clienteId: string | null
  subtotal: number
  desconto: number
  /** A forma de pagamento decide se a inadimplência trava: só o prazo dá crédito. */
  forma: string
}): Promise<AvaliacaoDaVenda> {
  const divida = await dividaDoCliente(entrada.clienteId)

  const motivos: MotivoDeAutorizacao[] = []
  // A dívida é consultada em qualquer forma — o vendedor precisa vê-la para
  // cobrar —, mas só trava quando a venda somaria crédito novo ao atrasado.
  if (divida.parcelas > 0 && formaEstendeCredito(entrada.forma)) {
    motivos.push("inadimplencia")
  }
  if (descontoExigeAutorizacao(entrada.subtotal, entrada.desconto)) motivos.push("desconto")

  return {
    motivos,
    divida,
    descontoPercentual: arredondar(percentualDoDesconto(entrada.subtotal, entrada.desconto)),
  }
}

/**
 * O corpo da recusa por falta de liberação, ou `null` quando a venda pode seguir.
 *
 * Mora aqui, e não na rota do caixa, por uma razão do empacotador: o React
 * Router só arranca `loader` e `action` do pacote do navegador, então uma função
 * auxiliar no arquivo da rota levaria junto o módulo `.server` inteiro — e o
 * build quebra. A rota só embrulha o que sai daqui num `data(..., 400)`.
 *
 * Existe para o Pix e a venda comum darem a MESMA resposta: são dois caminhos
 * até a mesma regra, e um deles respondendo diferente faria o diálogo abrir num
 * e não no outro.
 */
export async function recusaPorFaltaDeLiberacao(entrada: {
  clienteId: string | null
  desconto: number
  forma: string
  subtotal: number
}) {
  const avaliacao = await avaliarVenda(entrada)
  if (avaliacao.motivos.length === 0) return null

  return {
    ok: false as const,
    tipo: "bloqueio" as const,
    erro: "Esta venda precisa da liberação do gerente",
    motivos: avaliacao.motivos as string[],
    divida: {
      valor: avaliacao.divida.valor,
      parcelas: avaliacao.divida.parcelas,
      diasAtraso: avaliacao.divida.diasAtraso,
    },
    descontoPercentual: avaliacao.descontoPercentual,
  }
}

export type ItemDoPedido = {
  produtoId: string
  codigo: string
  descricao: string
  unidade: string
  preco: number
  quantidade: number
  subtotal: number
}

/** Abre o pedido e devolve o que o caixa precisa para acompanhar. */
export async function pedirAutorizacao(entrada: {
  loja: string
  caixa: string
  solicitanteId: string
  solicitante: string
  motivos: MotivoDeAutorizacao[]
  itens: ItemDoPedido[]
  subtotal: number
  desconto: number
  total: number
  descontoPercentual: number
  cliente: { id: string; nome: string; cpfCnpj: string } | null
  divida: Divida
}) {
  return db.autorizacao.create({
    data: {
      loja: entrada.loja,
      caixa: entrada.caixa,
      solicitanteId: entrada.solicitanteId,
      solicitante: entrada.solicitante,
      motivos: entrada.motivos,
      itens: entrada.itens,
      subtotal: entrada.subtotal,
      desconto: entrada.desconto,
      total: entrada.total,
      descontoPercentual: entrada.descontoPercentual,
      clienteId: entrada.cliente?.id ?? null,
      clienteNome: entrada.cliente?.nome ?? null,
      clienteCpfCnpj: entrada.cliente?.cpfCnpj ?? null,
      dividaValor: entrada.divida.valor,
      dividaParcelas: entrada.divida.parcelas,
      dividaDiasAtraso: entrada.divida.diasAtraso,
    },
  })
}

export type Decisao = "aprovada" | "negada"

/**
 * Registra a decisão do gerente.
 *
 * `updateMany` com `situacao: "pendente"` no filtro, e não `update` pelo id: dois
 * gerentes abrindo a fila ao mesmo tempo decidiriam o mesmo pedido, e o segundo
 * sobrescreveria o primeiro sem que nada aparecesse. Assim o segundo recebe
 * "já decidida" e vê de quem foi.
 */
export async function decidirAutorizacao(entrada: {
  id: string
  decisao: Decisao
  quem: { id: string; nome: string }
  onde: "app" | "caixa"
  observacao?: string | null
}) {
  const { count } = await db.autorizacao.updateMany({
    where: { id: entrada.id, situacao: "pendente" },
    data: {
      situacao: entrada.decisao,
      decididaEm: new Date(),
      decididaPor: entrada.quem.nome,
      decididaPorId: entrada.quem.id,
      decididaOnde: entrada.onde,
      observacao: entrada.observacao?.trim() || null,
    },
  })

  if (count === 0) {
    const atual = await db.autorizacao.findUnique({ where: { id: entrada.id } })
    return {
      ok: false as const,
      erro: atual
        ? `Este pedido já foi ${atual.situacao === "negada" ? "negado" : "decidido"}${atual.decididaPor ? ` por ${atual.decididaPor}` : ""}`
        : "Pedido não encontrado",
    }
  }

  return { ok: true as const }
}

/** O vendedor desistiu da venda: o pedido sai da fila do gerente. */
export async function cancelarAutorizacao(id: string, solicitanteId: string) {
  const { count } = await db.autorizacao.updateMany({
    // O próprio dono, e só enquanto pendente: cancelar a aprovação de outro
    // seria apagar a decisão de um gerente.
    where: { id, solicitanteId, situacao: "pendente" },
    data: { situacao: "cancelada" },
  })
  return count > 0
}

export type AutorizacaoListada = Awaited<ReturnType<typeof listarPendentes>>[number]

/** A fila do gerente: o que espera decisão, mais velho primeiro. */
export function listarPendentes(lojasPermitidas: string[]) {
  return db.autorizacao.findMany({
    where: { situacao: "pendente", loja: { in: lojasPermitidas } },
    orderBy: { criadaEm: "asc" },
    take: 100,
  })
}

/** O histórico recente, para o gerente conferir o que ele mesmo liberou. */
export function listarDecididas(lojasPermitidas: string[]) {
  return db.autorizacao.findMany({
    where: {
      loja: { in: lojasPermitidas },
      situacao: { in: ["aprovada", "negada", "usada", "cancelada"] },
    },
    orderBy: { criadaEm: "desc" },
    take: 50,
  })
}

/**
 * O que o vendedor tem em andamento.
 *
 * Só as dele e só as vivas: pedido negado há três dias na lista faria o contador
 * do topo nunca zerar, e contador que não zera para de ser lido.
 */
export function listarDoOperador(solicitanteId: string) {
  return db.autorizacao.findMany({
    where: {
      solicitanteId,
      situacao: { in: ["pendente", "aprovada", "negada"] },
      criadaEm: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    orderBy: { criadaEm: "desc" },
    take: 20,
  })
}

/**
 * Os números do indicador no topo, que toda tela consulta de tempos em tempos.
 *
 * Duas contagens porque são dois públicos na mesma barra: o gerente precisa
 * saber o que falta decidir, o vendedor o que já foi respondido para ele.
 */
export async function contagemDeAutorizacoes(usuario: {
  id: string
  lojasPermitidas: string[]
}) {
  const [aDecidir, respondidas] = await Promise.all([
    db.autorizacao.count({
      where: { situacao: "pendente", loja: { in: usuario.lojasPermitidas } },
    }),
    db.autorizacao.count({
      where: {
        solicitanteId: usuario.id,
        situacao: { in: ["aprovada", "negada"] },
        criadaEm: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
  ])
  return { aDecidir, respondidas }
}

/**
 * A autorização que pode ser usada para gravar ESTA venda, ou o motivo de não.
 *
 * É a guarda de verdade — a tela pode ser burlada, isto não. Confere quatro
 * coisas, e cada uma nasceu de um jeito de burlar o fluxo:
 *
 * - situação e validade, senão a aprovação de terça fecha a venda de sexta;
 * - a loja, senão a liberação de uma loja vale na outra;
 * - o cliente, senão a liberação de um cliente serve para vender fiado a outro;
 * - o percentual do desconto, senão pede-se 6% e fecha-se com 40%.
 *
 * Repare que os ITENS não entram: o carrinho pode mudar entre o pedido e o
 * fechamento (o cliente desistiu de um saco), e o que o gerente aprovou foi a
 * condição — este cliente, este desconto —, não aquela lista de produtos.
 */
export async function conferirAutorizacao(entrada: {
  id: string
  loja: string
  clienteId: string | null
  subtotal: number
  desconto: number
  motivos: MotivoDeAutorizacao[]
}) {
  const autorizacao = await db.autorizacao.findUnique({ where: { id: entrada.id } })
  if (!autorizacao) return { ok: false as const, erro: "Autorização não encontrada" }

  if (autorizacao.situacao === "usada") {
    return {
      ok: false as const,
      erro: `Esta autorização já foi usada na venda ${autorizacao.vendaNumero ?? ""}`.trim(),
    }
  }
  if (!aprovacaoValida(autorizacao)) {
    return {
      ok: false as const,
      erro:
        autorizacao.situacao === "pendente"
          ? "A autorização ainda não foi decidida"
          : autorizacao.situacao === "negada"
            ? "A autorização foi negada pelo gerente"
            : "A autorização expirou — peça de novo",
    }
  }
  if (autorizacao.loja !== entrada.loja) {
    return { ok: false as const, erro: "Autorização de outra loja" }
  }
  if ((autorizacao.clienteId ?? null) !== entrada.clienteId) {
    return { ok: false as const, erro: "Autorização era para outro cliente" }
  }

  const percentual = percentualDoDesconto(entrada.subtotal, entrada.desconto)
  // Um centavo de folga: o percentual é recalculado sobre um subtotal que pode
  // ter mudado, e recusar por 5,0001% seria recusar por arredondamento.
  if (percentual > autorizacao.descontoPercentual + 0.01) {
    return {
      ok: false as const,
      erro: `O gerente liberou até ${autorizacao.descontoPercentual.toFixed(1)}% de desconto`,
    }
  }

  // Motivo novo que não estava no pedido não pode entrar de carona: o gerente
  // liberou o desconto, não a venda para um cliente que ficou inadimplente depois.
  const naoCobertos = entrada.motivos.filter((motivo) => !autorizacao.motivos.includes(motivo))
  if (naoCobertos.length > 0) {
    return { ok: false as const, erro: "A autorização não cobre o motivo do bloqueio" }
  }

  return { ok: true as const, autorizacao }
}

/**
 * Fecha o ciclo: a autorização passa a "usada" e aponta para a venda.
 *
 * Recebe a transação porque isto acontece JUNTO da gravação da venda — uma venda
 * gravada com a autorização ainda "aprovada" deixaria a mesma liberação servir
 * para uma segunda venda.
 */
export function marcarAutorizacaoUsada(
  tx: Prisma.TransactionClient,
  id: string,
  venda: { id: string; numero: number }
) {
  return tx.autorizacao.updateMany({
    where: { id, situacao: "aprovada" },
    data: { situacao: "usada", vendaId: venda.id, vendaNumero: venda.numero },
  })
}
