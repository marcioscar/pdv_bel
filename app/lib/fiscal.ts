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
/**
 * Transferência de mercadoria adquirida de terceiros para outro estabelecimento
 * da mesma empresa, dentro do estado.
 *
 * É o caso da carga que sai da QI para a QNE: são CNPJs diferentes (matriz e
 * filial), a mercadoria muda de estabelecimento e por isso precisa de nota — mas
 * ninguém comprou nada, e uma nota de venda ali inventaria faturamento.
 */
export const CFOP_TRANSFERENCIA = "5152"

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
  }: { interestadual?: boolean; transferencia?: boolean } = {}
): TributacaoDoItem {
  const doProduto = separarOrigemDoCsosn(produto.csosn ?? "")
  const daLoja = separarOrigemDoCsosn(loja.csosnPadrao ?? "")
  const csosn = doProduto.csosn || daLoja.csosn || CSOSN_PADRAO

  const padrao = transferencia
    ? loja.cfopTransferencia || CFOP_TRANSFERENCIA
    : interestadual
      ? loja.cfopVendaInterestadual || CFOP_VENDA_INTERESTADUAL
      : loja.cfopVendaInterna || CFOP_VENDA_INTERNA

  /*
   * A dedução do 5405 vale só para VENDA: transferência de mercadoria com ICMS
   * retido tem CFOP próprio (5409), e adivinhar ali seria adivinhar errado —
   * quem tiver esse caso cadastra o CFOP no produto.
   */
  const cfop =
    produto.cfop ||
    (csosn === CSOSN_ST && !interestadual && !transferencia ? CFOP_VENDA_ST : padrao)

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
 * Cliente empresa e venda a prazo vão de NF-e: a primeira porque o comprador
 * precisa da nota para se creditar, a segunda porque a cobrança fica registrada
 * no nome dele. O resto do balcão é NFC-e, que é o cupom fiscal.
 *
 * Mora aqui, e não no módulo de servidor, porque a TELA também precisa saber: é
 * o que escreve "Emitir NFC-e" ou "Emitir NF-e" no botão antes de qualquer
 * chamada — e um `.server` importado pelo componente quebra o build.
 */
export function modeloDaVenda(venda: {
  forma: string
  clienteCpfCnpj: string | null
}): ModeloNota {
  const documento = (venda.clienteCpfCnpj ?? "").replace(/\D/g, "")
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
