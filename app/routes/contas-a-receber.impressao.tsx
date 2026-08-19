import type { Route } from "./+types/contas-a-receber.impressao"
import { seuNumeroDaParcela } from "~/lib/cobranca.server"
import { diaEmTexto, emDia, inicioDoDia } from "~/lib/dia"
import { escapar } from "~/lib/html"
import { moeda } from "~/lib/moeda"
import {
  rotuloDaSituacao,
  SITUACOES_EM_ABERTO,
  type SituacaoRecebivel,
} from "~/lib/recebiveis"
import {
  LIMITE_IMPRESSAO,
  lerFiltroRecebiveis,
  recebiveisParaImpressao,
  type RecebivelConsultado,
} from "~/lib/recebiveis.server"
import { exigirGerente } from "~/lib/sessao.server"

/**
 * A folha de conferência da gaveta de boletos.
 *
 * Não é a tela impressa: é um papel para alguém levar até o arquivo físico e
 * riscar linha por linha. Por isso a primeira coluna é um quadradinho vazio, o
 * número que abre a linha é o que está IMPRESSO no boleto (o "nosso número", e
 * não o id do sistema, que não existe no papel) e os boletos vêm agrupados por
 * DIA DE VENCIMENTO, que é como a gaveta é arquivada — a loja é uma coluna, não
 * uma seção, porque quem abre a gaveta num dia tira o que estiver ali, das
 * quatro lojas juntas.
 *
 * HTML e não PDF pelo mesmo motivo do cupom: o navegador imprime direto, sem
 * biblioteca de PDF no servidor. Rota de recurso, fora do layout de /admin —
 * dentro dele a folha sairia com a sidebar impressa junto.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // A rota mora fora do layout de /admin, então a guarda que ele cobra não passa
  // por aqui: esta cobra a sua. A folha lista a carteira inteira da rede.
  const eu = await exigirGerente(request, "verContasAReceber")

  const filtro = lerFiltroRecebiveis(new URL(request.url), eu.lojasPermitidas)
  const { recebiveis, total, cortadas } = await recebiveisParaImpressao(filtro)

  const periodo =
    filtro.de === filtro.ate
      ? diaEmTexto(filtro.de)
      : `${diaEmTexto(filtro.de)} a ${diaEmTexto(filtro.ate)}`

  const html = folha({
    titulo: TITULOS[filtro.situacao].titulo,
    instrucao: TITULOS[filtro.situacao].instrucao,
    periodo,
    recebiveis,
    total,
    cortadas,
    emitidoPor: eu.nome,
  })

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Folha de conferência é retrato de um instante: guardada em cache, mandaria
      // buscar na gaveta um boleto que acabou de ser baixado.
      "cache-control": "no-store",
    },
  })
}

/**
 * O que a folha diz que é, conforme o recorte pedido.
 *
 * O título é a primeira coisa que a pessoa lê antes de abrir a gaveta, e é ele
 * que separa "tire estes daqui" de "ligue para estes". Uma folha genérica faria
 * a mesma lista servir para as duas coisas — e alguém acabaria arquivando de
 * volta um boleto pago.
 */
const TITULOS: Record<SituacaoRecebivel, { titulo: string; instrucao: string }> = {
  recebidas: {
    titulo: "Boletos pagos",
    instrucao: "RETIRAR da gaveta — estes já foram pagos.",
  },
  abertas: {
    titulo: "Boletos em aberto",
    instrucao: "DEIXAR na gaveta — ainda não foram pagos.",
  },
  vencidas: {
    titulo: "Boletos vencidos",
    instrucao: "COBRAR — passaram do vencimento e continuam em aberto.",
  },
  canceladas: {
    titulo: "Boletos cancelados",
    instrucao: "RETIRAR da gaveta — foram cancelados e não serão pagos.",
  },
  todas: {
    titulo: "Boletos",
    instrucao: "Confira pela coluna Situação o que sai e o que fica na gaveta.",
  },
}

function linha(conta: RecebivelConsultado) {
  return `<tr>
    <td class="marca"><span class="caixa"></span></td>
    <td class="numero">${escapar(
      seuNumeroDaParcela(conta.loja, conta.vendaNumero, conta.parcela, conta.parcelas)
    )}</td>
    <td class="loja">${escapar(conta.loja)}</td>
    <td>
      ${escapar(conta.clienteNome ?? "—")}
      ${conta.clienteCpfCnpj ? ` <span class="doc">${escapar(conta.clienteCpfCnpj)}</span>` : ""}
      ${conta.vendaCancelada ? `<span class="alerta">venda cancelada</span>` : ""}
    </td>
    <td class="valor">${moeda(conta.valor)}</td>
    <td class="situacao">${escapar(rotuloDaSituacao(conta.situacao))}</td>
  </tr>`
}

