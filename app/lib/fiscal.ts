import { arredondar } from "~/lib/moeda"
import {
  condicaoPorId,
  ehTransferenciaEntreLojas,
  FORMA_MISTA,
  pagamentosDaVenda,
  parcelasDaCondicao,
  rotuloDaForma,
  type PagamentoDaVenda,
} from "~/lib/pdv"

/**
 * As regras fiscais que a nota exige, num lugar só.
 *
 * Puro de propósito — sem banco e sem rede: é daqui que sai o que vai em cada
 * item da NFC-e e da NF-e, e a mesma função precisa valer no servidor, na tela
 * de cadastro e no dia em que houver teste. Errar aqui não dá erro de sistema:
 * dá nota autorizada com imposto errado, que é bem pior.
 *
 * Nada disto é escolha de programador. Os padrões abaixo são os do comércio
 * varejista optante do Simples que vende mercadoria adquirida de terceiros
 * dentro do próprio estado — o caso da rede — e cada um deles é confirmável com
 * o contador. Por isso são DEFAULTS visíveis no cadastro, não constantes
 * escondidas: quando o contador disser outro número, é o cadastro que muda.
 */

/** Venda de mercadoria adquirida de terceiros, dentro do estado. */
export const CFOP_VENDA_INTERNA = "5102"
/** A mesma venda, para fora do estado. */
export const CFOP_VENDA_INTERESTADUAL = "6102"
/** Venda para outro estado a quem não tem IE — o consumidor final de fora. */
export const CFOP_VENDA_INTERESTADUAL_NAO_CONTRIBUINTE = "6108"
/** Venda de mercadoria já com o ICMS retido por substituição tributária. */
export const CFOP_VENDA_ST = "5405"
/**
 * Transferência de mercadoria adquirida de terceiros para outro estabelecimento
 * da mesma empresa, dentro do estado.
 *
 * É o caso da carga que sai da QI para a QNE: são CNPJs diferentes (matriz e
 * filial), a mercadoria muda de estabelecimento e por isso precisa de nota — mas
 * ninguém comprou nada, e uma nota de venda ali inventaria faturamento.
 */
export const CFOP_TRANSFERENCIA = "5152"

/**
 * Devolução de venda de mercadoria adquirida de terceiros, dentro do estado.
 * Fora dele seria 2202 — mas a devolução do balcão é quase sempre local, e
 * quem tiver o outro caso cadastra na loja.
 */
export const CFOP_DEVOLUCAO = "1202"

/** Simples Nacional, tributada sem permissão de crédito de ICMS. */
export const CSOSN_PADRAO = "102"
/** Simples Nacional, mercadoria com ICMS retido por substituição tributária. */
export const CSOSN_ST = "500"

/** Mercadoria nacional. */
export const ORIGEM_NACIONAL = "0"

/**
 * PIS e COFINS do optante do Simples.
 *
 * A NF-e exige o grupo dos dois em CADA item — a rejeição é literalmente "NF-e
 * sem grupo do PIS", e derruba a nota inteira. Quem é do Simples não destaca
 * esses tributos (eles estão dentro da guia única), mas precisa declarar isso:
 * é o que o CST 49, "outras operações de saída", diz, com base, alíquota e valor
 * zerados.
 *
 * A NFC-e passa sem porque a Focus preenche um padrão; mandar explícito nos dois
 * documentos é o que faz a nota depender do que está escrito aqui, e não de um
 * default de terceiro que pode mudar.
 *
 * Se o contador pedir outro CST, é este número que muda.
 */
export const PIS_COFINS_SIMPLES = "49"

/**
 * Quem contrata e paga o transporte, na tabela da NF-e.
 *
 * "Sem transporte" é o padrão do balcão: o cliente leva na mão. As outras entram
 * quando a mercadoria é entregue, e a escolha muda quem responde pelo frete
 * perante o fisco — não é detalhe de tela.
 */
