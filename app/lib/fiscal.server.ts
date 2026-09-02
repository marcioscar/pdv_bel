import { db } from "~/lib/db.server"
import {
  regimeValido,
  validarCfop,
  validarCsosn,
  validarInscricaoEstadualEmitente,
} from "~/lib/fiscal"

/**
 * O cadastro do emitente, por loja. É o que a emissão vai ler para montar a
 * nota — e o que a tela de Fiscal edita.
 */
export type EmitenteEntrada = {
  emiteNotaFiscal: boolean
  inscricaoEstadual: string | null
  regimeTributario: number | null
  serieNfce: number | null
  serieNfe: number | null
  cfopVendaInterna: string | null
  cfopVendaInterestadual: string | null
  cfopTransferencia: string | null
  csosnPadrao: string | null
}

export type ResultadoEmitente =
  | { ok: true; mensagem: string }
  | { ok: false; erro: string }

function texto(valor: FormDataEntryValue | null) {
  return typeof valor === "string" ? valor.trim() : ""
}

function inteiro(valor: string): number | null {
  if (!valor) return null
  const n = Number(valor.replace(/\D/g, ""))
  return Number.isFinite(n) && n > 0 ? n : null
}

export function lerEmitente(form: FormData): EmitenteEntrada {
  return {
    emiteNotaFiscal: texto(form.get("emiteNotaFiscal")) === "sim",
    inscricaoEstadual: texto(form.get("inscricaoEstadual")).replace(/\D/g, "") || null,
    regimeTributario: inteiro(texto(form.get("regimeTributario"))),
    serieNfce: inteiro(texto(form.get("serieNfce"))),
    serieNfe: inteiro(texto(form.get("serieNfe"))),
    cfopVendaInterna: texto(form.get("cfopVendaInterna")).replace(/\D/g, "") || null,
    cfopVendaInterestadual: texto(form.get("cfopVendaInterestadual")).replace(/\D/g, "") || null,
    cfopTransferencia: texto(form.get("cfopTransferencia")).replace(/\D/g, "") || null,
    csosnPadrao: texto(form.get("csosnPadrao")).replace(/\D/g, "") || null,
  }
}

/**
 * Lojas com o que a emissão precisa saber. Todas, inclusive as que ainda não
 * emitem: é esta tela que as habilita.
 */
export function listarEmitentes() {
  return db.loja.findMany({
    where: { ativo: true },
    orderBy: [{ ordem: "asc" }, { codigo: "asc" }],
  })
}

export async function salvarEmitente(
  codigo: string,
  entrada: EmitenteEntrada
): Promise<ResultadoEmitente> {
  const loja = await db.loja.findUnique({ where: { codigo } })
  if (!loja) return { ok: false, erro: "Loja não encontrada" }

  if (entrada.inscricaoEstadual && !validarInscricaoEstadualEmitente(entrada.inscricaoEstadual)) {
    return { ok: false, erro: "Inscrição estadual deve ter de 8 a 14 dígitos" }
  }
  if (entrada.regimeTributario && !regimeValido(entrada.regimeTributario)) {
    return { ok: false, erro: "Regime tributário inválido" }
  }
  if (entrada.cfopVendaInterna && !validarCfop(entrada.cfopVendaInterna)) {
    return { ok: false, erro: "CFOP interno inválido — são 4 dígitos, começando em 5" }
  }
  if (entrada.cfopVendaInterestadual && !validarCfop(entrada.cfopVendaInterestadual)) {
    return { ok: false, erro: "CFOP interestadual inválido — são 4 dígitos, começando em 6" }
  }
  if (entrada.cfopTransferencia && !validarCfop(entrada.cfopTransferencia)) {
    return { ok: false, erro: "CFOP de transferência inválido — são 4 dígitos" }
  }
  if (entrada.csosnPadrao && !validarCsosn(entrada.csosnPadrao)) {
    return { ok: false, erro: "CSOSN inválido — 102, ou 0102 com a origem na frente" }
  }

  /*
   * Ligar a emissão sem o cadastro completo produziria uma rejeição da SEFAZ na
   * primeira venda do dia, com o cliente no balcão. É mais barato recusar aqui.
   */
  if (entrada.emiteNotaFiscal) {
    if (!entrada.inscricaoEstadual) {
      return { ok: false, erro: "Para emitir, informe a inscrição estadual" }
    }
    if (!entrada.regimeTributario) {
      return { ok: false, erro: "Para emitir, informe o regime tributário" }
    }
    if (!loja.razaoSocial) {
      return { ok: false, erro: "A loja está sem razão social — a nota sai no nome dela" }
    }
    if (!loja.endereco || !loja.bairro || !loja.cidade || !loja.uf || !loja.cep) {
      return { ok: false, erro: "A loja está sem endereço completo, que vai no cabeçalho da nota" }
    }
  }

  const atualizada = await db.loja.update({
    where: { codigo },
    data: {
      emiteNotaFiscal: entrada.emiteNotaFiscal,
      inscricaoEstadual: entrada.inscricaoEstadual,
      regimeTributario: entrada.regimeTributario,
      serieNfce: entrada.serieNfce,
      serieNfe: entrada.serieNfe,
      cfopVendaInterna: entrada.cfopVendaInterna,
      cfopVendaInterestadual: entrada.cfopVendaInterestadual,
      cfopTransferencia: entrada.cfopTransferencia,
      csosnPadrao: entrada.csosnPadrao,
    },
  })

  return {
    ok: true,
    mensagem: `${atualizada.nome} ${atualizada.emiteNotaFiscal ? "emite nota fiscal" : "salva, sem emissão"}`,
  }
}

/**
 * Quantos produtos ativos têm exceção fiscal cadastrada.
 *
 * É o número que diz se a conversa com o contador já virou cadastro: enquanto
 * for zero, toda a rede está saindo no padrão da loja — o que está certo se
 * nada tiver substituição tributária, e errado se alguma coisa tiver.
 */
export async function contarExcecoesFiscais() {
  const [comCsosn, comCest, semNcm] = await Promise.all([
    db.produto.count({ where: { ativo: true, csosn: { not: null } } }),
    db.produto.count({ where: { ativo: true, cest: { not: null } } }),
    db.produto.count({ where: { ativo: true, OR: [{ ncm: null }, { ncm: "" }] } }),
  ])
  return { comCsosn, comCest, semNcm }
}
