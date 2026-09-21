import type { Route } from "./+types/saude"
import { db } from "~/lib/db.server"
import {
  certificadoDaConta,
  chavePixConfigurada,
  interConfigurado,
} from "~/lib/inter.server"
// Só o que é usado: import pendurado de módulo `.server` derruba o build de
// produção inteiro, com um erro que fala de código no cliente e não de import
// sobrando.
import { ambienteFocus, origemDoToken, variavelDoToken } from "~/lib/focus.server"
import { certificadoSefazDaLoja, sefazConfigurado } from "~/lib/sefaz.server"
import { diagnosticoSessao } from "~/lib/sessao.server"
import { diagnosticoTelegram } from "~/lib/telegram.server"

/**
 * Diz o que está rodando. Serve para responder "o deploy entrou?" sem adivinhar
 * pelo comportamento da interface, e para conferir de fora se o banco e a
 * integração do Inter estão de pé.
 *
 * Não expõe segredo: só se a configuração existe e contra qual ambiente aponta.
 */
export async function loader(_: Route.LoaderArgs) {
  // Uma linha por conta: com três contas, "o Inter está configurado" deixou de ser
  // uma pergunta com resposta única. Sem isto, uma loja sem credencial só apareceria
  // quando a primeira venda a prazo falhasse no balcão.
  let contas: Record<
    string,
    {
      credenciais: boolean
      chavePix: boolean
      lojas: string[]
      certificado: ReturnType<typeof certificadoDaConta>
    }
  > = {}
  try {
    const lojas = await db.loja.findMany({
      where: { ativo: true },
      select: { codigo: true, conta: true },
    })
    for (const { codigo, conta } of lojas) {
      contas[conta] ??= {
        credenciais: interConfigurado(conta),
        chavePix: chavePixConfigurada(conta),
        certificado: certificadoDaConta(conta),
        lojas: [],
      }
      contas[conta].lojas.push(codigo)
    }
  } catch {
    contas = {}
  }

  // Por LOJA, e não por conta: ao contrário do Inter, a SEFAZ trata cada CNPJ
  // como interessado à parte, e QI/QNE têm CNPJs diferentes mesmo dividindo
  // conta corrente no Inter.
  let lojasSefaz: Record<
    string,
    { configurado: boolean; certificado: ReturnType<typeof certificadoSefazDaLoja> }
  > = {}
  try {
    const lojas = await db.loja.findMany({ where: { ativo: true }, select: { codigo: true } })
    for (const { codigo } of lojas) {
      lojasSefaz[codigo] = {
        configurado: await sefazConfigurado(codigo),
        certificado: certificadoSefazDaLoja(codigo),
      }
    }
  } catch {
    lojasSefaz = {}
  }

  let banco: string
  try {
    banco = `ok · ${await db.produto.count()} produtos`
  } catch (erro) {
    banco = `falhou: ${erro instanceof Error ? erro.message.split("\n")[0] : "erro"}`
  }

  /*
   * O que faltava aqui, e é a pergunta que mais importa num deploy: a nota que
   * sai é de verdade? O ambiente é escolhido pelo token, e o token só existe
   * no servidor — sem esta linha, "estamos em produção" só se descobria
   * emitindo, que é tarde demais para descobrir.
   *
   * E, junto, o que cada loja ainda não tem para poder emitir. A tela de
   * Cadastros › Fiscal já mostra isso de dentro; de fora, sem login, era
   * invisível.
   */
  let fiscal: Record<string, unknown>
  try {
    const lojas = await db.loja.findMany({
      where: { ativo: true },
      orderBy: { ordem: "asc" },
    })

    const pendenciasDe = (l: (typeof lojas)[number]) => {
      const falta: string[] = []
      if (!l.inscricaoEstadual) falta.push("inscricaoEstadual")
      if (!l.regimeTributario) falta.push("regimeTributario")
      if (!l.cfopVendaInterna) falta.push("cfopVendaInterna")
      if (!l.cfopVendaInterestadual) falta.push("cfopVendaInterestadual")
      if (!l.cfopTransferencia) falta.push("cfopTransferencia")
      // Sem ele a NF-e de devolução não sai — e só se descobre com o cliente
      // na frente devolvendo mercadoria.
      if (!l.cfopDevolucao) falta.push("cfopDevolucao")
      if (!l.csosnPadrao) falta.push("csosnPadrao")
      return falta
    }

    const ambiente = ambienteFocus()

    fiscal = {
      // "homologacao" = nota de teste, sem valor. "producao" = nota de verdade.
      ambiente,
      /*
       * O token da Focus é POR EMPRESA, então "está configurado" é uma pergunta
       * por loja. Uma linha só diria "sim" com o token da matriz e esconderia
       * que as outras três não emitem — e isso só apareceria no balcão.
       *
       * Vai o NOME da variável que falta, não o valor de nenhuma: é o que
       * transforma "está faltando algo" em uma linha para colar no painel.
       */
      tokens: Object.fromEntries(
        lojas.map((l) => {
          const origem = origemDoToken(l.codigo, ambiente)
          return [
            l.codigo,
            origem === "propria"
              ? "ok"
              : origem === "reserva"
                ? // Vai emitir com o token de outra empresa: funciona enquanto
                  // houver uma empresa só na conta, e recusa quando não houver.
                  `sem token próprio — usando o geral; cadastre ${variavelDoToken(l.codigo, ambiente)}`
                : `FALTA ${variavelDoToken(l.codigo, ambiente)}`,
          ]
        })
      ),
      // Sem ele a Focus não consegue avisar quando a SEFAZ responde, e a nota
      // fica "processando" até alguém consultar na mão.
      avisoDaFocus: Boolean(process.env.FOCUS_NFE_WEBHOOK_SEGREDO),
      emitem: lojas.filter((l) => l.emiteNotaFiscal).map((l) => l.codigo),
      noCupomNaoFiscal: lojas.filter((l) => !l.emiteNotaFiscal).map((l) => l.codigo),
      pendencias: Object.fromEntries(
        lojas.map((l) => [l.codigo, pendenciasDe(l)]).filter(([, falta]) => falta.length > 0)
      ),
    }
  } catch {
    fiscal = { erro: "não foi possível ler as lojas" }
  }

  return Response.json(
    {
      ok: true,
      build: __BUILD__,
      ambiente: process.env.NODE_ENV ?? "desconhecido",
      /**
       * O fuso do container decide o que é "hoje" no filtro de vendas e nos
       * relatórios. Fica aqui porque é a única forma de conferir de fora se ele
       * subiu certo: pelo comportamento da tela, um container em UTC só se
       * denuncia no fim do expediente, quando o movimento das últimas horas
       * aparece no dia seguinte.
       */
      relogio: {
        fuso: Intl.DateTimeFormat().resolvedOptions().timeZone,
        agora: new Date().toLocaleString("pt-BR"),
      },
      // Sem SESSION_SECRET nada que exige login funciona; melhor dizer aqui.
      sessao: diagnosticoSessao(),
      banco,
      fiscal,
      contasInter: contas,
      // Sem isto, "o gerente parou de receber aviso" e "o token nunca subiu para
      // o ambiente" seriam indistinguíveis de fora.
      avisoTelegram: diagnosticoTelegram(),
      inter: {
        // sandbox ou produção — dá para ver de fora se alguém trocou sem avisar
        alvo: process.env.INTER_BASE_URL?.includes("sandbox") ? "sandbox" : "producao",
        contas: Object.keys(contas).length,
        prontas: Object.values(contas).filter((c) => c.credenciais).length,
        // Junta num só lugar o que exige ação: certificado perto de vencer.
        certificadosARenovar: Object.entries(contas)
          .filter(([, c]) => c.certificado?.renovar)
          .map(([nome]) => nome),
        // Certificado do ambiente errado, ou chave que não é do certificado: as
        // duas falham no handshake com erro de OpenSSL que não explica nada.
        contasIncompativeis: Object.entries(contas)
          .filter(
            ([, c]) =>
              c.certificado &&
              (!c.certificado.ambienteConfere || c.certificado.chaveCombina === false)
          )
          .map(([nome]) => nome),
      },
      sefaz: {
        lojas: Object.keys(lojasSefaz).length,
        prontas: Object.values(lojasSefaz).filter((l) => l.configurado).length,
        certificadosARenovar: Object.entries(lojasSefaz)
          .filter(([, l]) => l.certificado?.renovar)
          .map(([codigo]) => codigo),
        certificadosIncompativeis: Object.entries(lojasSefaz)
          .filter(([, l]) => l.certificado && l.certificado.chaveCombina === false)
          .map(([codigo]) => codigo),
      },
    },
    { headers: { "cache-control": "no-store" } }
  )
}