export const MODALIDADES_FRETE = [
  { id: "9", rotulo: "Sem transporte", detalhe: "o cliente leva" },
  { id: "0", rotulo: "Por conta do emitente (CIF)", detalhe: "a loja paga o frete" },
  { id: "1", rotulo: "Por conta do destinatário (FOB)", detalhe: "o cliente paga o frete" },
  { id: "2", rotulo: "Por conta de terceiros", detalhe: "quem paga é um terceiro" },
  { id: "3", rotulo: "Transporte próprio do emitente", detalhe: "entrega com veículo da loja" },
  { id: "4", rotulo: "Transporte próprio do destinatário", detalhe: "o cliente busca com o veículo dele" },
] as const

export const FRETE_SEM_TRANSPORTE = "9"

export function modalidadeFreteValida(valor: string) {
  return MODALIDADES_FRETE.some((m) => m.id === valor)
}

/** CRT — o regime que o emitente declara na nota. */
export const REGIMES = [
  { id: 1, rotulo: "Simples Nacional", detalhe: "item vai com CSOSN, sem destaque de ICMS" },
  { id: 2, rotulo: "Simples, com excesso de sublimite", detalhe: "raro; o contador avisa quando acontece" },
  { id: 3, rotulo: "Regime normal", detalhe: "item vai com CST, base de cálculo e alíquota" },
] as const

export type Regime = (typeof REGIMES)[number]["id"]

export function regimeValido(valor: number): valor is Regime {
  return REGIMES.some((r) => r.id === valor)
}

export function ehSimples(regime: number | null | undefined) {
  return regime === 1 || regime === 2
}

/**
 * O CSOSN escrito com quatro dígitos, como aparece na maioria dos sistemas e na
 * conversa com o contador: "0102" é a ORIGEM (0, nacional) colada no CSOSN
 * (102). A Focus quer os dois separados — `icms_origem` e
 * `icms_situacao_tributaria` —, então quem digita do jeito que conhece não pode
 * acabar com um "0102" indo inteiro para o campo errado.
 *
 * Três dígitos passam intactos, com a origem em branco: quem digitou "102" está
 * falando só do CSOSN.
 */
export function separarOrigemDoCsosn(bruto: string): { origem: string | null; csosn: string } {
  const so = bruto.replace(/\D/g, "")
  if (so.length === 4) return { origem: so[0], csosn: so.slice(1) }
  return { origem: null, csosn: so }
}

/** O que a loja usa quando o produto não traz exceção. */
export type PadraoDaLoja = {
  cfopVendaInterna: string | null
  cfopVendaInterestadual: string | null
  cfopTransferencia: string | null
  cfopDevolucao: string | null
  csosnPadrao: string | null
}

/** O que o produto pode ter de diferente do padrão. */
export type ExcecaoDoProduto = {
  cfop: string | null
  csosn: string | null
  cest: string | null
  origemFiscal: string | null
}

export type TributacaoDoItem = {
  cfop: string
  csosn: string
  origem: string
  cest: string | null
}

/**
 * A tributação de um item da nota: o padrão do emitente, com a exceção do
 * produto por cima.
 *
 * A ligação entre CSOSN e CFOP é a parte que se erra calada: mercadoria com
 * ICMS retido (CSOSN 500) sai com CFOP 5405, não 5102. Quem cadastrou a ST no
 * produto pode informar o CFOP também — mas se esquecer, aqui ele é deduzido em
 * vez de sair errado.
 */
