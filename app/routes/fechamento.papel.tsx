import type { Route } from "./+types/fechamento.papel"
import { diferencaRelevante, rotuloDoMovimento } from "~/lib/caixa"
import { db } from "~/lib/db.server"
import { diaEmTexto } from "~/lib/dia"
import { escapar } from "~/lib/html"
import { dadosDaLoja } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { exigirUsuario, podeVerDaLoja } from "~/lib/sessao.server"

/**
 * O comprovante do fechamento, para assinar e guardar com o dinheiro.
 *
 * Mostra a CONTA, não só o resultado: troco da abertura, vendas em dinheiro,
 * sangrias e reforços, um abaixo do outro, até o esperado. Um papel que só
 * dissesse "esperado 1.240,00 · contado 1.235,00" obrigaria a voltar ao sistema
 * para entender de onde saiu o número — e quem confere caixa faz isso de pé, com
 * o dinheiro na mão.
 *
 * Sai em duas vias: uma vai com o malote, a outra fica na loja.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const fechamento = await db.fechamentoCaixa.findUnique({
    where: { id: params.fechamentoId },
  })
  if (!fechamento) throw new Response("Fechamento não encontrado", { status: 404 })
  if (!podeVerDaLoja(eu, fechamento.loja)) {
    throw new Response(`Fechamento da loja ${fechamento.loja}`, { status: 403 })
  }

  const [loja, movimentos] = await Promise.all([
    dadosDaLoja(fechamento.loja),
    db.movimentoCaixa.findMany({
      where: { loja: fechamento.loja, dia: fechamento.dia },
      orderBy: { criadoEm: "asc" },
    }),
  ])

  const linha = (rotulo: string, valor: number, opcoes?: { negativo?: boolean }) =>
    `<tr>
      <td>${escapar(rotulo)}</td>
      <td class="valor${opcoes?.negativo ? " menos" : ""}">${opcoes?.negativo ? "− " : ""}${moeda(Math.abs(valor))}</td>
    </tr>`

  const lancamentos = movimentos
    .map(
      (m) => `<tr>
        <td class="hora">${new Date(m.criadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</td>
        <td>${escapar(rotuloDoMovimento(m.tipo))}${m.observacao ? ` · ${escapar(m.observacao)}` : ""}
          <span class="quem">${escapar(m.operador)}</span></td>
        <td class="valor${m.tipo === "sangria" ? " menos" : ""}">${m.tipo === "sangria" ? "− " : ""}${moeda(m.valor)}</td>
      </tr>`
    )
    .join("")

  const grave = diferencaRelevante(fechamento.diferenca)
  const sobra = fechamento.diferenca > 0

  const via = (rotulo: string) => `<section class="via">
    <header>
      <div class="topo">
        <h1>Fechamento de caixa</h1>
        <span class="rotulo-via">${rotulo}</span>
      </div>
      <div class="identificacao">
        <span class="loja">${escapar(fechamento.loja)} · ${escapar(loja.nome)}</span>
        <span class="dia">${diaEmTexto(fechamento.dia)}</span>
      </div>
      <div class="linha-info">
        Fechado por ${escapar(fechamento.fechadoPor)} em
        ${new Date(fechamento.fechadoEm).toLocaleString("pt-BR")}
      </div>
    </header>

    <div class="colunas">
      <div class="bloco">
        <h2>Dinheiro na gaveta</h2>
        <table class="conta">
          ${linha("Troco da abertura", fechamento.abertura)}
          ${linha("Vendas em dinheiro", fechamento.vendasDinheiro)}
          ${fechamento.suprimentos > 0 ? linha("Reforços", fechamento.suprimentos) : ""}
          ${fechamento.sangrias > 0 ? linha("Sangrias", fechamento.sangrias, { negativo: true }) : ""}
          <tr class="soma">
            <td>Deve haver</td>
            <td class="valor">${moeda(fechamento.esperado)}</td>
          </tr>
          <tr class="soma">
            <td>Contado na gaveta</td>
            <td class="valor">${moeda(fechamento.contado)}</td>
          </tr>
          <tr class="diferenca${grave ? " grave" : ""}">
            <td>${sobra ? "SOBRA" : fechamento.diferenca < 0 ? "FALTA" : "Diferença"}</td>
            <td class="valor">${moeda(Math.abs(fechamento.diferenca))}</td>
          </tr>
        </table>
        ${fechamento.observacao ? `<p class="obs">${escapar(fechamento.observacao)}</p>` : ""}
      </div>

      <div class="bloco">
        <h2>Vendas do dia</h2>
        <table class="conta">
          ${linha("Dinheiro", fechamento.vendasDinheiro)}
          ${linha("Pix", fechamento.vendasPix)}
          ${linha("Débito", fechamento.vendasDebito)}
          ${linha("Crédito", fechamento.vendasCredito)}
          ${linha("A prazo", fechamento.vendasPrazo)}
          <tr class="soma">
            <td>Total vendido</td>
            <td class="valor">${moeda(fechamento.totalVendido)}</td>
          </tr>
        </table>
        <p class="obs">
          ${fechamento.quantidadeVendas} ${fechamento.quantidadeVendas === 1 ? "venda" : "vendas"}${
            fechamento.canceladas > 0
              ? ` · ${fechamento.canceladas} cancelada${fechamento.canceladas === 1 ? "" : "s"}, fora da conta`
              : ""
          }
        </p>
      </div>
    </div>

    ${
      lancamentos
        ? `<div class="bloco largo">
            <h2>Lançamentos na gaveta</h2>
            <table class="lancamentos">${lancamentos}</table>
          </div>`
        : ""
    }

    <div class="assinaturas">
      <div>Conferido por</div>
      <div>Conferido por (2ª pessoa)</div>
      <div class="data">Data</div>
    </div>
  </section>`

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Fechamento ${escapar(fechamento.loja)} · ${diaEmTexto(fechamento.dia)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5px; line-height: 1.35;
  }

  /* Duas vias: uma vai com o malote, a outra fica na loja. */
  .via { padding-bottom: 6mm; }
  .via + .via { border-top: 1px dashed #666; padding-top: 6mm; }

  .topo { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  h1 { font-size: 15px; margin: 0; }
  .rotulo-via {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .08em;
    border: 1px solid #000; padding: 1px 5px; white-space: nowrap;
  }
  .identificacao {
    margin-top: 4px; padding: 4px 0;
    border-top: 2px solid #000; border-bottom: 1px solid #000;
    display: flex; justify-content: space-between; align-items: baseline;
  }
  .loja { font-size: 14px; font-weight: 700; }
  .dia { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .linha-info { margin-top: 3px; font-size: 9px; color: #333; }

  .colunas { display: flex; gap: 8mm; margin-top: 5px; }
  .bloco { flex: 1; }
  .bloco.largo { flex: none; margin-top: 5px; }
  h2 {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em;
    margin: 0 0 3px; padding-bottom: 2px; border-bottom: 1px solid #000;
  }

  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .valor {
    text-align: right; font-family: ui-monospace, Menlo, monospace;
    font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .menos { }
  .conta .soma td {
    border-top: 1px solid #000; font-weight: 700; padding-top: 3px;
  }

  /*
   * A diferença é o número que a pessoa procura primeiro. Fica em corpo maior e,
   * quando passa de um real, ganha moldura — para quem folheia um maço de
   * fechamentos achar os dias problemáticos sem ler nenhum deles.
   */
  .conta .diferenca td {
    border-top: 2px solid #000; padding-top: 4px;
    font-size: 13px; font-weight: 700;
  }
  .conta .diferenca.grave td {
    border: 2px solid #000; padding: 4px;
    background: #e9e9e9;
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }

  .lancamentos td { border-bottom: 1px solid #ddd; font-size: 9.5px; }
  .hora { width: 12mm; font-family: ui-monospace, Menlo, monospace; color: #444; }
  .quem { color: #666; margin-left: 4px; }
  .obs { margin: 3px 0 0; font-size: 9px; color: #333; }

  .assinaturas { margin-top: 14mm; display: flex; gap: 8mm; break-inside: avoid; }
  .assinaturas div {
    flex: 1; border-top: 1px solid #000; padding-top: 3px; font-size: 8.5px;
  }
  .assinaturas .data { flex: 0 0 28mm; }
</style>
</head>
<body>
  ${via("Via do malote")}
  ${via("Via da loja")}
</body>
</html>`

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}
