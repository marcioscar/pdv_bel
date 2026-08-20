import type { Route } from "./+types/saude"
import { db } from "~/lib/db.server"
import {
  certificadoDaConta,
  chavePixConfigurada,
  interConfigurado,
} from "~/lib/inter.server"
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

  let banco: string
  try {
    banco = `ok · ${await db.produto.count()} produtos`
  } catch (erro) {
    banco = `falhou: ${erro instanceof Error ? erro.message.split("\n")[0] : "erro"}`
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
    },
    { headers: { "cache-control": "no-store" } }
  )
}