/**
 * A faixa que abre cada dia de vencimento.
 *
 * É o cabeçalho de um maço da gaveta: a data por extenso, quantos papéis
 * esperar ali e quanto somam. O total do dia é o que permite conferir o maço
 * sem somar de cabeça — se bate, o maço está completo.
 */
function faixaDoDia({
  dia,
  contas,
  hoje,
}: {
  dia: string
  contas: RecebivelConsultado[]
  hoje: number
}) {
  const data = inicioDoDia(dia)
  const atraso = Math.round((hoje - data.getTime()) / 86_400_000)
  // Só chama de atrasado o que ainda não foi pago: numa folha de boletos pagos,
  // "venceu há 20 dias" seria cobrança de uma dívida que não existe mais.
  const temEmAberto = contas.some((conta) => SITUACOES_EM_ABERTO.includes(conta.situacao))

  const soma = contas.reduce((acc, conta) => acc + conta.valor, 0)
  const diaDaSemana = data.toLocaleDateString("pt-BR", { weekday: "long" })

  return `<tr class="faixa">
    <td colspan="4">
      <span class="dia">${data.toLocaleDateString("pt-BR")}</span>
      <span class="semana">${escapar(diaDaSemana)}</span>
      ${
        temEmAberto && atraso > 0
          ? `<span class="alerta">venceu há ${atraso} ${atraso === 1 ? "dia" : "dias"}</span>`
          : temEmAberto && atraso === 0
            ? `<span class="alerta">vence hoje</span>`
            : ""
      }
      <span class="quantos">${contas.length} ${contas.length === 1 ? "boleto" : "boletos"}</span>
    </td>
    <td class="valor">${moeda(soma)}</td>
    <td></td>
  </tr>`
}

