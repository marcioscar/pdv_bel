import type { Route } from "./+types/pedido-compra.impressao"
import { db } from "~/lib/db.server"
import { escapar } from "~/lib/html"
import { formatarCpfCnpj } from "~/lib/documento"
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

  const [fornecedor, comprador] = await Promise.all([
    db.fornecedor.findUnique({ where: { id: pedido.fornecedorId } }),
    /**
     * Quem compra é a matriz.
     *
     * O pedido é da rede — não tem loja, porque o ponto de pedido soma o
     * estoque das quatro. Mas o papel precisa de um CNPJ e um endereço para o
     * fornecedor faturar e entregar, e esse é o da matriz (`ordem` 1), que é
     * também quem recebe o caminhão.
     */
    db.loja.findFirst({ where: { ativo: true }, orderBy: { ordem: "asc" } }),
  ])

  // URL absoluta: caminho relativo não resolve quando a página é impressa a
  // partir de um contexto sem origem (o cupom já apanhou disso).
  const logo = comprador?.logo ? new URL(comprador.logo, request.url).href : null

  const SITUACAO: Record<string, string> = {
    rascunho: "Rascunho — ainda não enviado",
    enviado: "Enviado ao fornecedor",
    parcial: "Entregue em parte",
    recebido: "Recebido",
    cancelado: "Cancelado",
  }

  const dia = (data: Date) => new Date(data).toLocaleDateString("pt-BR")
  const instante = (data: Date) =>
    new Date(data).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })

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

  const totalItens = pedido.itens.reduce((soma, i) => soma + i.quantidade, 0)

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Pedido de compra #${pedido.numero} · ${escapar(pedido.fornecedorNome)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #111; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px; line-height: 1.4;
  }

  /* ---- cabeçalho ---- */
  .cabecalho {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 8mm; padding-bottom: 4mm; border-bottom: 2.5px solid #111;
  }
  .marca { display: flex; align-items: center; gap: 4mm; min-width: 0; }
  /*
   * O logo pode ser colorido; numa impressora monocromática a cor vira
   * meio-tom pontilhado e suja o traço. grayscale+contrast resolve, e
   * print-color-adjust impede o navegador de descartar o desenho para
   * "economizar tinta" — o mesmo tratamento já usado no cupom.
   */
  .logo {
    height: 16mm; width: auto; max-width: 45mm;
    filter: grayscale(1) contrast(1.6);
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  .empresa .nome { font-size: 12px; font-weight: 700; }
  .empresa .linha { font-size: 9px; color: #444; }

  .identificacao { text-align: right; white-space: nowrap; }
  .identificacao .rotulo {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .1em; color: #666;
  }
  .identificacao .numero {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 24px; font-weight: 700; line-height: 1.1;
  }
  .situacao {
    display: inline-block; margin-top: 2px;
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .07em;
    border: 1px solid #111; border-radius: 2px; padding: 2px 6px;
  }

  /* ---- fornecedor e entrega, lado a lado ---- */
  .blocos { display: flex; gap: 4mm; margin-top: 4mm; }
  .bloco { flex: 1; border: 1px solid #bbb; border-radius: 3px; padding: 3mm 3.5mm; }
  .bloco.destaque { border-color: #111; border-width: 1.5px; flex: 0 0 52mm; }
  .bloco .titulo {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .1em;
    color: #666; margin-bottom: 1.5mm;
  }
  .bloco .principal { font-size: 14px; font-weight: 700; line-height: 1.25; }
  .bloco .detalhe { margin-top: 1mm; font-size: 9.5px; color: #333; }
  .data-grande { font-size: 17px; font-weight: 700; font-family: ui-monospace, Menlo, monospace; }
  .sem-data { font-size: 11px; color: #888; font-style: italic; }

  /* ---- itens ---- */
  table { width: 100%; border-collapse: collapse; margin-top: 4mm; }
  th, td { text-align: left; padding: 1.6mm 2mm; vertical-align: top; }
  thead th {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .07em; color: #444;
    border-bottom: 1.5px solid #111; white-space: nowrap;
  }
  /* Zebra: com trinta linhas de saco plástico de nomes quase iguais, é o que
     impede o olho de pular de linha ao conferir a quantidade. */
  tbody tr:nth-child(even) { background: #f4f4f4; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  tbody tr { border-bottom: 1px solid #ddd; break-inside: avoid; }
  tfoot td {
    border-top: 1.5px solid #111; font-weight: 700; padding-top: 2.5mm; font-size: 12px;
  }
  /* O cabeçalho se repete quando a lista passa de uma página. */
  thead { display: table-header-group; }

  .ordem { width: 7mm; color: #888; }
  .codigo { width: 20mm; font-family: ui-monospace, Menlo, monospace; }
  .un { width: 12mm; }
  .qtd, .valor { width: 24mm; text-align: right; font-family: ui-monospace, Menlo, monospace; }
  .qtd { font-weight: 700; }

  .rodape-info { margin-top: 2mm; font-size: 9px; color: #555; }
  .observacao {
    margin-top: 5mm; padding: 2.5mm 3mm; border-left: 3px solid #111; background: #f7f7f7;
    font-size: 10px; print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  .observacao .titulo {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .1em; color: #666;
  }

  .assinaturas { margin-top: 18mm; display: flex; gap: 12mm; break-inside: avoid; }
  .assinaturas div {
    flex: 1; border-top: 1px solid #111; padding-top: 1.5mm;
    font-size: 8.5px; color: #444; text-align: center;
  }
</style>
</head>
<body>
  <div class="cabecalho">
    <div class="marca">
      ${logo ? `<img class="logo" src="${escapar(logo)}" alt="">` : ""}
      ${
        comprador
          ? `<div class="empresa">
              <div class="nome">${escapar(comprador.razaoSocial ?? comprador.nome)}</div>
              <div class="linha">CNPJ ${escapar(formatarCpfCnpj(comprador.cnpj))}</div>
              ${
                comprador.endereco
                  ? `<div class="linha">${escapar(comprador.endereco)}${
                      comprador.bairro ? " · " + escapar(comprador.bairro) : ""
                    }</div>`
                  : ""
              }
              <div class="linha">
                ${escapar(comprador.cidade ?? "")}${comprador.uf ? "/" + escapar(comprador.uf) : ""}
                ${comprador.telefone ? " · " + escapar(comprador.telefone) : ""}
              </div>
            </div>`
          : ""
      }
    </div>

    <div class="identificacao">
      <div class="rotulo">Pedido de compra</div>
      <div class="numero">#${pedido.numero}</div>
      <span class="situacao">${SITUACAO[pedido.situacao] ?? pedido.situacao}</span>
    </div>
  </div>

  <div class="blocos">
    <div class="bloco">
      <div class="titulo">Fornecedor</div>
      <div class="principal">${escapar(pedido.fornecedorNome)}</div>
      ${
        fornecedor
          ? `<div class="detalhe">
              ${
                fornecedor.razaoSocial !== pedido.fornecedorNome
                  ? escapar(fornecedor.razaoSocial) + "<br>"
                  : ""
              }
              ${fornecedor.documento ? "CNPJ/CPF " + escapar(formatarCpfCnpj(fornecedor.documento)) + " · " : ""}
              ${escapar(fornecedor.cidade)}${fornecedor.bairro ? " · " + escapar(fornecedor.bairro) : ""}
            </div>`
          : ""
      }
    </div>

    <div class="bloco destaque">
      <div class="titulo">Entrega prometida</div>
      ${
        // Em destaque, e não numa linha de rodapé: é a data que se cobra ao
        // telefone, e o papel existe justamente para ela não ser "esquecida".
        pedido.entregaPrometida
          ? `<div class="data-grande">${dia(pedido.entregaPrometida)}</div>`
          : `<div class="sem-data">a combinar</div>`
      }
      <div class="detalhe">
        Emitido ${instante(pedido.criadoEm)}<br>por ${escapar(pedido.criadoPor)}
      </div>
    </div>
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
        <td colspan="4">
          ${pedido.itens.length} ${pedido.itens.length === 1 ? "produto" : "produtos"}
        </td>
        <td class="qtd">${formatarQuantidade(totalItens)}</td>
        <td class="valor">Total</td>
        <td class="valor">${moeda(pedido.total)}</td>
      </tr>
    </tfoot>
  </table>

  ${
    pedido.enviadoEm
      ? `<div class="rodape-info">Enviado ao fornecedor em ${instante(pedido.enviadoEm)}</div>`
      : ""
  }

  ${
    pedido.observacao
      ? `<div class="observacao">
          <div class="titulo">Observação</div>
          ${escapar(pedido.observacao)}
        </div>`
      : ""
  }

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
