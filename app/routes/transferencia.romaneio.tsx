import type { Route } from "./+types/transferencia.romaneio"
import { db } from "~/lib/db.server"
import { escapar } from "~/lib/html"
import { dadosDaLoja } from "~/lib/lojas.server"
import { quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirUsuario, podeVerDaLoja } from "~/lib/sessao.server"
import { faltaDoItem } from "~/lib/transferencias"

/**
 * O papel que viaja junto com a carga.
 *
 * Duas colunas de quantidade, e é isso que faz o documento servir: **Saiu**, já
 * impressa, e **Chegou**, em branco. Quem descarrega conta e escreve à mão, e só
 * depois vai ao sistema lançar. Um romaneio que já viesse com as duas colunas
 * preenchidas seria um papel para assinar sem ler — que é como some mercadoria.
 *
 * Sai em duas vias na mesma folha: uma fica com quem entrega, outra com quem
 * recebe. Quando aparece divergência três dias depois, as duas vias são a única
 * coisa que existe fora do sistema.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const transferencia = await db.transferencia.findUnique({
    where: { id: params.transferenciaId },
  })
  if (!transferencia) throw new Response("Transferência não encontrada", { status: 404 })

  // Quem opera numa das duas pontas pode imprimir: o documento é das duas lojas.
  if (
    !podeVerDaLoja(eu, transferencia.origem) &&
    !podeVerDaLoja(eu, transferencia.destino)
  ) {
    throw new Response("Transferência de outras lojas", { status: 403 })
  }

  const [origem, destino] = await Promise.all([
    dadosDaLoja(transferencia.origem),
    dadosDaLoja(transferencia.destino),
  ])

  const conferida = transferencia.situacao !== "em_transito"

  const linhas = transferencia.itens
    .map((item, i) => {
      const falta = faltaDoItem(item)
      return `<tr>
        <td class="ordem">${i + 1}</td>
        <td class="codigo">${escapar(item.codigo)}</td>
        <td>${escapar(item.descricao)}</td>
        <td class="un">${escapar(item.unidade)}</td>
        <td class="qtd">${formatarQuantidade(item.enviada)}</td>
        <td class="conferir">${
          conferida
            ? `<span class="${falta > 0 ? "falta" : ""}">${formatarQuantidade(item.recebida ?? 0)}</span>`
            : ""
        }</td>
      </tr>`
    })
    .join("")

  const totalItens = transferencia.itens.length
  const totalUnidades = transferencia.itens.reduce((acc, i) => acc + i.enviada, 0)

  const via = (rotulo: string) => `<section class="via">
    <header>
      <div class="topo">
        <h1>Romaneio de transferência <span class="numero">#${transferencia.numero}</span></h1>
        <span class="rotulo-via">${rotulo}</span>
      </div>
      <div class="rota">
        <span class="ponta">
          <b>DE</b> ${escapar(transferencia.origem)} · ${escapar(origem.nome)}
        </span>
        <span class="seta">&rarr;</span>
        <span class="ponta">
          <b>PARA</b> ${escapar(transferencia.destino)} · ${escapar(destino.nome)}
        </span>
      </div>
      <div class="linha-info">
        Despachada em ${new Date(transferencia.criadaEm).toLocaleString("pt-BR")}
        por ${escapar(transferencia.enviadaPor)}
        ${transferencia.observacao ? ` · ${escapar(transferencia.observacao)}` : ""}
      </div>
    </header>

    <table>
      <thead>
        <tr>
          <th class="ordem">#</th>
          <th class="codigo">Código</th>
          <th>Produto</th>
          <th class="un">Un</th>
          <th class="qtd">Saiu</th>
          <th class="conferir">Chegou</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
      <tfoot>
        <tr>
          <td colspan="4">${totalItens} ${totalItens === 1 ? "produto" : "produtos"}</td>
          <td class="qtd">${formatarQuantidade(totalUnidades)}</td>
          <td class="conferir"></td>
        </tr>
      </tfoot>
    </table>

    <div class="assinaturas">
      <div>Entregue por</div>
      <div>Recebido e conferido por</div>
      <div class="data">Data</div>
    </div>
  </section>`

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Romaneio #${transferencia.numero} · ${escapar(transferencia.origem)} para ${escapar(transferencia.destino)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5px; line-height: 1.3;
  }

  /* Duas vias na mesma folha, separadas por uma linha de corte: uma fica com
     quem entrega e a outra com quem recebe, sem gastar duas folhas. */
  .via { padding-bottom: 5mm; }
  .via + .via { border-top: 1px dashed #666; padding-top: 5mm; }

  .topo { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  h1 { font-size: 15px; margin: 0; }
  .numero { font-family: ui-monospace, Menlo, monospace; }
  .rotulo-via {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .08em;
    border: 1px solid #000; padding: 1px 5px; white-space: nowrap;
  }
  .rota {
    margin-top: 4px; padding: 4px 0; border-top: 2px solid #000; border-bottom: 1px solid #000;
    display: flex; align-items: baseline; gap: 10px; font-size: 13px;
  }
  .ponta b { font-size: 8.5px; letter-spacing: .06em; margin-right: 3px; }
  .seta { font-size: 15px; }
  .linha-info { margin-top: 3px; font-size: 9px; color: #333; }

  table { width: 100%; border-collapse: collapse; margin-top: 5px; }
  thead { display: table-header-group; }
  th, td { text-align: left; padding: 3px 4px; vertical-align: top; }
  th {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 1px solid #000; white-space: nowrap;
  }
  tbody tr { border-bottom: 1px solid #ccc; break-inside: avoid; }
  tfoot td { border-top: 1.5px solid #000; font-weight: 700; padding-top: 4px; }

  .ordem { width: 7mm; color: #666; }
  .codigo { width: 20mm; font-family: ui-monospace, Menlo, monospace; }
  .un { width: 10mm; }
  .qtd { width: 16mm; text-align: right; font-family: ui-monospace, Menlo, monospace; font-weight: 700; }

  /*
   * A coluna que existe para ser preenchida à mão. Fundo cinza e borda para o
   * olho achar onde escrever sem instrução, e altura suficiente para caber um
   * número escrito de pé, apoiado numa caixa.
   */
  .conferir {
    width: 20mm; text-align: right;
    border-left: 1px solid #000; background: #f0f0f0;
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  tbody .conferir { height: 7mm; }
  .conferir .falta { font-weight: 700; text-decoration: underline; }

  .assinaturas { margin-top: 12mm; display: flex; gap: 8mm; break-inside: avoid; }
  .assinaturas div {
    flex: 1; border-top: 1px solid #000; padding-top: 3px; font-size: 8.5px;
  }
  .assinaturas .data { flex: 0 0 30mm; }
</style>
</head>
<body>
  ${via("Via de quem entrega")}
  ${via("Via de quem recebe")}
</body>
</html>`

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}
