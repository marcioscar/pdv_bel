import QRCode from "qrcode"

import type { Route } from "./+types/pix.entrega"
import { db } from "~/lib/db.server"
import { formatarCpfCnpj } from "~/lib/documento"
import { escapar } from "~/lib/html"
import { dadosDaLoja } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { VALIDADE_PIX_ENTREGA_APOS_VENCIMENTO } from "~/lib/pdv"
import { atualizarPixDaEntrega } from "~/lib/pix-entrega.server"
import { exigirUsuario, podeVerDaLoja } from "~/lib/sessao.server"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * O QR do Pix na entrega, na térmica, para ir com o entregador.
 *
 * Como o do balcão, o QR vem do que o Inter devolveu ao criar a cobrança — não
 * do navegador —, e a situação é conferida antes de imprimir: QR de cobrança
 * já paga, ou tirada do ar, no papel é o cliente pagando duas vezes ou pagando
 * o nada. Se o Inter não responder, imprime com a situação guardada: o
 * entregador está saindo, e o papel de uma cobrança ainda aberta vale.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)
  if (!OBJECT_ID.test(params.vendaId ?? "")) {
    throw new Response("Venda inválida", { status: 400 })
  }

  const venda = await db.venda.findUnique({ where: { id: params.vendaId } })
  if (!venda) throw new Response("Venda não encontrada", { status: 404 })
  if (!podeVerDaLoja(eu, venda.loja)) {
    throw new Response(`Venda da loja ${venda.loja}`, { status: 403 })
  }

  const cobranca = await db.cobranca.findFirst({ where: { vendaId: venda.id, tipo: "pix" } })
  if (!cobranca?.pixCopiaECola) {
    throw new Response("Esta venda não tem Pix na entrega gerado", { status: 404 })
  }

  let situacao = cobranca.situacao
  try {
    situacao = await atualizarPixDaEntrega(cobranca)
  } catch {
    // Segue com a guardada (ver acima).
  }
  if (situacao !== "A_RECEBER" && situacao !== "ATRASADO") {
    throw new Response(
      situacao === "RECEBIDO" || situacao === "PAGO_NA_LOJA"
        ? "Este Pix já foi pago — não imprima o QR de novo"
        : `Este Pix não aceita mais pagamento (${situacao})`,
      { status: 409 }
    )
  }

  // SVG: a térmica imprime em 1 bit, e o vetor sai nítido.
  const qr = await QRCode.toString(cobranca.pixCopiaECola, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
  })
  const loja = await dadosDaLoja(venda.loja)
  const logo = loja.logo ? new URL(loja.logo, request.url).href : null
  const vence = cobranca.vencimento.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Pix na entrega · venda ${venda.numero} · ${escapar(venda.loja)}</title>
<style>
  @page { size: 80mm auto; margin: 2mm 3mm; }
  * { box-sizing: border-box; }
  body {
    width: 68mm; margin: 0 auto; padding: 0;
    font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
    font-size: 11px; line-height: 1.35; color: #000; background: #fff;
    text-align: center;
  }
  .logo {
    width: 40mm; height: auto; margin: 0 auto 2px;
    filter: grayscale(1) contrast(3);
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  .titulo { font-size: 12px; font-weight: 700; }
  .selo {
    font-size: 13px; font-weight: 700; letter-spacing: .08em;
    margin: 5px 0 2px; border: 1px solid #000; padding: 2px 0;
  }
  .cliente { font-size: 11px; font-weight: 700; margin-top: 3px; }
  .valor { font-size: 24px; font-weight: 700; margin: 2px 0 4px; }
  .qr { width: 52mm; height: 52mm; margin: 0 auto; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .instrucao { font-size: 10.5px; margin-top: 4px; }
  .separador { border-top: 1px dashed #000; margin: 5px 0; }
  .rotulo { font-size: 8.5px; letter-spacing: .05em; }
  .codigo { font-size: 8px; word-break: break-all; text-align: left; line-height: 1.25; }
  .rodape { font-size: 9px; margin-top: 5px; }
  .corte { height: 12mm; }
</style>
</head>
<body>
  ${logo ? `<img class="logo" src="${escapar(logo)}" alt="">` : ""}
  <div class="titulo">${escapar(loja.razaoSocial ?? loja.nome)}</div>
  <div>CNPJ ${escapar(formatarCpfCnpj(loja.cnpj))}</div>
  <div class="selo">PIX NA ENTREGA</div>
  <div>Venda #${venda.numero} · ${escapar(venda.loja)}</div>
  <div class="cliente">${escapar(venda.clienteNome ?? "")}</div>
  <div class="valor">${moeda(cobranca.valor)}</div>
  <div class="qr">${qr}</div>
  <div class="instrucao">Abra o app do banco, escolha Pix<br>e aponte a câmera para o código</div>
  <div class="separador"></div>
  <div class="rotulo">PIX COPIA E COLA</div>
  <div class="codigo">${escapar(cobranca.pixCopiaECola)}</div>
  <div class="separador"></div>
  <div class="rodape">
    Vence em ${escapar(vence)}; aceita pagamento até ${VALIDADE_PIX_ENTREGA_APOS_VENCIMENTO} dias depois.<br>
    Confira o valor e o recebedor antes de pagar.
  </div>
  <div class="corte"></div>
</body>
</html>`

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}
