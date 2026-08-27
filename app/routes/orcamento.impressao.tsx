import type { Route } from "./+types/orcamento.impressao"
import { db } from "~/lib/db.server"
import { escapar } from "~/lib/html"
import { formatarCpfCnpj } from "~/lib/documento"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { exigirUsuario } from "~/lib/sessao.server"
import { precificar, type ItemRecebido } from "~/lib/vendas.server"

/**
 * O papel que o cliente leva para decidir.
 *
 * Sai do carrinho que está na tela, antes de existir venda: é justamente para
 * quem ainda não comprou. Por isso os itens vêm pela URL, e não de um registro —
 * gravar um "orçamento" no banco criaria um documento a manter (numerar,
 * consultar, expirar) para o que hoje é uma folha que o cliente leva ou joga
 * fora.
 *
 * Os PREÇOS não vêm da URL: só os ids e as quantidades. Quem precifica é
 * `precificar`, o mesmo do fechamento da venda — assim o papel entregue ao
 * cliente nunca mostra um preço que o caixa não vai cobrar.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const url = new URL(request.url)

  /**
   * `i=<produtoId>:<quantidade>` repetido. Formato curto de propósito: o
   * carrinho vai inteiro na barra de endereço, e ObjectId já custa 24 caracteres.
   */
  const itens: ItemRecebido[] = []
  for (const bruto of url.searchParams.getAll("i")) {
    const [produtoId, qtd] = bruto.split(":")
    const quantidade = Number(qtd)
    if (!/^[0-9a-fA-F]{24}$/.test(produtoId ?? "")) continue
    if (!Number.isFinite(quantidade) || quantidade <= 0) continue
    itens.push({ produtoId, quantidade })
  }

  if (itens.length === 0) {
    return new Response("Orçamento sem itens", { status: 400 })
  }

  const desconto = Math.max(0, Number(url.searchParams.get("desconto")) || 0)
  const preco = await precificar(itens, desconto)
  if (!preco.ok) return new Response(preco.erro, { status: 400 })

  const loja = await db.loja.findUnique({ where: { codigo: eu.loja } })

  // URL absoluta: caminho relativo não resolve quando a página é impressa a
  // partir de um contexto sem origem (o cupom já apanhou disso).
  const logo = loja?.logo ? new URL(loja.logo, request.url).href : null

  const agora = new Date()
  const linhas = preco.itens
    .map(
      (item, i) => `<tr>
        <td class="ordem">${i + 1}</td>
        <td class="codigo">${escapar(item.codigo)}</td>
        <td>${escapar(item.descricao)}</td>
        <td class="un">${escapar(item.unidade)}</td>
        <td class="qtd">${formatarQuantidade(item.quantidade)}</td>
        <td class="valor">${moeda(item.preco)}</td>
        <td class="valor">${moeda(item.subtotal)}</td>
      </tr>`
    )
    .join("")

  const totalItens = preco.itens.reduce((soma, i) => soma + i.quantidade, 0)

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Orçamento · ${escapar(loja?.nome ?? eu.loja)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #111; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px; line-height: 1.4;
  }
  /*
   * A margem do @page só vale no papel. Sem isto, quem abre a página na tela vê
   * o conteúdo colado na borda e o total grande cortado — a folha larga demais
   * escondia justamente o número que o cliente procura.
   */
  @media screen {
    body { width: 186mm; margin: 8mm auto; }
  }

  .cabecalho {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 8mm; padding-bottom: 4mm; border-bottom: 2.5px solid #111;
  }
  .marca { display: flex; align-items: center; gap: 4mm; min-width: 0; }
  /*
   * Mesmo tratamento do cupom e do pedido de compra: numa impressora
   * monocromática a cor vira meio-tom pontilhado e suja o traço, e sem
   * print-color-adjust o navegador descarta o desenho para "economizar tinta".
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
  .identificacao .titulo {
    font-size: 26px; font-weight: 700; line-height: 1.05; letter-spacing: -.01em;
  }
  .identificacao .data {
    margin-top: 1mm; font-size: 9.5px; color: #444;
    font-family: ui-monospace, Menlo, monospace;
  }

  /* Linha para preencher à mão: no balcão o nome do cliente raramente está
     cadastrado na hora de orçar, e um campo em branco é mais rápido que
     obrigar um cadastro antes de o cliente decidir. */
  .cliente {
    margin-top: 4mm; display: flex; align-items: flex-end; gap: 3mm;
    border: 1px solid #bbb; border-radius: 3px; padding: 3mm 3.5mm;
  }
  .cliente .titulo {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .1em; color: #666;
    white-space: nowrap;
  }
  .cliente .risco { flex: 1; border-bottom: 1px dotted #999; height: 4.5mm; }

  table { width: 100%; border-collapse: collapse; margin-top: 4mm; }
  th, td { text-align: left; padding: 1.6mm 2mm; vertical-align: top; }
  thead th {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .07em; color: #444;
    border-bottom: 1.5px solid #111; white-space: nowrap;
  }
  /* Zebra: com muitas linhas de nomes parecidos, é o que impede o olho de
     pular de linha ao conferir a quantidade. */
  tbody tr:nth-child(even) { background: #f4f4f4; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  tbody tr { border-bottom: 1px solid #ddd; break-inside: avoid; }
  thead { display: table-header-group; }

  .ordem { width: 7mm; color: #888; }
  .codigo { width: 20mm; font-family: ui-monospace, Menlo, monospace; }
  .un { width: 12mm; }
  .qtd, .valor { width: 24mm; text-align: right; font-family: ui-monospace, Menlo, monospace; }
  .qtd { font-weight: 700; }

  /* O total à direita, isolado: é o número que o cliente procura na folha. */
  .fechamento { margin-top: 4mm; display: flex; justify-content: flex-end; break-inside: avoid; }
  .somas { min-width: 70mm; }
  .somas .linha {
    display: flex; justify-content: space-between; gap: 6mm;
    padding: 1.2mm 0; font-size: 11px;
  }
  .somas .linha .valor { font-family: ui-monospace, Menlo, monospace; }
  .somas .total {
    margin-top: 1.5mm; padding-top: 2mm; border-top: 1.5px solid #111;
    font-size: 15px; font-weight: 700;
  }
  .somas .total .valor { font-size: 19px; }

  .aviso {
    margin-top: 6mm; padding: 2.5mm 3mm; border-left: 3px solid #111; background: #f7f7f7;
    font-size: 9.5px; color: #333;
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  .rodape { margin-top: 4mm; font-size: 8.5px; color: #666; }
</style>
</head>
<body>
  <div class="cabecalho">
    <div class="marca">
      ${logo ? `<img class="logo" src="${escapar(logo)}" alt="">` : ""}
      ${
        loja
          ? `<div class="empresa">
              <div class="nome">${escapar(loja.razaoSocial ?? loja.nome)}</div>
              <div class="linha">CNPJ ${escapar(formatarCpfCnpj(loja.cnpj))}</div>
              ${
                loja.endereco
                  ? `<div class="linha">${escapar(loja.endereco)}${
                      loja.bairro ? " · " + escapar(loja.bairro) : ""
                    }</div>`
                  : ""
              }
              <div class="linha">
                ${escapar(loja.cidade ?? "")}${loja.uf ? "/" + escapar(loja.uf) : ""}
                ${loja.telefone ? " · " + escapar(loja.telefone) : ""}
              </div>
            </div>`
          : ""
      }
    </div>

    <div class="identificacao">
      <div class="rotulo">Proposta de venda</div>
      <div class="titulo">ORÇAMENTO</div>
      <div class="data">${agora.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</div>
    </div>
  </div>

  <div class="cliente">
    <span class="titulo">Cliente</span>
    <span class="risco"></span>
    <span class="titulo">Telefone</span>
    <span class="risco" style="flex:0 0 40mm"></span>
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
  </table>

  <div class="fechamento">
    <div class="somas">
      <div class="linha">
        <span>${preco.itens.length} ${preco.itens.length === 1 ? "produto" : "produtos"} · ${formatarQuantidade(totalItens)} ${totalItens === 1 ? "volume" : "volumes"}</span>
        <span class="valor">${moeda(preco.subtotal)}</span>
      </div>
      ${
        desconto > 0
          ? `<div class="linha"><span>Desconto</span><span class="valor">− ${moeda(desconto)}</span></div>`
          : ""
      }
      <div class="linha total">
        <span>Total</span>
        <span class="valor">${moeda(preco.total)}</span>
      </div>
    </div>
  </div>

  <div class="aviso">
    Este documento é um orçamento e <strong>não é documento fiscal</strong>. Os preços valem
    para a data de emissão e estão sujeitos a alteração e à disponibilidade de estoque.
  </div>

  <div class="rodape">
    ${escapar(loja?.nome ?? eu.loja)} · atendido por ${escapar(eu.nome)}
  </div>
</body>
</html>`

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}
