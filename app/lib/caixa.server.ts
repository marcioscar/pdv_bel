import { db } from "~/lib/db.server"
import { depoisDoDia, inicioDoDia } from "~/lib/dia"
import { arredondar } from "~/lib/moeda"
import {
  sangriaExigeGerente,
  SANGRIA_SEM_AUTORIZACAO,
  type TipoMovimentoDeCaixa,
} from "~/lib/caixa"
import { moeda } from "~/lib/moeda"
import { ehGerente } from "~/lib/permissoes"
import { autenticar } from "~/lib/sessao.server"
import { NAO_CANCELADA } from "~/lib/vendas.server"

/**
 * O fechamento do caixa de um dia.
 *
 * A conta do dinheiro em espécie é a única que precisa bater com algo físico:
 *
 *     esperado = abertura + vendas em dinheiro − sangrias + reforços
 *
 * As outras formas não entram nela. Pix, débito e crédito vão para o banco sem
 * passar pela gaveta, e a prazo nem dinheiro é — mas todas aparecem no
 * documento, porque quem confere o caixa também quer saber quanto a loja vendeu.
 *
 * Venda cancelada não conta em lugar nenhum: o dinheiro voltou para o cliente.
 */

export type ResumoDoDia = Awaited<ReturnType<typeof resumoDoDia>>

export async function resumoDoDia(loja: string, dia: string) {
  const periodo = {
    loja,
    criadaEm: { gte: inicioDoDia(dia), lt: depoisDoDia(dia) },
  }

  const [porForma, canceladas, movimentos, fechamento] = await Promise.all([
    db.venda.groupBy({
      by: ["forma"],
      where: { AND: [periodo, NAO_CANCELADA] },
      _sum: { total: true },
      _count: { _all: true },
    }),
    db.venda.count({ where: { AND: [periodo, { NOT: NAO_CANCELADA }] } }),
    db.movimentoCaixa.findMany({
      where: { loja, dia },
      orderBy: { criadoEm: "asc" },
    }),
    db.fechamentoCaixa.findUnique({ where: { loja_dia: { loja, dia } } }),
  ])

  // Cancelado continua na lista para quem lê a tela, mas fora de toda soma.
  const valendo = movimentos.filter((m) => !m.canceladoEm)

  const por = (forma: string) =>
    arredondar(porForma.find((f) => f.forma === forma)?._sum.total ?? 0)

  const soma = (tipo: TipoMovimentoDeCaixa) =>
    arredondar(valendo.filter((m) => m.tipo === tipo).reduce((acc, m) => acc + m.valor, 0))

  const abertura = soma("abertura")
  const sangrias = soma("sangria")
  const suprimentos = soma("suprimento")
  const vendasDinheiro = por("dinheiro")

  return {
    loja,
    dia,
    abertura,
    sangrias,
    suprimentos,
    vendasDinheiro,
    esperado: arredondar(abertura + vendasDinheiro - sangrias + suprimentos),
    vendasPix: por("pix"),
    vendasDebito: por("debito"),
    vendasCredito: por("credito"),
    vendasPrazo: por("prazo"),
    totalVendido: arredondar(porForma.reduce((a, f) => a + (f._sum.total ?? 0), 0)),
    quantidadeVendas: porForma.reduce((a, f) => a + f._count._all, 0),
    canceladas,
    movimentos,
    /**
     * Reaberto é o mesmo que não fechado: o documento continua no banco com o
     * histórico das contagens, mas o dia volta a aceitar lançamento e a pedir
     * uma conferência nova.
     */
    fechamento: fechamento && !fechamento.reabertoEm ? fechamento : null,
  }
}

/**
 * O caixa do dia já foi aberto nesta loja?
 *
 * É a pergunta que o PDV faz antes de deixar vender. Abertura lançada significa
 * que alguém contou a gaveta e assumiu o troco inicial — sem isso, a conferência
 * da noite compara o dinheiro com um esperado que ignora o que já estava lá, e
 * acusa falta do valor exato do troco. Todo dia, para sempre.
 */
export async function caixaAberto(loja: string, dia: string) {
  const abertura = await db.movimentoCaixa.findFirst({
    where: { loja, dia, tipo: "abertura" },
    select: { id: true },
  })
  return abertura !== null
}