export function tributacaoDoItem(
  produto: ExcecaoDoProduto,
  loja: PadraoDaLoja,
  {
    interestadual = false,
    transferencia = false,
    devolucao = false,
    naoContribuinte = false,
  }: {
    interestadual?: boolean
    /**
     * Destinatário sem IE. Na venda para outro estado o CFOP é o 6108 (venda a
     * não contribuinte), e não o 6102 — que diz que o comprador vai revender.
     */
    naoContribuinte?: boolean
    transferencia?: boolean
    /** A nota de ENTRADA que documenta a mercadoria que o cliente trouxe. */
    devolucao?: boolean
  } = {}
): TributacaoDoItem {
  const doProduto = separarOrigemDoCsosn(produto.csosn ?? "")
  const daLoja = separarOrigemDoCsosn(loja.csosnPadrao ?? "")
  const csosn = doProduto.csosn || daLoja.csosn || CSOSN_PADRAO

  const padrao = devolucao
    ? loja.cfopDevolucao || CFOP_DEVOLUCAO
    : transferencia
    ? loja.cfopTransferencia || CFOP_TRANSFERENCIA
    : interestadual
      ? naoContribuinte
        ? CFOP_VENDA_INTERESTADUAL_NAO_CONTRIBUINTE
        : loja.cfopVendaInterestadual || CFOP_VENDA_INTERESTADUAL
      : loja.cfopVendaInterna || CFOP_VENDA_INTERNA

  /*
   * A dedução do 5405 vale só para VENDA: transferência de mercadoria com ICMS
   * retido tem CFOP próprio (5409), e adivinhar ali seria adivinhar errado —
   * quem tiver esse caso cadastra o CFOP no produto.
   */
  const cfop =
    produto.cfop ||
    (csosn === CSOSN_ST && !interestadual && !transferencia && !devolucao
      ? CFOP_VENDA_ST
      : padrao)

  return {
    cfop,
    csosn,
    // A origem tem três fontes, nesta ordem: o campo próprio do produto, o
    // primeiro dígito do CSOSN de quatro casas, e nacional.
    origem: produto.origemFiscal || doProduto.origem || daLoja.origem || ORIGEM_NACIONAL,
    cest: produto.cest || null,
  }
}

/** "nfce" (modelo 65) ou "nfe" (modelo 55), como a Focus nomeia os endpoints. */
export type ModeloNota = "nfce" | "nfe"

/**
 * Qual documento a venda pede.
 *
 * Quem fecha a venda escolhe (F7 na conferência), e a escolha fica gravada em
 * `modeloNota`: cliente com CPF pode querer NF-e, e empresa pode levar só o
 * cupom fiscal. A única recusa é NF-e sem cliente vinculado — ela precisa de
 * nome e endereço, que o CPF avulso da Nota Legal não tem.
 *
 * Sem escolha gravada (vendas antigas, ou quem não mexeu), vale o padrão:
 * cliente empresa e venda a prazo vão de NF-e — a primeira porque o comprador
 * precisa da nota para se creditar, a segunda porque a cobrança fica registrada
 * no nome dele. O resto do balcão é NFC-e, que é o cupom fiscal.
 *
 * Mora aqui, e não no módulo de servidor, porque a TELA também precisa saber: é
 * o que escreve "Emitir NFC-e" ou "Emitir NF-e" no botão antes de qualquer
 * chamada — e um `.server` importado pelo componente quebra o build.
 */
/** O tamanho do recado da NF-e: o mesmo no caixa e na tela de Vendas. */
export const OBSERVACAO_NOTA_MAXIMO = 500

export function modeloDaVenda(venda: {
  forma: string
  clienteCpfCnpj: string | null
  modeloNota?: string | null
}): ModeloNota {
  const documento = (venda.clienteCpfCnpj ?? "").replace(/\D/g, "")
  if (venda.modeloNota === "nfce") return "nfce"
  if (venda.modeloNota === "nfe" && documento) return "nfe"
  if (documento.length === 14) return "nfe"
  if (venda.forma === "prazo") return "nfe"
  return "nfce"
}

/**
 * Código da forma de pagamento na nota (tabela da SEFAZ), a partir da forma
 * usada no caixa.
 *
 * "A prazo" e "link" viram 99 (outros) por motivos diferentes: o boleto tem
 * código próprio (15) mas só depois de emitido, e o link é sempre cartão de
 * alguém — qual, não se sabe na hora de emitir.
 */
export const PAGAMENTO_NA_NOTA: Record<string, string> = {
  dinheiro: "01",
  credito: "03",
  debito: "04",
  pix: "17",
  // A entrega é paga em Pix, só que depois: na nota, a forma é a mesma.
  entrega: "17",
  antecipado: "17",
  prazo: "15",
  link: "99",
  /*
   * 90 é "sem pagamento" na tabela da SEFAZ, e é o que a transferência é: a
   * mercadoria muda de estabelecimento, ninguém paga nada. Cair no 99
   * ("outros") pelo padrão diria que houve um pagamento de tipo estranho.
   */
  transferencia: "90",
}