function folha({
  titulo,
  instrucao,
  periodo,
  recebiveis,
  total,
  cortadas,
  emitidoPor,
}: {
  titulo: string
  instrucao: string
  periodo: string
  recebiveis: RecebivelConsultado[]
  total: number
  cortadas: number
  emitidoPor: string
}) {
  const hoje = new Date().setHours(0, 0, 0, 0)

  /**
   * Um maço por DIA DE VENCIMENTO, que é como a gaveta é arquivada.
   *
   * Agrupar por loja seria a ordem do sistema, não a do arquivo: quem retira os
   * boletos abre a gaveta num dia e tira o que estiver ali, das quatro lojas
   * juntas. A loja virou coluna — informação que a linha carrega, não eixo pelo
   * qual a folha se organiza.
   *
   * A consulta já vem ordenada por vencimento, então basta quebrar quando o dia
   * muda: um `Map` reordenaria nada, mas deixaria a intenção menos óbvia.
   */
  const dias: { dia: string; contas: RecebivelConsultado[] }[] = []
  for (const conta of recebiveis) {
    const dia = emDia(new Date(conta.vencimento))
    const ultimo = dias[dias.length - 1]
    if (ultimo && ultimo.dia === dia) ultimo.contas.push(conta)
    else dias.push({ dia, contas: [conta] })
  }

  const corpo = dias
    .map(
      ({ dia, contas }) =>
        faixaDoDia({ dia, contas, hoje }) + contas.map((conta) => linha(conta)).join("")
    )
    .join("")

  const tabela = `<table>
    <thead>
      <tr>
        <th class="marca">✓</th>
        <th class="numero">Nº do documento</th>
        <th class="loja">Loja</th>
        <th>Cliente</th>
        <th class="valor">Valor</th>
        <th class="situacao">Situação</th>
      </tr>
    </thead>
    <tbody>${corpo}</tbody>
  </table>`

  const vazia = `<p class="vazia">Nenhum boleto neste recorte — nada a conferir na gaveta.</p>`

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escapar(titulo)} · ${escapar(periodo)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm 10mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5px; line-height: 1.3;
  }
  h1 { font-size: 17px; margin: 0; }
  header { border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 4px; }
  .instrucao { font-weight: 700; font-size: 12px; margin-top: 3px; }
  .contexto { margin-top: 3px; color: #333; }
  .aviso { margin-top: 4px; font-weight: 700; }

  table { width: 100%; border-collapse: collapse; }
  /* Repete o cabeçalho em toda página: sem isto, da segunda folha em diante as
     colunas viram números sem nome. */
  thead { display: table-header-group; }
  th, td { text-align: left; padding: 3px 4px; vertical-align: top; }
  th {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 1px solid #000;
    /* Sem isto "Nº do boleto" quebra em duas linhas e desalinha o cabeçalho. */
    white-space: nowrap;
  }
  tbody tr { border-bottom: 1px solid #bbb; break-inside: avoid; }

  /* O quadradinho de riscar: é o motivo de a folha existir em papel. Quadrado
     de verdade, num span — com a borda na célula, a caixa esticava junto com a
     linha e virava um retângulo alto quando o cliente tinha nome e documento. */
  .marca { width: 9mm; }
  .caixa { display: block; width: 4.5mm; height: 4.5mm; border: 1px solid #000; }
  .numero { width: 26mm; font-family: ui-monospace, Menlo, monospace; font-weight: 700; font-size: 11.5px; }
  .loja { width: 13mm; }
  .quantos { font-weight: 400; font-size: 9px; margin-left: 8px; white-space: nowrap; }
  .valor { width: 24mm; text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
  .situacao { width: 24mm; font-size: 9px; }
  .alerta { display: block; font-size: 8.5px; font-weight: 700; }

  /*
   * A faixa que abre o maço do dia. Cinza claro com texto preto: a folha inteira
   * é para ser lida, e faixa preta a cada poucas linhas pesa a página e gasta
   * toner. Os filetes acima e abaixo fazem o trabalho que o contraste fazia —
   * separam o maço sem escurecer nada.
   *
   * print-color-adjust: exact impede o navegador de "economizar tinta" e
   * descartar o fundo na impressão, o que apagaria a divisão entre os dias.
   */
  .faixa td {
    background: #e9e9e9; color: #000; font-weight: 700; padding: 3px 4px;
    border-top: 1px solid #000; border-bottom: 1px solid #000;
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
    /* Faixa no pé da página, com o maço na seguinte, manda a pessoa ao dia errado. */
    break-after: avoid;
  }
  .faixa .dia { font-size: 12px; font-variant-numeric: tabular-nums; }
  .faixa .semana { font-weight: 400; font-size: 9px; margin-left: 5px; color: #333; }
  .faixa .alerta { display: inline; margin-left: 8px; font-size: 9px; }
  /* Um respiro antes do próximo dia, sem separar a faixa do seu primeiro boleto. */
  .faixa + tr td { padding-top: 4px; }
  tbody tr.faixa:not(:first-child) td { border-top: 6px solid #fff; }
  /* Ao lado do nome, e não embaixo: uma linha a menos por boleto é uma folha a
     menos a cada quarenta, e quem confere de pé agradece. */
  .doc { font-size: 8.5px; color: #444; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fraco { color: #666; font-weight: 400; font-style: italic; }
  .vazia { margin: 20px 0; font-style: italic; }

  .total {
    margin-top: 8px; padding-top: 5px; border-top: 2px solid #000;
    display: flex; justify-content: space-between; font-size: 13px; font-weight: 700;
    break-inside: avoid;
  }
  .assinatura {
    margin-top: 14mm; display: flex; gap: 12mm; break-inside: avoid;
  }
  .assinatura div { flex: 1; border-top: 1px solid #000; padding-top: 3px; font-size: 9px; }
  .rodape { margin-top: 6px; font-size: 8.5px; color: #444; }
</style>
</head>
<body>
  <header>
    <h1>${escapar(titulo)}</h1>
    <div class="instrucao">${escapar(instrucao)}</div>
    <div class="contexto">
      Vencimento entre ${escapar(periodo)} · agrupado por dia de vencimento: cada faixa cinza é um maço da gaveta,
      com quantos papéis esperar e quanto somam.
      <br>
      <strong>Nº do documento</strong> é o que está impresso no boleto (ex.: <strong>QI000003-1</strong> = loja QI, venda 3, parcela 1) — é por ele que se acha o papel.
    </div>
    ${
      cortadas > 0
        ? `<div class="aviso">Atenção: a folha mostra os ${LIMITE_IMPRESSAO} primeiros de ${total}. Outros ${cortadas} ficaram de fora — reduza o período para conferir o resto.</div>`
        : ""
    }
  </header>

  ${recebiveis.length === 0 ? vazia : tabela}

  ${
    recebiveis.length > 0
      ? `<div class="total">
    <span>${recebiveis.length} ${recebiveis.length === 1 ? "boleto" : "boletos"} nesta folha</span>
    <span>${moeda(recebiveis.reduce((acc, conta) => acc + conta.valor, 0))}</span>
  </div>
  <div class="assinatura">
    <div>Conferido por</div>
    <div>Data</div>
  </div>`
      : ""
  }

  <div class="rodape">
    Emitida em ${new Date().toLocaleString("pt-BR")} por ${escapar(emitidoPor)} · documento interno, sem valor fiscal.
  </div>
</body>
</html>`
}
