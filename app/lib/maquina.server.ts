import { createCookieSessionStorage } from "react-router"

import "~/lib/env.server"
import { segredoDoCookie } from "~/lib/sessao.server"

/**
 * A loja padrão DESTA máquina.
 *
 * Os vendedores revezam de loja nos fins de semana, então a loja não é uma
 * propriedade da pessoa — é do lugar. O caixa da QNE está sempre na QNE, e o
 * computador é o que não muda. Guardar a loja aqui faz o vendedor entrar já na
 * loja certa, sem escolher nada: um passo a menos por turno e, principalmente,
 * uma chance a menos de vender na loja errada depois de trocar de posto.
 *
 * Cookie SEPARADO do de sessão, de propósito: ele precisa sobreviver ao logout,
 * porque quem senta no caixa amanhã é outra pessoa e a loja continua a mesma.
 *
 * Assinado com o mesmo segredo. Não é credencial — a permissão continua sendo
 * checada contra `lojasPermitidas` a cada requisição — mas um padrão que se edita
 * pelo navegador mudaria em silêncio onde a venda é gravada.
 */
type Preferencia = { loja: string }

let armazemCache: ReturnType<
  typeof createCookieSessionStorage<Preferencia>
> | null = null

function armazem() {
  if (armazemCache) return armazemCache

  armazemCache = createCookieSessionStorage<Preferencia>({
    cookie: {
      name: "pdv_maquina",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      // Um ano: é configuração de terminal, não de turno.
      maxAge: 60 * 60 * 24 * 365,
      secrets: [segredoDoCookie()],
      secure: process.env.NODE_ENV === "production",
    },
  })
  return armazemCache
}

export async function lojaDaMaquina(request: Request): Promise<string | null> {
  const cookie = await armazem().getSession(request.headers.get("cookie"))
  return cookie.get("loja") ?? null
}

/** Devolve o `set-cookie` para gravar o padrão da máquina. */
export async function cookieDaLojaDaMaquina(loja: string): Promise<string> {
  const cookie = await armazem().getSession()
  cookie.set("loja", loja)
  return armazem().commitSession(cookie)
}
