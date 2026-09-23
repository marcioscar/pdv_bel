import type { Route } from "./+types/inadimplentes.impressao"
import { inadimplentes, type BoletoDoDevedor } from "~/lib/boletos-externos.server"
import { emDia, inicioDoDia, diaDeHoje } from "~/lib/dia"
import { formatarCpfCnpj } from "~/lib/documento"
import { escapar } from "~/lib/html"
import { moeda } from "~/lib/moeda"
import { exigirUsuario } from "~/lib/sessao.server"

/**
 * O relatório de inadimplentes, por loja, para imprimir ou salvar em PDF.
 *
 * Por loja porque é assim que a cobrança se divide: cada loja liga para os
 * clientes dela. Dentro da loja, do maior devedor para o menor, com o telefone
 * ao lado do nome — a folha é para quem vai pegar o telefone.
 *
 * O boleto do sistema antigo emitido na conta da matriz não sabe se a venda foi
 * na QI ou na QNE; ele vai para a seção "QI/QNE" em vez de ser jogado numa das
 * duas.
 *
 * HTML e não PDF pelo mesmo motivo das outras folhas: o navegador imprime ou
 * salva em PDF direto. Rota de recurso, fora do layout de /admin — dentro dele
 * a folha sairia com a sidebar junto; por isso cobra a própria guarda.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // Consulta, como a tela: o vendedor que cobra imprime a lista da loja dele.
  const eu = await exigirUsuario(request)
  const pedida = new URL(request.url).searchParams.get("loja") ?? ""
  const loja = eu.lojasPermitidas.includes(pedida) ? pedida : null
  const devedores = await inadimplentes({ loja })

  return new Response(folha(devedores, eu.nome, loja), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Retrato de agora: em cache, cobraria quem acabou de pagar.
      "cache-control": "no-store",
    },
  })
}

type Devedor = Awaited<ReturnType<typeof inadimplentes>>[number]

type Secao = {
  loja: string
  devedores: { devedor: Devedor; boletos: BoletoDoDevedor[]; total: number }[]
  total: number
  boletos: number
}

/** Quebra cada devedor pelas lojas dos boletos dele. */
function porLoja(devedores: Devedor[]): Secao[] {
  const secoes = new Map<string, Secao>()
  for (const devedor of devedores) {
    const daLoja = new Map<string, BoletoDoDevedor[]>()
    for (const b of devedor.boletos) daLoja.set(b.loja, [...(daLoja.get(b.loja) ?? []), b])

    for (const [loja, boletos] of daLoja) {
      const secao = secoes.get(loja) ?? { loja, devedores: [], total: 0, boletos: 0 }
      const total = boletos.reduce((s, b) => s + b.valor, 0)
      secao.devedores.push({ devedor, boletos, total })
      secao.total += total
      secao.boletos += boletos.length
      secoes.set(loja, secao)
    }
  }

  // Por código de loja; a de conta compartilhada ("QI/QNE") vai logo depois da
  // ÚLTIMA loja dela — ordenar pelo texto a poria entre a QI e a QNE.
  const chave = (loja: string) => {
    const partes = loja.split("/")
    return partes.length > 1 ? `${partes[partes.length - 1]}~` : loja
  }
  return [...secoes.values()]
    .map((s) => ({ ...s, devedores: s.devedores.sort((a, b) => b.total - a.total) }))
    .sort((a, b) => chave(a.loja).localeCompare(chave(b.loja)))
}

function linhaDoDevedor(
  { devedor, boletos, total }: Secao["devedores"][number],
  hoje: number
) {
  const cabeca = `<tr class="devedor">
    <td colspan="4">
      <span class="nome">${escapar(devedor.nome)}</span>
      ${devedor.nomeFantasia ? `<span class="fraco"> ${escapar(devedor.nomeFantasia)}</span>` : ""}
      <span class="doc">${devedor.documento ? escapar(formatarCpfCnpj(devedor.documento)) : "sem documento"}${
        devedor.documentos.length > 1 ? ` · ${devedor.documentos.length} filiais` : ""
      }</span>
      <span class="fone">${escapar(devedor.telefone ?? "sem telefone")}${
        devedor.contato ? ` · ${escapar(devedor.contato)}` : ""
      }</span>
    </td>
    <td class="valor">${moeda(total)}</td>
  </tr>`

  const linhas = boletos
    .map((b) => {
      const atraso = Math.round((hoje - inicioDoDia(emDia(new Date(b.vencimento))).getTime()) / 86_400_000)
      return `<tr class="boleto">
        <td class="venc">${new Date(b.vencimento).toLocaleDateString("pt-BR")}</td>
        <td class="atraso">${atraso} ${atraso === 1 ? "dia" : "dias"}</td>
        <td>${escapar(b.referencia)}${
          // Empresa com filiais: qual delas deve este boleto.
          devedor.documentos.length > 1
            ? ` <span class="doc">${escapar(formatarCpfCnpj(b.documento))}</span>`
            : ""
        }</td>
        <td class="origem">${b.origem === "antigo" ? "sistema antigo" : "PDV"}</td>
        <td class="valor">${moeda(b.valor)}</td>
      </tr>`
    })
    .join("")

  return cabeca + linhas
}

