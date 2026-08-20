import type { Route } from "./+types/sangria.comprovante"
import { rotuloDoMovimento } from "~/lib/caixa"
import { db } from "~/lib/db.server"
import { diaEmTexto } from "~/lib/dia"
import { escapar } from "~/lib/html"
import { dadosDaLoja } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { exigirUsuario, podeVerDaLoja } from "~/lib/sessao.server"

/**
 * O comprovante do dinheiro que sai da gaveta, para viajar junto com ele.
 *
 * O papel do fechamento só existe no fim do dia — e o dinheiro sai antes disso,
 * às duas da tarde, com alguém atravessando a cidade. Entre a mão que tira da
 * gaveta e a mão que recebe do outro lado não havia documento nenhum, e é
 * exatamente esse trecho que ninguém consegue reconstituir depois.
 *
 * Duas vias numa folha: quem leva fica com uma assinada por quem entregou, e a
 * loja fica com a outra assinada por quem levou. Cada ponta guarda a prova
 * contra a outra, que é o que faz um comprovante valer.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const movimento = await db.movimentoCaixa.findUnique({
    where: { id: params.movimentoId },
  })
  if (!movimento) throw new Response("Lançamento não encontrado", { status: 404 })
  if (!podeVerDaLoja(eu, movimento.loja)) {
    throw new Response(`Lançamento da loja ${movimento.loja}`, { status: 403 })
  }

  const loja = await dadosDaLoja(movimento.loja)
  const saiu = movimento.tipo === "sangria"

  const via = (rotulo: string, assina: string) => `<section class="via">
    <div class="topo">
      <h1>${saiu ? "Retirada de caixa" : escapar(rotuloDoMovimento(movimento.tipo))}</h1>
      <span class="rotulo-via">${rotulo}</span>
    </div>

    <div class="identificacao">
      <span>${escapar(movimento.loja)} · ${escapar(loja.nome)}</span>
      <span class="dia">
        ${diaEmTexto(movimento.dia)}
        ${new Date(movimento.criadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>

    <div class="valor">
      <span class="rotulo">${saiu ? "Saiu da gaveta" : "Entrou na gaveta"}</span>
      <span class="numero">${moeda(movimento.valor)}</span>
    </div>

    ${movimento.observacao ? `<p class="motivo"><b>Motivo:</b> ${escapar(movimento.observacao)}</p>` : ""}
    <p class="motivo"><b>Lançado por:</b> ${escapar(movimento.operador)}</p>
    ${
      movimento.autorizadaPor
        ? `<p class="motivo"><b>Liberado por:</b> ${escapar(movimento.autorizadaPor)}</p>`
        : ""
    }

    <div class="assinaturas">
      <div>${escapar(assina)}</div>
      <div class="data">Data e hora</div>
    </div>
  </section>`

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${saiu ? "Retirada" : "Lançamento"} ${escapar(movimento.loja)} · ${moeda(movimento.valor)}</title>
<style>
  /* Meia folha por via: o comprovante viaja dobrado no bolso ou no malote, e uma
     A4 inteira para quatro linhas é papel jogado fora. */
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px; line-height: 1.4;
  }
  .via { padding-bottom: 10mm; }
  .via + .via { border-top: 1px dashed #666; padding-top: 10mm; }

  .topo { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  h1 { font-size: 16px; margin: 0; }
  .rotulo-via {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .08em;
    border: 1px solid #000; padding: 1px 5px; white-space: nowrap;
  }
  .identificacao {
    margin-top: 4px; padding: 4px 0;
    border-top: 2px solid #000; border-bottom: 1px solid #000;
    display: flex; justify-content: space-between; font-size: 13px; font-weight: 700;
  }
  .dia { font-variant-numeric: tabular-nums; }

  /*
   * O valor grande e emoldurado: é o único número do documento, e é o que as
   * duas pessoas conferem antes de assinar. Pequeno, no meio do texto, seria
   * assinado sem ser lido.
   */
  .valor {
    margin-top: 6mm; border: 2px solid #000; padding: 5mm;
    display: flex; align-items: baseline; justify-content: space-between;
  }
  .valor .rotulo { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
  .valor .numero {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums;
  }

  .motivo { margin: 3mm 0 0; }
  .assinaturas { margin-top: 16mm; display: flex; gap: 10mm; }
  .assinaturas div {
    flex: 1; border-top: 1px solid #000; padding-top: 3px; font-size: 9px;
  }
  .assinaturas .data { flex: 0 0 40mm; }
</style>
</head>
<body>
  ${via("Via de quem leva", saiu ? "Entregue por" : "Recebido por")}
  ${via("Via da loja", saiu ? "Recebido por (quem levou)" : "Entregue por")}
</body>
</html>`

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}
