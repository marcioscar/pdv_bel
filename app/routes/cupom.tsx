import type { Route } from "./+types/cupom"
import { db } from "~/lib/db.server"
import { dadosDaLoja } from "~/lib/lojas.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { CONDICOES_PAGAMENTO, FORMAS_PAGAMENTO } from "~/lib/pdv"
import { exigirUsuario } from "~/lib/sessao.server"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

function escapar(texto: string) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatarCnpj(d: string) {
  return d.length === 14
    ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
    : d
}

/**
 * Cupom **não fiscal** da venda, em HTML, medido para bobina de 80mm.
 *
 * HTML e não PDF de propósito: o navegador imprime direto, sem depender de
 * biblioteca de PDF no servidor, e a impressora térmica recebe do driver comum.
 * A largura útil considerada é 72mm — os 80mm da bobina menos as margens que a
 * própria impressora reserva.
 *
 * "NÃO FISCAL" aparece grande e no rodapé: este documento não substitui NF-e, e
 * um cupom que pareça fiscal sem ser é problema do lojista, não do cliente.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  if (!OBJECT_ID.test(params.vendaId ?? "")) {
    throw new Response("Venda inválida", { status: 400 })
  }

  const venda = await db.venda.findUnique({ where: { id: params.vendaId } })
  if (!venda) throw new Response("Venda não encontrada", { status: 404 })
  if (venda.loja !== eu.loja) {
    throw new Response(`Venda da loja ${venda.loja}`, { status: 403 })
  }

  const [loja, cobrancas] = await Promise.all([
    dadosDaLoja(venda.loja),
    venda.forma === "prazo"
      ? db.cobranca.findMany({ where: { vendaId: venda.id }, orderBy: { parcela: "asc" } })
      : Promise.resolve([]),
  ])

  const forma =
    FORMAS_PAGAMENTO.find((f) => f.id === venda.forma)?.rotulo ?? venda.forma
  const condicao = CONDICOES_PAGAMENTO.find((c) => c.id === venda.condicao)

  const itens = venda.itens
    .map(
      (item) => `<tr class="item">
        <td colspan="3">${escapar(item.descricao)}</td>
      </tr>
      <tr class="valores">
        <td>${formatarQuantidade(item.quantidade)} ${escapar(item.unidade)} x ${moeda(item.preco)}</td>
        <td></td>
        <td class="dir">${moeda(item.subtotal)}</td>
      </tr>`
    )
    .join("")

  const parcelas = cobrancas
    .map(
      (c) => `<tr><td>${c.parcela}/${c.parcelas} · vence ${new Date(
        c.vencimento
      ).toLocaleDateString("pt-BR")}</td><td class="dir">${moeda(c.valor)}</td></tr>
      ${c.linhaDigitavel ? `<tr><td colspan="2" class="linha">${escapar(c.linhaDigitavel)}</td></tr>` : ""}`
    )
    .join("")

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Cupom da venda ${venda.numero} · ${venda.loja}</title>
<style>
  /* A bobina é contínua: a altura acompanha o conteúdo, não uma folha. */
  @page { size: 80mm auto; margin: 2mm 3mm; }
  * { box-sizing: border-box; }
  body {
    width: 72mm; margin: 0 auto; padding: 0;
    font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
    font-size: 11px; line-height: 1.35; color: #000; background: #fff;
  }
  .centro { text-align: center; }
  .dir { text-align: right; }
  .forte { font-weight: 700; }
  .titulo { font-size: 13px; font-weight: 700; }
  .selo { font-size: 12px; font-weight: 700; letter-spacing: .08em; margin: 3px 0; }
  .separador { border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0; vertical-align: top; }
  .item td { padding-top: 2px; }
  .valores td { color: #000; }
  .total { font-size: 16px; font-weight: 700; }
  .linha { font-size: 9px; word-break: break-all; padding-bottom: 3px; }
  .rodape { font-size: 9px; margin-top: 6px; }
  /* Sobra no fim para a serrilha não cortar o texto. */
  .corte { height: 12mm; }
</style>
</head>
<body>
  <div class="centro">
    <div class="titulo">${escapar(loja.razaoSocial ?? loja.nome)}</div>
    <div>${escapar(loja.nome)} · CNPJ ${formatarCnpj(loja.cnpj)}</div>
    ${loja.endereco ? `<div>${escapar(loja.endereco)}</div>` : ""}
    ${loja.bairro ? `<div>${escapar(loja.bairro)} · ${escapar(loja.cidade ?? "")}/${escapar(loja.uf ?? "")}</div>` : ""}
    ${loja.telefone ? `<div>${escapar(loja.telefone)}</div>` : ""}
    <div class="selo">CUPOM NÃO FISCAL</div>
  </div>

  <div class="separador"></div>
  <table>
    <tr><td>Venda</td><td class="dir forte">#${venda.numero}</td></tr>
    <tr><td>${new Date(venda.criadaEm).toLocaleString("pt-BR")}</td><td class="dir">caixa ${escapar(venda.caixa)}</td></tr>
    <tr><td colspan="2">Operador: ${escapar(venda.operador)}</td></tr>
    <tr><td colspan="2">Cliente: ${escapar(venda.clienteNome ?? "Consumidor Final")}</td></tr>
  </table>

  <div class="separador"></div>
  <table>${itens}</table>

  <div class="separador"></div>
  <table>
    <tr><td>Subtotal</td><td class="dir">${moeda(venda.subtotal)}</td></tr>
    ${venda.desconto > 0 ? `<tr><td>Desconto</td><td class="dir">- ${moeda(venda.desconto)}</td></tr>` : ""}
    <tr class="total"><td>TOTAL</td><td class="dir">${moeda(venda.total)}</td></tr>
  </table>

  <div class="separador"></div>
  <table>
    <tr><td>Pagamento</td><td class="dir forte">${escapar(forma)}</td></tr>
    ${venda.recebido !== null ? `<tr><td>Recebido</td><td class="dir">${moeda(venda.recebido)}</td></tr>` : ""}
    ${venda.troco !== null && venda.troco > 0 ? `<tr><td>Troco</td><td class="dir forte">${moeda(venda.troco)}</td></tr>` : ""}
    ${condicao ? `<tr><td colspan="2">Condição: ${escapar(condicao.rotulo)}</td></tr>` : ""}
  </table>
  ${parcelas ? `<div class="separador"></div><table>${parcelas}</table>` : ""}

  <div class="separador"></div>
  <div class="centro rodape">
    Documento sem valor fiscal<br>
    Obrigado pela preferência!
  </div>
  <div class="corte"></div>
</body>
</html>`

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, max-age=60",
    },
  })
}