function folha(devedores: Devedor[], emitidoPor: string, loja: string | null) {
  const hoje = inicioDoDia(diaDeHoje()).getTime()
  const secoes = porLoja(devedores)
  const totalGeral = secoes.reduce((s, x) => s + x.total, 0)
  const boletosGeral = secoes.reduce((s, x) => s + x.boletos, 0)

  const corpo = secoes
    .map(
      (secao) => `<section>
    <div class="loja">
      <span class="codigo">${escapar(secao.loja)}</span>
      <span class="resumo">${secao.devedores.length} ${secao.devedores.length === 1 ? "cliente" : "clientes"} · ${secao.boletos} ${secao.boletos === 1 ? "boleto" : "boletos"}</span>
      <span class="soma">${moeda(secao.total)}</span>
    </div>
    <table>
      <thead>
        <tr>
          <th class="venc">Vencimento</th>
          <th class="atraso">Atraso</th>
          <th>Documento</th>
          <th class="origem">Origem</th>
          <th class="valor">Valor</th>
        </tr>
      </thead>
      <tbody>${secao.devedores.map((d) => linhaDoDevedor(d, hoje)).join("")}</tbody>
    </table>
  </section>`
    )
    .join("")

  const agora = new Date().toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Inadimplentes ${loja ? escapar(loja) : "por loja"} · ${escapar(agora)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm 10mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; background: #fff;
    font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5px; line-height: 1.3;
  }
  h1 { font-size: 17px; margin: 0; }
  header { border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 6px; }
  .contexto { margin-top: 3px; color: #333; }

  section { margin-top: 10px; }
  /* Loja nova começa em página nova só se não couber o cabeçalho e um devedor. */
  .loja {
    display: flex; align-items: baseline; gap: 10px;
    background: #e9e9e9; border-top: 2px solid #000; border-bottom: 1px solid #000;
    padding: 4px 5px; break-after: avoid;
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  .loja .codigo { font-size: 15px; font-weight: 700; }
  .loja .resumo { font-size: 9.5px; color: #333; }
  .loja .soma { margin-left: auto; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }

  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th, td { text-align: left; padding: 2px 4px; vertical-align: top; }
  th {
    font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 1px solid #000; white-space: nowrap;
  }
  /* O devedor abre o bloco dos boletos dele: não fica no pé da página sozinho. */
  .devedor td { padding-top: 6px; border-top: 1px solid #999; break-after: avoid; }
  .devedor .nome { font-weight: 700; font-size: 11px; }
  .devedor .doc, .devedor .fone {
    display: inline-block; margin-left: 8px; font-size: 9px; color: #333;
    font-variant-numeric: tabular-nums;
  }
  .devedor .valor { font-size: 11.5px; }
  .boleto { break-inside: avoid; }
  .boleto td { color: #222; }
  .boleto .doc { font-size: 8.5px; color: #555; margin-left: 6px; font-variant-numeric: tabular-nums; }
  .venc { width: 22mm; font-variant-numeric: tabular-nums; }
  .atraso { width: 18mm; font-variant-numeric: tabular-nums; }
  .origem { width: 26mm; font-size: 9px; }
  .valor { width: 26mm; text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
  .fraco { color: #555; font-size: 9px; }
  .vazia { margin: 20px 0; font-style: italic; }

  .total {
    margin-top: 10px; padding-top: 5px; border-top: 2px solid #000;
    display: flex; justify-content: space-between; font-size: 13px; font-weight: 700;
    break-inside: avoid;
  }
  .rodape { margin-top: 6px; font-size: 8.5px; color: #444; }
</style>
</head>
<body>
  <header>
    <h1>Inadimplentes ${loja ? `— ${escapar(loja)}` : "por loja"}</h1>
    <div class="contexto">
      Boletos vencidos e não pagos em ${escapar(agora)}, do PDV e do sistema antigo, somados por cliente
      (pelo CPF/CNPJ; as filiais de uma empresa entram juntas, com o CNPJ da filial em cada boleto).
      Dentro de cada loja, do maior devedor para o menor.
      Boleto antigo da conta da matriz aparece em <strong>QI/QNE</strong>: o Inter não diz qual das duas vendeu.
    </div>
  </header>

  ${secoes.length === 0 ? `<p class="vazia">Nenhum boleto vencido em aberto.</p>` : corpo}

  ${
    secoes.length > 0
      ? `<div class="total">
    <span>${devedores.length} ${devedores.length === 1 ? "cliente" : "clientes"} · ${boletosGeral} ${boletosGeral === 1 ? "boleto" : "boletos"}</span>
    <span>${moeda(totalGeral)}</span>
  </div>`
      : ""
  }
  <p class="rodape">Emitido por ${escapar(emitidoPor)} em ${escapar(agora)}. Os pagamentos só aparecem aqui depois de conferidos no Inter — use "Atualizar do Inter" antes de imprimir.</p>
</body>
</html>`
}
