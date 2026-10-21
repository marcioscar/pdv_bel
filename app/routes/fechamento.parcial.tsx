import type { Route } from "./+types/fechamento.parcial"
import { rotuloDoMovimento } from "~/lib/caixa"
import { resumoDoDia } from "~/lib/caixa.server"
import { diaDeHoje, diaEmTexto } from "~/lib/dia"
import { escapar } from "~/lib/html"
import { dadosDaLoja } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { exigirUsuario } from "~/lib/sessao.server"

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * O caixa como está AGORA, para conferir no meio do dia.
 *
 * O papel do fechamento só existe depois de fechar, e nele o "contado" já foi
 * digitado. Aqui o caixa segue aberto: a folha traz a conta até o "deve haver
 * agora" e deixa o contado e a diferença em branco, para quem confere escrever
 * à mão com o dinheiro na frente. Nada é gravado — imprimir de novo uma hora
 * depois dá outra foto, e o fechamento do fim do dia continua sendo o oficial.
 *
 * A loja vem da sessão, como na tela de fechamento: pelo endereço daria para
 * ver o caixa de outra loja.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const pedido = new URL(request.url).searchParams.get("dia")
  const dia = pedido && DIA.test(pedido) ? pedido : diaDeHoje()

  const [loja, resumo] = await Promise.all([dadosDaLoja(eu.loja), resumoDoDia(eu.loja, dia)])
  const agora = new Date()

  const linha = (rotulo: string, valor: number, opcoes?: { negativo?: boolean }) =>
    `<tr>
      <td>${escapar(rotulo)}</td>
      <td class="valor">${opcoes?.negativo ? "− " : ""}${moeda(Math.abs(valor))}</td>
    </tr>`

  // Cancelado não entra na conta, e por isso também não entra na folha.
  const lancamentos = resumo.movimentos
    .filter((m) => !m.canceladoEm)
    .map(
      (m) => `<tr>
        <td class="hora">${new Date(m.criadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</td>
        <td>${escapar(rotuloDoMovimento(m.tipo))}${m.observacao ? ` · ${escapar(m.observacao)}` : ""}
          <span class="quem">${escapar(m.operador)}</span></td>
        <td class="valor">${m.tipo === "sangria" || m.tipo === "devolucao" ? "− " : ""}${moeda(m.valor)}</td>
      </tr>`
    )
    .join("")

  const folha = `<section>
    <header>
      <div class="topo">
        <h1>Conferência de caixa</h1>
        <span class="selo">Parcial · caixa ${resumo.fechamento ? "já fechado" : "aberto"}</span>
      </div>
      <div class="identificacao">
        <span class="loja">${escapar(eu.loja)} · ${escapar(loja.nome)}</span>
        <span class="dia">${diaEmTexto(dia)} · ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <div class="linha-info">
        Impresso por ${escapar(eu.nome)} em ${agora.toLocaleString("pt-BR")}.
        Retrato deste momento — vendas e lançamentos depois desta hora não estão aqui.
      </div>
    </header>

    <div class="colunas">
      <div class="bloco">
        <h2>Dinheiro na gaveta</h2>
        <table class="conta">
          ${linha("Troco da abertura", resumo.abertura)}
          ${linha("Vendas em dinheiro", resumo.vendasDinheiro)}
          ${resumo.suprimentos > 0 ? linha("Reforços", resumo.suprimentos) : ""}
          ${resumo.creditoEmDinheiro > 0 ? linha("Crédito abatido", resumo.creditoEmDinheiro, { negativo: true }) : ""}
          ${resumo.devolucoes > 0 ? linha("Devoluções", resumo.devolucoes, { negativo: true }) : ""}
          ${resumo.sangrias > 0 ? linha("Sangrias", resumo.sangrias, { negativo: true }) : ""}
          <tr class="soma">
            <td>Deve haver agora</td>
            <td class="valor">${moeda(resumo.esperado)}</td>
          </tr>
          <tr class="escrever">
            <td>Contado na gaveta</td>
            <td class="valor">R$ ____________</td>
          </tr>
          <tr class="escrever">
            <td>Diferença</td>
            <td class="valor">R$ ____________</td>
          </tr>
        </table>
        ${resumo.abertura === 0 ? `<p class="obs"><b>Caixa sem abertura lançada:</b> o troco da gaveta não está na conta.</p>` : ""}
      </div>

      <div class="bloco">
        <h2>Vendas até agora</h2>
        <table class="conta">
          ${linha("Dinheiro", resumo.vendasDinheiro)}
          ${linha("Pix", resumo.vendasPix)}
          ${linha("Débito", resumo.vendasDebito)}
          ${linha("Crédito", resumo.vendasCredito)}
          ${linha("A prazo / entrega", resumo.vendasPrazo)}
          ${resumo.vendasLink > 0 ? linha("Link de pagamento", resumo.vendasLink) : ""}
          <tr class="soma">
            <td>Total vendido</td>
            <td class="valor">${moeda(resumo.totalVendido)}</td>
          </tr>
        </table>
        <p class="obs">
          ${resumo.quantidadeVendas} ${resumo.quantidadeVendas === 1 ? "venda" : "vendas"}${
            resumo.canceladas > 0
              ? ` · ${resumo.canceladas} cancelada${resumo.canceladas === 1 ? "" : "s"}, fora da conta`
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
      <div class="data">Hora</div>
    </div>
  </section>`

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Conferência ${escapar(eu.loja)} · ${diaEmTexto(dia)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5px; line-height: 1.35;
  }

  .topo { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  h1 { font-size: 15px; margin: 0; }
  /* Para ninguém guardar esta folha no lugar do fechamento. */
  .selo {
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
  .conta .soma td {
    border-top: 1px solid #000; font-weight: 700; padding-top: 3px;
  }
  /* Espaço de verdade para a caneta: linha de tabela comum não cabe um número escrito. */
  .conta .escrever td { padding-top: 7mm; font-weight: 700; }

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
  ${folha}
</body>
</html>`

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}
