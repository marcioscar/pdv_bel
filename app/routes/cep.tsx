import type { Route } from "./+types/cep"
import { limparCep, validarCep } from "~/lib/documento"

export type EnderecoDoCep = {
  cep: string
  endereco: string
  bairro: string
  cidade: string
  uf: string
}

type RespostaBrasilApi = {
  street?: string
  neighborhood?: string
  city?: string
  state?: string
}

type RespostaViaCep = {
  logradouro?: string
  bairro?: string
  localidade?: string
  uf?: string
  erro?: boolean | string
}

const TEMPO_LIMITE = 4000

/**
 * Busca o endereço de um CEP. A BrasilAPI é a primeira opção porque agrega vários
 * provedores; o ViaCEP entra quando ela falha, para o cadastro não travar por
 * indisponibilidade de um serviço de terceiro.
 */
async function consultar(cep: string): Promise<EnderecoDoCep | null> {
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, {
      signal: AbortSignal.timeout(TEMPO_LIMITE),
    })
    if (r.ok) {
      const d = (await r.json()) as RespostaBrasilApi
      if (d.city && d.state) {
        return {
          cep,
          endereco: d.street ?? "",
          bairro: d.neighborhood ?? "",
          cidade: d.city,
          uf: d.state,
        }
      }
    }
  } catch {
    // cai para o ViaCEP
  }

  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: AbortSignal.timeout(TEMPO_LIMITE),
    })
    if (!r.ok) return null
    const d = (await r.json()) as RespostaViaCep
    if (d.erro || !d.localidade || !d.uf) return null
    return {
      cep,
      endereco: d.logradouro ?? "",
      bairro: d.bairro ?? "",
      cidade: d.localidade,
      uf: d.uf,
    }
  } catch {
    return null
  }
}

export async function loader({ params }: Route.LoaderArgs) {
  const cep = limparCep(params.cep ?? "")
  if (!validarCep(cep)) {
    return Response.json({ erro: "CEP deve ter 8 dígitos" }, { status: 400 })
  }

  const endereco = await consultar(cep)
  if (!endereco) {
    return Response.json({ erro: "CEP não encontrado" }, { status: 404 })
  }

  return Response.json(endereco, {
    // O CEP não muda; cachear evita bater no serviço a cada tecla.
    headers: { "cache-control": "private, max-age=86400" },
  })
}
