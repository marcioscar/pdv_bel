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
/** Venda de mercadoria já com o ICMS retido por substituição tributária. */
export const CFOP_VENDA_ST = "5405"

/** Simples Nacional, tributada sem permissão de crédito de ICMS. */
export const CSOSN_PADRAO = "102"
/** Simples Nacional, mercadoria com ICMS retido por substituição tributária. */
export const CSOSN_ST = "500"

/** Mercadoria nacional. */
export const ORIGEM_NACIONAL = "0"

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

/** O que a loja usa quando o produto não traz exceção. */
export type PadraoDaLoja = {
  cfopVendaInterna: string | null
  cfopVendaInterestadual: string | null
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
  { interestadual = false }: { interestadual?: boolean } = {}
): TributacaoDoItem {
  const csosn = produto.csosn || loja.csosnPadrao || CSOSN_PADRAO

  const padrao = interestadual
    ? loja.cfopVendaInterestadual || CFOP_VENDA_INTERESTADUAL
    : loja.cfopVendaInterna || CFOP_VENDA_INTERNA

  const cfop = produto.cfop || (csosn === CSOSN_ST && !interestadual ? CFOP_VENDA_ST : padrao)

  return {
    cfop,
    csosn,
    origem: produto.origemFiscal || ORIGEM_NACIONAL,
    cest: produto.cest || null,
  }
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
  prazo: "15",
  link: "99",
}

export function pagamentoNaNota(forma: string) {
  return PAGAMENTO_NA_NOTA[forma] ?? "99"
}

const SO_DIGITOS = /^\d+$/

/** CFOP: quatro dígitos, começando em 5 (dentro do estado) ou 6 (fora). */
export function validarCfop(valor: string) {
  return valor.length === 4 && SO_DIGITOS.test(valor) && /^[1-7]/.test(valor)
}

/** CSOSN do Simples: três dígitos. O CST do regime normal tem dois. */
export function validarCsosn(valor: string) {
  return (valor.length === 3 || valor.length === 2) && SO_DIGITOS.test(valor)
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
