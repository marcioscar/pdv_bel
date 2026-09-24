import QRCode from "qrcode"

import type { Route } from "./+types/pix.qrcode"
import { formatarCpfCnpj } from "~/lib/documento"
import { escapar } from "~/lib/html"
import { contaDaLoja, dadosDaLoja } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { consultarPixImediato } from "~/lib/pix.server"
import { exigirUsuario } from "~/lib/sessao.server"

/** O formato do txid que o caixa gera — o resto nem chega ao banco. */
const TXID = /^[a-zA-Z0-9]{26,35}$/

/**
 * O QR Code do Pix no papel, para o cliente escanear na mão.
 *
 * Existe porque o monitor do caixa às vezes fica onde o cliente não alcança
 * com o celular. Sai na térmica, como o cupom: valor grande, QR no meio, e o
 * copia-e-cola embaixo para quem prefere colar no aplicativo.
 *
 * Tudo vem do INTER, na hora — valor, QR e copia-e-cola —, e não da tela: um
 * papel montado com o que o navegador mandou poderia sair com outro valor, e é
 * esse papel que o cliente paga. A cobrança tem de ser da loja da sessão (é a
 * conta dela que se consulta) e estar ATIVA: QR de cobrança paga ou vencida no
 * papel é o cliente pagando duas vezes ou pagando o nada.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const txid = params.txid ?? ""
  if (!TXID.test(txid)) throw new Response("Cobrança Pix inválida", { status: 400 })

  let pix: Awaited<ReturnType<typeof consultarPixImediato>>
  try {
    pix = await consultarPixImediato(txid, await contaDaLoja(eu.loja))
  } catch {
    throw new Response("Não foi possível consultar a cobrança no Inter agora", { status: 502 })
  }
  if (pix.status !== "ATIVA") {
    throw new Response(
      pix.status === "CONCLUIDA"
        ? "Esta cobrança já foi paga — não imprima o QR de novo"
        : `Esta cobrança não está mais ativa (${pix.status}) — gere outra`,
      { status: 409 }
    )
  }
  if (!pix.pixCopiaECola) {
    throw new Response("O Inter não devolveu o código desta cobrança", { status: 502 })
  }

  // SVG, e não a imagem PNG da tela: a térmica imprime em 1 bit, e o vetor sai
  // nítido em qualquer tamanho — um QR borrado é um QR que o celular não lê.
  const qr = await QRCode.toString(pix.pixCopiaECola, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
  })
  const loja = await dadosDaLoja(eu.loja)
  const logo = loja.logo ? new URL(loja.logo, request.url).href : null
  const minutos = Math.round(pix.expiracaoSegundos / 60)

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Pix · ${moeda(pix.valor)} · ${escapar(eu.loja)}</title>
<style>
  /* A bobina é contínua: a altura acompanha o conteúdo, não uma folha. */
  @page { size: 80mm auto; margin: 2mm 3mm; }
  * { box-sizing: border-box; }
  body {
    /* 68mm, como o cupom: a área que a térmica imprime é menor que a teórica. */
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
  /* O valor é o que o cliente confere antes de pagar. */
  .valor { font-size: 24px; font-weight: 700; margin: 2px 0 4px; }
  /* 52mm: grande o bastante para qualquer celular ler a um palmo. */
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
  <div class="selo">PAGUE COM PIX</div>
  <div class="valor">${moeda(pix.valor)}</div>
  <div class="qr">${qr}</div>
  <div class="instrucao">Abra o app do banco, escolha Pix<br>e aponte a câmera para o código</div>
  <div class="separador"></div>
  <div class="rotulo">PIX COPIA E COLA</div>
  <div class="codigo">${escapar(pix.pixCopiaECola)}</div>
  <div class="separador"></div>
  <div class="rodape">
    Válido por ${minutos} minutos a partir da geração.<br>
    Confira o valor e o recebedor antes de pagar.
  </div>
  <div class="corte"></div>
</body>
</html>`

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Retrato de uma cobrança viva: em cache, reimprimiria um QR já pago.
      "cache-control": "no-store",
    },
  })
}