/** Lança troco inicial, sangria ou reforço. */
export async function lancarMovimentoDeCaixa(entrada: {
  loja: string
  dia: string
  tipo: TipoMovimentoDeCaixa
  valor: number
  operador: string
  operadorId: string
  observacao?: string | null
  /** Credenciais de um gerente, quando o valor da sangria exige. */
  gerenteEmail?: string
  gerenteSenha?: string
}) {
  if (!(entrada.valor > 0)) {
    // O tipo é que diz a direção; valor negativo aqui inverteria o sinal duas
    // vezes e a sangria viraria reforço sem ninguém perceber.
    return { ok: false as const, erro: "Informe um valor maior que zero" }
  }

  /**
   * Reaberto NÃO conta como fechado.
   *
   * A checagem olhava só a existência do documento, e depois de reabrir ele
   * continua lá — então nada podia ser lançado, e a reabertura não servia para
   * nada. `findFirst` com o filtro, e não `findUnique`, porque a condição agora
   * é composta.
   */
  const jaFechado = await db.fechamentoCaixa.findFirst({
    where: {
      loja: entrada.loja,
      dia: entrada.dia,
      AND: [{ OR: [{ reabertoEm: null }, { reabertoEm: { isSet: false } }] }],
    },
  })
  if (jaFechado) {
    return {
      ok: false as const,
      erro: "Este dia já foi fechado — lançar agora mudaria um documento assinado",
    }
  }

  if (entrada.tipo === "abertura") {
    const jaAbriu = await db.movimentoCaixa.findFirst({
      // Abertura cancelada não conta: quem errou o valor cancela e lança de novo.
      where: {
        loja: entrada.loja,
        dia: entrada.dia,
        tipo: "abertura",
        AND: [{ OR: [{ canceladoEm: null }, { canceladoEm: { isSet: false } }] }],
      },
    })
    // Duas aberturas dobrariam o troco no esperado. Reforço é o lançamento certo
    // para pôr mais dinheiro depois de o dia ter começado.
    if (jaAbriu) {
      return {
        ok: false as const,
        erro: "O caixa deste dia já foi aberto — para pôr mais troco, lance um reforço",
      }
    }
  }

  /**
   * Sangria grande precisa de uma segunda pessoa.
   *
   * A conferência do fim do dia não pega retirada indevida: o esperado cai
   * junto com o dinheiro, e a gaveta fecha certa. Quem pega é alguém ter de
   * concordar na hora — e é a senha do gerente que cria essa segunda pessoa,
   * sem depender de ela estar presente para digitar em outro lugar.
   */
  let autorizadaPor: string | null = null
  if (sangriaExigeGerente(entrada.tipo, entrada.valor)) {
    if (!entrada.gerenteEmail || !entrada.gerenteSenha) {
      return {
        ok: false as const,
        precisaGerente: true as const,
        erro: `Sangria acima de ${moeda(SANGRIA_SEM_AUTORIZACAO)} precisa da senha de um gerente`,
      }
    }

    const login = await autenticar(entrada.gerenteEmail, entrada.gerenteSenha)
    if (!login.ok) return { ok: false as const, erro: login.erro }

    const gerente = await db.usuario.findUnique({ where: { id: login.usuarioId } })
    if (!gerente || !ehGerente(gerente.papel)) {
      return { ok: false as const, erro: "Esta pessoa não é gerente" }
    }
    autorizadaPor = gerente.nome
  }

  await db.movimentoCaixa.create({
    data: {
      loja: entrada.loja,
      dia: entrada.dia,
      tipo: entrada.tipo,
      valor: arredondar(entrada.valor),
      operador: entrada.operador,
      operadorId: entrada.operadorId,
      observacao: entrada.observacao?.trim() || null,
      autorizadaPor,
    },
  })

  return { ok: true as const, autorizadaPor }
}

/**
 * Desfaz um lançamento errado — marcando, nunca apagando.
 *
 * Apagar de verdade era o caminho mais curto para sumir com dinheiro: lançar a
 * sangria, imprimir o comprovante para justificar a saída com alguém, e depois
 * apagar o registro. O papel existia, o sistema não sabia de nada. Cancelado
 * fica na lista, riscado, com o nome de quem cancelou.
 */
