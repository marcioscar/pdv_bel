import type { Route } from "./+types/pedido-compra.impressao"
import { db } from "~/lib/db.server"
import { escapar } from "~/lib/html"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"

/**
 * O papel que se manda ao fornecedor, ou que fica com quem liga cobrando entrega.
 *
 * Uma via só — ao contrário do romaneio, este documento não viaja com
 * mercadoria física para duas pessoas conferirem; é o pedido em si, e uma cópia
 * já basta para negociar e para arquivar.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  await exigirGerente(request, "verRelatorios")

  const pedido = await db.pedidoDeCompra.findUnique({ where: { id: params.pedidoId } })
  if (!pedido) throw new Response("Pedido não encontrado", { status: 404 })

  const fornecedor = await db.fornecedor.findUnique({ where: { id: pedido.fornecedorId } })

  const SITUACAO: Record<string, string> = {
    rascunho: "Rascunho — ainda não enviado",
    enviado: "Enviado ao fornecedor",
    recebido: "Recebido",
    cancelado: "Cancelado",
  }

  const linhas = pedido.itens
    .map(
      (item, i) => `<tr>
        <td class="ordem">${i + 1}</td>
        <td class="codigo">${escapar(item.codigo)}</td>
        <td>${escapar(item.descricao)}</td>
        <td class="un">${escapar(item.unidade)}</td>
        <td class="qtd">${formatarQuantidade(item.quantidade)}</td>
        <td class="valor">${moeda(item.custoUnitario)}</td>
        <td class="valor">${moeda(item.total)}</td>
      </tr>`
    )
    .join("")

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Pedido de compra #${pedido.numero} · ${escapar(pedido.fornecedorNome)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px; line-height: 1.35;
  }

  .topo { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  h1 { font-size: 18px; margin: 0; }
  .numero { font-family: ui-monospace, Menlo, monospace; }
  .situacao {
    font-size: 9px; text-transform: uppercase; letter-spacing: .06em;
    border: 1px solid #000; padding: 2px 6px; white-space: nowrap;
  }

  .fornecedor {
    margin-top: 6px; padding: 6px 0; border-top: 2px solid #000; border-bottom: 1px solid #000;
  }
  .fornecedor .nome { font-size: 15px; font-weight: 700; }
  .fornecedor .detalhe { margin-top: 2px; font-size: 10px; color: #333; }
  .linha-info { margin-top: 4px; font-size: 9.5px; color: #333; }

  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 4px 5px; vertical-align: top; }
  th {
    font-size: 9px; text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 1px solid #000; white-space: nowrap;
  }
  tbody tr { border-bottom: 1px solid #ccc; break-inside: avoid; }
  tfoot td { border-top: 1.5px solid #000; font-weight: 700; padding-top: 6px; }

  .ordem { width: 7mm; color: #666; }
  .codigo { width: 20mm; font-family: ui-monospace, Menlo, monospace; }
  .un { width: 12mm; }
  .qtd, .valor { width: 24mm; text-align: right; font-family: ui-monospace, Menlo, monospace; }
  .qtd { font-weight: 700; }

  .observacao {
    margin-top: 8mm; padding: 4px 6px; border: 1px solid #999; font-size: 10px;
  }

  .assinaturas { margin-top: 16mm; display: flex; gap: 10mm; break-inside: avoid; }
  .assinaturas div {
    flex: 1; border-top: 1px solid #000; padding-top: 3px; font-size: 9px;
  }
</style>
</head>
<body>
  <div class="topo">
    <h1>Pedido de compra <span class="numero">#${pedido.numero}</span></h1>
    <span class="situacao">${SITUACAO[pedido.situacao] ?? pedido.situacao}</span>
  </div>

  <div class="fornecedor">
    <div class="nome">${escapar(pedido.fornecedorNome)}</div>
    ${
      fornecedor
        ? `<div class="detalhe">
            ${fornecedor.razaoSocial !== pedido.fornecedorNome ? escapar(fornecedor.razaoSocial) + " · " : ""}
            ${escapar(fornecedor.cidade)}${fornecedor.bairro ? " · " + escapar(fornecedor.bairro) : ""}
            ${fornecedor.documento ? " · " + escapar(fornecedor.documento) : ""}
          </div>`
        : ""
    }
  </div>

  <div class="linha-info">
    Pedido em ${new Date(pedido.criadoEm).toLocaleString("pt-BR")} por ${escapar(pedido.criadoPor)}
    ${pedido.enviadoEm ? ` · enviado em ${new Date(pedido.enviadoEm).toLocaleString("pt-BR")}` : ""}
  </div>

  <table>
    <thead>
      <tr>
        <th class="ordem">#</th>
        <th class="codigo">Código</th>
        <th>Produto</th>
        <th class="un">Un</th>
        <th class="qtd">Qtd</th>
        <th class="valor">Unitário</th>
        <th class="valor">Total</th>
      </tr>
    </thead>
    <tbody>${linhas}</tbody>
    <tfoot>
      <tr>
        <td colspan="6">${pedido.itens.length} ${pedido.itens.length === 1 ? "produto" : "produtos"}</td>
        <td class="valor">${moeda(pedido.total)}</td>
      </tr>
    </tfoot>
  </table>

  ${pedido.observacao ? `<div class="observacao">${escapar(pedido.observacao)}</div>` : ""}

  <div class="assinaturas">
    <div>Pedido por</div>
    <div>Confirmado pelo fornecedor</div>
  </div>
</body>
</html>`

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}
