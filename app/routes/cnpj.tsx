import type { Route } from "./+types/cnpj"
import { limparDocumento, validarCnpj } from "~/lib/documento"
import { exigirUsuario } from "~/lib/sessao.server"

export type DadosDoCnpj = {
  cnpj: string
  nome: string
  fantasia: string
  endereco: string
  numero: string
  complemento: string
  bairro: string
  cidade: string
  uf: string
  cep: string
  ddd: string
  telefone: string
  email: string
  /** "ATIVA", "BAIXADA"… — vale o aviso antes de vender a prazo. */
  situacao: string
}

type RespostaBrasilApi = {
  razao_social?: string
  nome_fantasia?: string
  logradouro?: string
  descricao_tipo_de_logradouro?: string
  numero?: string
  complemento?: string
  bairro?: string
  municipio?: string
  uf?: string
  cep?: string
  ddd_telefone_1?: string
  email?: string
  descricao_situacao_cadastral?: string
}

type RespostaReceitaWs = {
  nome?: string
  fantasia?: string
  logradouro?: string
  numero?: string
  complemento?: string
  bairro?: string
  municipio?: string
  uf?: string
  cep?: string
  telefone?: string
  email?: string
  situacao?: string
  status?: string
}

const TEMPO_LIMITE = 6000

function texto(valor: string | undefined) {
  return (valor ?? "").trim()
}

/**
 * Monta o logradouro do jeito que a Receita devolve — que não é um jeito só.
 * O tipo vem num campo separado ("AVENIDA" + "REPUBLICA DO CHILE"), mas às vezes
 * já vem repetido dentro do próprio logradouro ("QUADRA" + "SAUN QUADRA 5"), e
 * às vezes o número vem colado no fim ("PAULISTA 37" com numero "37"). Sem estas
 * duas aparas o boleto sairia com "AVENIDA PAULISTA 37, 37".
 */
function montarLogradouro(tipo: string, logradouro: string, numero: string) {
  let via = logradouro
  if (numero && numero !== "SN" && via.endsWith(` ${numero}`)) {
    via = via.slice(0, -(numero.length + 1)).trim()
  }
  if (!tipo || via.toUpperCase().startsWith(tipo.toUpperCase())) return via
  return `${tipo} ${via}`.trim()
}

/** "3133334444" → ddd 31, telefone 33334444. Também aceita "(31) 3333-4444". */
function separarTelefone(bruto: string | undefined) {
  const digitos = (bruto ?? "").replace(/\D/g, "")
  // Mais de 11 dígitos é a lista com dois telefones colada; fica só o primeiro.
  if (digitos.length < 10) return { ddd: "", telefone: "" }
  return { ddd: digitos.slice(0, 2), telefone: digitos.slice(2, 11) }
}

/**
 * Consulta o CNPJ na Receita. A BrasilAPI é a primeira opção porque não pede
 * cadastro nem impõe fila; o ReceitaWS entra quando ela falha, para o cadastro
 * não travar por indisponibilidade de um serviço de terceiro — o mesmo arranjo
 * do CEP.
 */
async function consultar(cnpj: string): Promise<DadosDoCnpj | null> {
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      signal: AbortSignal.timeout(TEMPO_LIMITE),
    })
    if (r.ok) {
      const d = (await r.json()) as RespostaBrasilApi
      if (d.razao_social) {
        const numero = texto(d.numero)
        const { ddd, telefone } = separarTelefone(d.ddd_telefone_1)
        return {
          cnpj,
          nome: texto(d.razao_social),
          fantasia: texto(d.nome_fantasia),
          endereco: montarLogradouro(
            texto(d.descricao_tipo_de_logradouro),
            texto(d.logradouro),
            numero
          ),
          numero,
          complemento: texto(d.complemento),
          bairro: texto(d.bairro),
          cidade: texto(d.municipio),
          uf: texto(d.uf).toUpperCase(),
          cep: texto(d.cep).replace(/\D/g, ""),
          ddd,
          telefone,
          email: texto(d.email).toLowerCase(),
          situacao: texto(d.descricao_situacao_cadastral).toUpperCase(),
        }
      }
    }
  } catch {
    // cai para o ReceitaWS
  }

  try {
    const r = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpj}`, {
      signal: AbortSignal.timeout(TEMPO_LIMITE),
    })
    if (!r.ok) return null
    const d = (await r.json()) as RespostaReceitaWs
    if (d.status === "ERROR" || !d.nome) return null
    const { ddd, telefone } = separarTelefone(d.telefone)
    const numero = texto(d.numero)
    return {
      cnpj,
      nome: texto(d.nome),
      fantasia: texto(d.fantasia),
      // Aqui o tipo já vem junto do logradouro; só o número repetido é que sobra.
      endereco: montarLogradouro("", texto(d.logradouro), numero),
      numero,
      complemento: texto(d.complemento),
      bairro: texto(d.bairro),
      cidade: texto(d.municipio),
      uf: texto(d.uf).toUpperCase(),
      cep: texto(d.cep).replace(/\D/g, ""),
      ddd,
      telefone,
      email: texto(d.email).toLowerCase(),
      situacao: texto(d.situacao).toUpperCase(),
    }
  } catch {
    return null
  }
}

export async function loader({ params, request }: Route.LoaderArgs) {
  // Evita virar proxy aberto de consulta de CNPJ.
  await exigirUsuario(request)

  const cnpj = limparDocumento(params.cnpj ?? "")
  if (!validarCnpj(cnpj)) {
    return Response.json({ erro: "CNPJ inválido" }, { status: 400 })
  }
  // O CNPJ alfanumérico não é aceito pelos consultores públicos ainda; sem isso
  // a busca voltaria "não encontrado" e pareceria erro de digitação.
  if (!/^\d{14}$/.test(cnpj)) {
    return Response.json(
      { erro: "Consulta indisponível para CNPJ alfanumérico — preencha à mão" },
      { status: 422 }
    )
  }

  const dados = await consultar(cnpj)
  if (!dados) {
    return Response.json({ erro: "CNPJ não encontrado na Receita" }, { status: 404 })
  }

  return Response.json(dados, {
    // O cadastro não muda de hora em hora; cachear evita repetir a consulta
    // quando o operador corrige um campo e volta ao documento.
    headers: { "cache-control": "private, max-age=3600" },
  })
}