export async function cancelarMovimentoDeCaixa(
  id: string,
  loja: string,
  operador: string
) {
  const movimento = await db.movimentoCaixa.findUnique({ where: { id } })
  if (!movimento || movimento.loja !== loja) {
    return { ok: false as const, erro: "Lançamento não encontrado" }
  }
  if (movimento.canceladoEm) {
    return { ok: false as const, erro: "Este lançamento já foi cancelado" }
  }

  const fechado = await db.fechamentoCaixa.findFirst({
    where: {
      loja,
      dia: movimento.dia,
      AND: [{ OR: [{ reabertoEm: null }, { reabertoEm: { isSet: false } }] }],
    },
  })
  if (fechado) {
    return { ok: false as const, erro: "Este dia já foi fechado" }
  }

  await db.movimentoCaixa.update({
    where: { id },
    data: { canceladoEm: new Date(), canceladoPor: operador },
  })
  return { ok: true as const }
}

export type ResultadoFechamento =
  | { ok: true; id: string; diferenca: number }
  | { ok: false; erro: string }

/**
 * Fecha o dia com o que a pessoa contou na gaveta.
 *
 * Grava o retrato inteiro do cálculo, e não só a diferença. Se uma venda daquele
 * dia for cancelada semana que vem, o esperado mudaria — e o documento assinado
 * passaria a discordar de si mesmo. Retrato guardado, documento estável.
 */
export async function fecharCaixa(entrada: {
  loja: string
  dia: string
  contado: number
  operador: string
  operadorId: string
  observacao?: string | null
}): Promise<ResultadoFechamento> {
  if (!Number.isFinite(entrada.contado) || entrada.contado < 0) {
    return { ok: false, erro: "Informe quanto foi contado na gaveta" }
  }

  const resumo = await resumoDoDia(entrada.loja, entrada.dia)
  if (resumo.fechamento) {
    return {
      ok: false,
      erro: `Este dia já foi fechado por ${resumo.fechamento.fechadoPor}`,
    }
  }

  const contado = arredondar(entrada.contado)
  const diferenca = arredondar(contado - resumo.esperado)

  const anterior = await db.fechamentoCaixa.findUnique({
    where: { loja_dia: { loja: entrada.loja, dia: entrada.dia } },
  })

  const dados = {
        loja: entrada.loja,
        dia: entrada.dia,
        fechadoPor: entrada.operador,
        fechadoPorId: entrada.operadorId,
        abertura: resumo.abertura,
        vendasDinheiro: resumo.vendasDinheiro,
        sangrias: resumo.sangrias,
        suprimentos: resumo.suprimentos,
        esperado: resumo.esperado,
        contado,
        diferenca,
        vendasPix: resumo.vendasPix,
        vendasDebito: resumo.vendasDebito,
        vendasCredito: resumo.vendasCredito,
        vendasPrazo: resumo.vendasPrazo,
        totalVendido: resumo.totalVendido,
        quantidadeVendas: resumo.quantidadeVendas,
        canceladas: resumo.canceladas,
        observacao: entrada.observacao?.trim() || null,
  }

  try {
    /**
     * Dia reaberto reaproveita o MESMO documento, para as contagens anteriores
     * continuarem penduradas nele. Criar um novo esbarraria no índice único —
     * que é justamente o que impede dois fechamentos do mesmo expediente.
     */
    const doc = anterior
      ? await db.fechamentoCaixa.update({
          where: { id: anterior.id },
          data: { ...dados, fechadoEm: new Date(), reabertoEm: null, reabertoPor: null },
        })
      : await db.fechamentoCaixa.create({ data: dados })

    return { ok: true, id: doc.id, diferenca }
  } catch (erro) {
    // O índice único é a trava de verdade contra duas abas fechando o mesmo dia.
    if (typeof erro === "object" && erro !== null && (erro as { code?: string }).code === "P2002") {
      return { ok: false, erro: "Este dia acabou de ser fechado por outra pessoa" }
    }
    throw erro
  }
}

/**
 * Reabre o dia — GUARDANDO a contagem desfeita.
 *
 * Existe porque fechar com o número errado acontece, e a alternativa seria o
 * operador "consertar" com uma sangria falsa. Mas apagar o fechamento anterior,
 * como esta função fazia, abria coisa pior: dava para fechar, ver que faltavam
 * R$ 300, reabrir, lançar uma sangria que explicasse a falta e fechar com a
 * gaveta batendo — sem nenhum vestígio da primeira contagem.
 *
 * Agora cada contagem desfeita vai para `tentativas`, e o histórico do gerente
 * passa a poder dizer "este caixa foi fechado três vezes até bater", que é
 * exatamente o que a reabertura silenciosa escondia.
 */