export function pagamentoNaNota(forma: string) {
  return PAGAMENTO_NA_NOTA[forma] ?? "99"
}

/** "Crédito loja" na tabela da SEFAZ: o saldo a favor que o cliente tinha aqui. */
const CREDITO_LOJA = "05"

/**
 * As formas de pagamento da NFC-e, que precisam somar o total da nota.
 *
 * A venda de uma forma só segue como sempre foi: o total inteiro nela. A
 * mista vai linha por linha — a NFC-e aceita várias —, e como as linhas somam
 * o que entrou (`total − creditoUsado`), o crédito do cliente entra como linha
 * própria, senão a SEFAZ recusa a nota por pagamento menor que o total.
 */
export function formasDePagamentoDaNota(venda: {
  forma: string
  total: number
  creditoUsado: number
  pagamentos: PagamentoDaVenda[]
}) {
  if (venda.forma !== FORMA_MISTA) {
    return [
      { forma_pagamento: pagamentoNaNota(venda.forma), valor_pagamento: arredondar(venda.total) },
    ]
  }
  const linhas = pagamentosDaVenda(venda).map((p) => ({
    forma_pagamento: pagamentoNaNota(p.forma),
    valor_pagamento: arredondar(p.valor),
  }))
  if (venda.creditoUsado > 0) {
    linhas.push({ forma_pagamento: CREDITO_LOJA, valor_pagamento: arredondar(venda.creditoUsado) })
  }
  return linhas
}

/** "Crédito em loja" na tabela atual da SEFAZ (o 05 virou cartão da loja). */
const CREDITO_EM_LOJA = "21"

/**
 * As formas de pagamento da NF-e. Sem elas a Focus preenche sozinha "01 -
 * Dinheiro" no total, e foi assim que saiu toda NF-e até 25/11/2026.
 *
 * Três diferenças para a NFC-e: o crédito abatido é sempre linha própria; o
 * frete cobrado na nota entra no pagamento (a SEFAZ recusa pagamento menor que
 * o total); e a transferência é 90, "sem pagamento", que só aceita valor zero.
 */
export function formasDePagamentoDaNfe(
  venda: Parameters<typeof formasDePagamentoDaNota>[0],
  valorFrete = 0
) {
  if (ehTransferenciaEntreLojas(venda.forma)) {
    return [{ forma_pagamento: SEM_PAGAMENTO, valor_pagamento: 0 }]
  }

  const linhas = pagamentosDaVenda(venda)
    .map((p, i) => linhaDaNfe(p.forma, arredondar(p.valor + (i === 0 ? valorFrete : 0))))
    .filter((l) => l.valor_pagamento > 0)
  const credito = arredondar(venda.creditoUsado ?? 0)
  if (credito > 0) linhas.push({ forma_pagamento: CREDITO_EM_LOJA, valor_pagamento: credito })
  return linhas
}

const SEM_PAGAMENTO = "90"

function linhaDaNfe(forma: string, valor: number): {
  forma_pagamento: string
  valor_pagamento: number
  indicador_pagamento?: number
  descricao_pagamento?: string
} {
  const codigo = pagamentoNaNota(forma)
  return {
    forma_pagamento: codigo,
    valor_pagamento: valor,
    // 1 é a prazo: o boleto e o Pix que se paga na entrega.
    indicador_pagamento: forma === "prazo" || forma === "entrega" ? 1 : 0,
    // O 99 ("outros") exige dizer qual é.
    ...(codigo === "99"
      ? { descricao_pagamento: ROTULO_NA_NOTA[forma] ?? rotuloDaForma(forma) }
      : {}),
  }
}

function reais(valor: number) {
  const [inteiro, centavos] = valor.toFixed(2).split(".")
  return `R$ ${inteiro.replace(/\B(?=(\d{3})+$)/g, ".")},${centavos}`
}

