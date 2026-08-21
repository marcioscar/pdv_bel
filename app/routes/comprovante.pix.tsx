import type { Route } from "./+types/comprovante.pix"
import { db } from "~/lib/db.server"
import { formatarCpfCnpj } from "~/lib/documento"
import { escapar } from "~/lib/html"
import { contaDaLoja, dadosDaLoja } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { consultarPixImediato } from "~/lib/pix.server"
import { exigirUsuario, podeVerDaLoja } from "~/lib/sessao.server"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * Comprovante do Pix recebido, na bobina de 80mm.
 *
 * O cupom da venda diz o que o cliente levou; este diz que o dinheiro entrou.
 * São documentos diferentes e o cliente costuma querer os dois — principalmente
 * quem paga por outra pessoa ou precisa prestar contas.
 *
 * O dado que faz o comprovante valer é o **E2E**, o identificador que o Banco
 * Central dá a cada transação Pix. É por ele que qualquer banco acha o
 * pagamento, meses depois, sem depender do nosso sistema. O txid é nosso; o E2E
 * é do sistema bancário.
 *
 * Por isso a fonte é o INTER, não o que gravamos: consultamos na hora de
 * imprimir. Um comprovante montado com o que o nosso banco de dados acredita
 * seria um papel que só prova que acreditamos nele.
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
  if (venda.forma !== "pix" || !venda.pixTxid) {
    throw new Response(`A venda #${venda.numero} não foi paga em Pix`, { status: 400 })
  }

  const loja = await dadosDaLoja(venda.loja)

  /**
   * Falha na consulta não impede o comprovante.
   *
   * O pagamento aconteceu — a venda só existe porque ele foi confirmado. Se o
   * Inter estiver fora agora, o papel sai com o que temos gravado e diz que o
   * E2E não pôde ser confirmado, em vez de negar ao cliente um comprovante de um
   * dinheiro que ele pagou.
   */
  let doBanco: Awaited<ReturnType<typeof consultarPixImediato>> | null = null
  try {
    doBanco = await consultarPixImediato(venda.pixTxid, await contaDaLoja(venda.loja))
  } catch (erro) {
    console.error(
      `[comprovante pix] falha ao consultar ${venda.pixTxid}:`,
      erro instanceof Error ? erro.message : erro
    )
  }

  const pagoEm = doBanco?.pagoEm ? new Date(doBanco.pagoEm) : venda.pixPagoEm
  const valorPago = doBanco?.valorPago ?? venda.total

  const logo = loja.logo ? new URL(loja.logo, request.url).href : null

  const linha = (rotulo: string, valor: string) =>
    `<tr><td>${escapar(rotulo)}</td><td class="dir">${escapar(valor)}</td></tr>`

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Comprovante Pix · venda ${venda.numero} · ${escapar(venda.loja)}</title>
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
  /* Mesmo tratamento do cupom: a térmica imprime em 1 bit, e cor vira meio-tom
     pontilhado que suja um logo pequeno. */
  .logo {
    width: 46mm; height: auto; margin: 0 auto 2px;
    filter: grayscale(1) contrast(3);
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  .titulo { font-size: 13px; font-weight: 700; }
  .selo {
    font-size: 12px; font-weight: 700; letter-spacing: .06em;
    margin: 4px 0; border: 1px solid #000; padding: 2px 0;
  }
  .separador { border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0; vertical-align: top; }

  /* O valor é o que o cliente confere primeiro, e de longe. */
  .valor { font-size: 20px; font-weight: 700; margin: 2px 0; }

  /*
   * O E2E quebra em qualquer lugar porque tem 32 caracteres e a bobina tem 72mm.
   * Em corpo menor e ocupando as duas colunas, ele cabe em duas linhas — e é o
   * dado que alguém vai digitar no aplicativo do banco para achar a transação.
   */
  .id { font-size: 9px; word-break: break-all; padding-bottom: 3px; }
  .rotulo-id {
    font-size: 8.5px; letter-spacing: .05em; padding-top: 3px;
  }
  .rodape { font-size: 9px; margin-top: 6px; }
  .corte { height: 12mm; }
</style>
</head>
<body>
  <div class="centro">
    ${logo ? `<img class="logo" src="${escapar(logo)}" alt="">` : ""}
    <div class="titulo">${escapar(loja.razaoSocial ?? loja.nome)}</div>
    <div>CNPJ ${escapar(formatarCpfCnpj(loja.cnpj))}</div>
    ${loja.endereco ? `<div>${escapar(loja.endereco)}</div>` : ""}
    ${loja.bairro ? `<div>${escapar(loja.bairro)} · ${escapar(loja.cidade ?? "")}/${escapar(loja.uf ?? "")}</div>` : ""}

    <div class="selo">PIX RECEBIDO</div>

    <div>Valor</div>
    <div class="valor">${moeda(valorPago)}</div>
    <div>${pagoEm ? pagoEm.toLocaleString("pt-BR") : "horário não informado"}</div>
  </div>

  <div class="separador"></div>
  <table>
    ${linha("Venda", `#${venda.numero}`)}
    ${linha("Loja", venda.loja)}
    ${linha("Operador", venda.operador)}
    ${
      doBanco?.pagadorNome
        ? linha("Pagador", doBanco.pagadorNome)
        : venda.clienteNome
          ? linha("Cliente", venda.clienteNome)
          : ""
    }
    ${
      doBanco?.pagadorDocumento
        ? linha("Documento", formatarCpfCnpj(doBanco.pagadorDocumento))
        : ""
    }
  </table>

  <div class="separador"></div>
  ${
    doBanco?.endToEndId
      ? `<div class="rotulo-id">IDENTIFICADOR DA TRANSAÇÃO (E2E)</div>
         <div class="id">${escapar(doBanco.endToEndId)}</div>`
      : `<div class="rotulo-id">IDENTIFICADOR DA TRANSAÇÃO</div>
         <div class="id">não foi possível confirmar no banco agora</div>`
  }
  <div class="rotulo-id">TXID</div>
  <div class="id">${escapar(venda.pixTxid)}</div>

  <div class="separador"></div>
  <div class="centro rodape">
    ${doBanco ? "Confirmado junto ao banco recebedor." : "Emitido sem confirmação do banco no momento da impressão."}<br>
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