export async function reabrirCaixa(loja: string, dia: string, operador: string) {
  const atual = await db.fechamentoCaixa.findUnique({ where: { loja_dia: { loja, dia } } })
  if (!atual || atual.reabertoEm) return false

  const agora = new Date()
  await db.fechamentoCaixa.update({
    where: { id: atual.id },
    data: {
      reabertoEm: agora,
      reabertoPor: operador,
      tentativas: {
        set: [
          ...atual.tentativas,
          {
            fechadoEm: atual.fechadoEm,
            fechadoPor: atual.fechadoPor,
            esperado: atual.esperado,
            contado: atual.contado,
            diferenca: atual.diferenca,
            observacao: atual.observacao,
            reabertoEm: agora,
            reabertoPor: operador,
          },
        ],
      },
    },
  })
  return true
}

/**
 * O fechamento com tudo que o compõe, para conferir na tela.
 *
 * Traz as vendas uma a uma porque é aí que a conferência acontece de fato: o
 * total em dinheiro é uma soma, e quem procura R$ 40 que faltam precisa ver as
 * parcelas que a formaram. Sem isso a tela repetiria o papel — e o papel a
 * pessoa já tem na mão.
 */
export async function fechamentoDetalhado(id: string) {
  const fechamento = await db.fechamentoCaixa.findUnique({ where: { id } })
  if (!fechamento) return null

  const [movimentos, vendas] = await Promise.all([
    db.movimentoCaixa.findMany({
      where: { loja: fechamento.loja, dia: fechamento.dia },
      orderBy: { criadoEm: "asc" },
    }),
    db.venda.findMany({
      where: {
        loja: fechamento.loja,
        criadaEm: {
          gte: inicioDoDia(fechamento.dia),
          lt: depoisDoDia(fechamento.dia),
        },
      },
      orderBy: { criadaEm: "asc" },
      select: {
        id: true,
        numero: true,
        criadaEm: true,
        operador: true,
        forma: true,
        total: true,
        clienteNome: true,
        canceladaEm: true,
      },
    }),
  ])

  return { fechamento, movimentos, vendas }
}

export type FechamentoListado = Awaited<ReturnType<typeof listarFechamentos>>[number]

export function listarFechamentos(lojasPermitidas: string[], limite = 90) {
  return db.fechamentoCaixa.findMany({
    where: {
      loja: { in: lojasPermitidas },
      // Reaberto não está fechado: aparece como dia pendente, não como concluído.
      AND: [{ OR: [{ reabertoEm: null }, { reabertoEm: { isSet: false } }] }],
    },
    orderBy: [{ dia: "desc" }, { loja: "asc" }],
    take: limite,
  })
}

/** Dias com movimento que ninguém fechou — a lista que cobra o gerente. */
export async function diasSemFechamento(lojasPermitidas: string[], desde: string) {
  const vendas = await db.venda.findMany({
    where: { loja: { in: lojasPermitidas }, criadaEm: { gte: inicioDoDia(desde) } },
    select: { loja: true, criadaEm: true },
  })

  const comMovimento = new Set<string>()
  for (const v of vendas) {
    const d = v.criadaEm
    const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    comMovimento.add(`${v.loja}|${dia}`)
  }

  const fechados = new Set(
    (
      await db.fechamentoCaixa.findMany({
        where: {
          loja: { in: lojasPermitidas },
          dia: { gte: desde },
          AND: [{ OR: [{ reabertoEm: null }, { reabertoEm: { isSet: false } }] }],
        },
        select: { loja: true, dia: true },
      })
    ).map((f) => `${f.loja}|${f.dia}`)
  )

  return [...comMovimento]
    .filter((c) => !fechados.has(c))
    .map((c) => ({ loja: c.split("|")[0], dia: c.split("|")[1] }))
    .sort((a, b) => (a.dia === b.dia ? a.loja.localeCompare(b.loja) : b.dia.localeCompare(a.dia)))
}