function dataNaNota(data: Date) {
  return data.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })
}

/**
 * A condição de pagamento por extenso, para as informações complementares da
 * NF-e: "PAGAMENTO: Boleto - 30/60 dias: 17/12/2026 R$ 100,00; ...".
 *
 * As parcelas são as do boleto (a mesma conta, com o crédito já abatido), para a
 * nota não prometer valor ou data diferentes. Só caracteres que o schema da
 * SEFAZ aceita: o travessão dos rótulos da tela derrubaria a nota inteira.
 *
 * Vazio na transferência entre lojas, em que ninguém paga nada.
 */
export function condicaoPorExtenso(venda: {
  forma: string
  total: number
  creditoUsado: number
  pagamentos: PagamentoDaVenda[]
  condicao: string | null
  vencimento: Date | null
  criadaEm: Date
}): string {
  if (ehTransferenciaEntreLojas(venda.forma)) return ""

  const credito = arredondar(venda.creditoUsado ?? 0)
  const aPagar = arredondar(venda.total - credito)
  const partes: string[] = []
  if (credito > 0) partes.push(`Crédito/devolução abatido ${reais(credito)}`)

  if (aPagar > 0) {
    if (venda.forma === "prazo") {
      const condicao = condicaoPorId(venda.condicao ?? "")
      const parcelas = parcelasDoBoleto(venda)
      const titulo = condicao ? `Boleto - ${condicao.dias.join("/")} dias` : "Boleto"
      const vencimentos = parcelas.map(
        (p, i) =>
          `${parcelas.length > 1 ? `${i + 1}a ` : ""}venc. ${dataNaNota(p.vencimento)} ${reais(p.valor)}`
      )
      partes.push(vencimentos.length ? `${titulo}: ${vencimentos.join("; ")}` : titulo)
    } else if (venda.forma === "entrega" && venda.vencimento) {
      partes.push(`Pix na entrega - venc. ${dataNaNota(venda.vencimento)} ${reais(aPagar)}`)
    } else {
      partes.push(
        pagamentosDaVenda(venda)
          .map((p) => `${ROTULO_NA_NOTA[p.forma] ?? rotuloDaForma(p.forma)} ${reais(p.valor)}`)
          .join("; ")
      )
    }
  }

  return partes.length ? `PAGAMENTO: ${partes.join(" + ")}.` : ""
}

type VendaAPrazo = {
  forma: string
  total: number
  creditoUsado: number
  condicao: string | null
  vencimento: Date | null
  criadaEm: Date
}

/**
 * As parcelas que o cliente vai pagar por boleto ou Pix na entrega: o que
 * ficou a pagar depois do crédito, repartido pela condição. A MESMA conta do
 * boleto (`planoDaVenda` em cobranca.server), para a nota não prometer valor
 * ou data diferentes do papel que o cliente recebe.
 */
function parcelasDoBoleto(venda: VendaAPrazo): { valor: number; vencimento: Date }[] {
  const aPagar = arredondar(venda.total - (venda.creditoUsado ?? 0))
  if (!(aPagar > 0)) return []
  if (venda.forma === "prazo") {
    const condicao = condicaoPorId(venda.condicao ?? "")
    if (condicao) return parcelasDaCondicao(condicao, aPagar, venda.criadaEm)
  }
  if ((venda.forma === "prazo" || venda.forma === "entrega") && venda.vencimento) {
    return [{ valor: aPagar, vencimento: venda.vencimento }]
  }
  return []
}

/**
 * O grupo de cobrança da NF-e (`<cobr>`): a fatura e as duplicatas, que o DANFE
 * imprime no quadro "Fatura/Duplicatas" — com número, vencimento e valor de
 * cada parcela. Antes isso só existia por extenso nas informações
 * complementares, e quem recebe a nota procura as parcelas no quadro.
 *
 * Só na venda a prazo (boleto) e no Pix na entrega; à vista não há fatura. O
 * número da duplicata tem de ter três algarismos sequenciais ("001", "002"…):
 * é regra do schema, e outro formato derruba a nota.
 */
export function cobrancaDaNfe(venda: VendaAPrazo & { numero: number }) {
  if (ehTransferenciaEntreLojas(venda.forma)) return {}
  const parcelas = parcelasDoBoleto(venda)
  if (parcelas.length === 0) return {}

  // A SEFAZ recusa duplicata vencida em relação à data de emissão. A nota de
  // uma venda emitida depois do vencimento sai sem o quadro — as parcelas
  // continuam no texto das informações complementares — em vez de ser recusada.
  const hoje = dataSemHora(new Date())
  if (parcelas.some((p) => dataSemHora(p.vencimento) < hoje)) return {}

  const total = arredondar(parcelas.reduce((soma, p) => soma + p.valor, 0))
  return {
    numero_fatura: String(venda.numero),
    valor_original_fatura: total,
    valor_desconto_fatura: 0,
    valor_liquido_fatura: total,
    duplicatas: parcelas.map((p, i) => ({
      numero: String(i + 1).padStart(3, "0"),
      data_vencimento: dataSemHora(p.vencimento),
      valor: arredondar(p.valor),
    })),
  }
}

/** "2026-12-12" no fuso de Brasília — o formato da Focus, e comparável como texto. */
function dataSemHora(data: Date) {
  return data.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })
}

const ROTULO_NA_NOTA: Record<string, string> = {
  credito: "Cartão de crédito",
  debito: "Cartão de débito",
  link: "Link de pagamento",
}

const SO_DIGITOS = /^\d+$/

/** CFOP: quatro dígitos, começando em 5 (dentro do estado) ou 6 (fora). */
export function validarCfop(valor: string) {
  return valor.length === 4 && SO_DIGITOS.test(valor) && /^[1-7]/.test(valor)
}

/**
 * CSOSN do Simples: três dígitos, ou quatro quando vem com a origem na frente
 * ("0102"). O CST do regime normal tem dois.
 */
export function validarCsosn(valor: string) {
  if (!SO_DIGITOS.test(valor)) return false
  if (valor.length === 4) return /^[0-8]/.test(valor)
  return valor.length === 3 || valor.length === 2
}

/** CEST: sete dígitos, exigido em quem tem substituição tributária. */
export function validarCest(valor: string) {
  return valor.length === 7 && SO_DIGITOS.test(valor)
}

/** Origem: um dígito, de 0 a 8. */
export function validarOrigem(valor: string) {
  return valor.length === 1 && /^[0-8]$/.test(valor)
}

/**
 * A inscrição estadual do DF tem 13 dígitos; outras UFs variam de 8 a 14. Como
 * a IE do emitente entra na nota inteira (não só num item), vazia ou torta
 * derruba toda a emissão — daí a conferência de tamanho aqui.
 */
export function validarInscricaoEstadualEmitente(valor: string) {
  const ie = valor.replace(/\D/g, "")
  return ie.length >= 8 && ie.length <= 14
}

/**
 * O que impede esta loja de emitir. Lista vazia significa pronta.
 *
 * Existe para a tela poder dizer o que falta em vez de só recusar — e para a
 * emissão conferir a mesma coisa antes de gastar uma chamada na Focus.
 */
export function pendenciasDoEmitente(loja: {
  cnpj: string
  razaoSocial: string | null
  inscricaoEstadual: string | null
  regimeTributario: number | null
  endereco: string | null
  bairro: string | null
  cidade: string | null
  uf: string | null
  cep: string | null
}): string[] {
  const faltando: string[] = []

  if (!loja.razaoSocial) faltando.push("razão social")
  if (!loja.cnpj) faltando.push("CNPJ")
  if (!loja.inscricaoEstadual || !validarInscricaoEstadualEmitente(loja.inscricaoEstadual)) {
    faltando.push("inscrição estadual")
  }
  if (!loja.regimeTributario) faltando.push("regime tributário")
  if (!loja.endereco || !loja.bairro || !loja.cidade || !loja.uf || !loja.cep) {
    faltando.push("endereço completo")
  }

  return faltando
}
