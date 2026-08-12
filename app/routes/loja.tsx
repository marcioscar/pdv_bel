import { data, Form, useNavigation } from "react-router"
import { Store } from "lucide-react"

import type { Route } from "./+types/loja"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { listarLojas } from "~/lib/lojas.server"
import {
  definirLojaDaSessao,
  usuarioDaSessao,
} from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Escolher a loja — PDV BrasSaco" }]
}

function destinoSeguro(bruto: string | null) {
  if (!bruto || !bruto.startsWith("/") || bruto.startsWith("//")) return "/"
  return bruto
}

/**
 * Escolha da loja.
 *
 * Existe porque um funcionário atende em mais de uma loja: a loja é do turno, não
 * do cadastro. Também é a tela de "trocar de loja", sem pedir a senha de novo — o
 * cadastro já diz onde ele pode operar, e trocar não amplia permissão nenhuma.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const usuario = await usuarioDaSessao(request)
  const destino = destinoSeguro(new URL(request.url).searchParams.get("destino"))

  if (!usuario) {
    throw new Response(null, {
      status: 302,
      headers: { location: `/entrar?destino=${encodeURIComponent(destino)}` },
    })
  }

  const todas = await listarLojas()
  const lojas = todas.filter((l) => usuario.lojasPermitidas.includes(l.codigo))

  return { nome: usuario.nome, atual: usuario.loja, lojas, destino }
}

export async function action({ request }: Route.ActionArgs) {
  const usuario = await usuarioDaSessao(request)
  if (!usuario) throw new Response(null, { status: 302, headers: { location: "/entrar" } })

  const form = await request.formData()
  const escolhida = String(form.get("loja") ?? "")
  const destino = destinoSeguro(String(form.get("destino") ?? "/"))

  // Só o que o cadastro permite. Sem esta checagem, um POST à mão escolheria
  // qualquer loja da rede.
  if (!usuario.lojasPermitidas.includes(escolhida)) {
    return data({ erro: "Você não tem acesso a essa loja" }, { status: 403 })
  }

  return definirLojaDaSessao(request, escolhida, destino)
}

export default function EscolherLoja({ loaderData, actionData }: Route.ComponentProps) {
  const { nome, atual, lojas, destino } = loaderData
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-7 shadow-lg">
        <span className="mb-6 block w-fit rounded-md bg-white px-2 py-1">
          <img
            src="/logo_bel.svg"
            alt="BrasSaco Embalagens"
            className="h-7 w-auto"
            width={349}
            height={86}
          />
        </span>

        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Store className="size-4" aria-hidden />
          Em qual loja você está?
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {nome} · a venda, o estoque e o boleto ficam na loja escolhida
        </p>

        {lojas.length === 0 ? (
          <p className="mt-6 text-sm text-destructive">
            Seu cadastro não tem loja liberada. Peça ao gerente para vincular.
          </p>
        ) : (
          <div className="mt-5 space-y-2">
            {lojas.map((loja, i) => (
              <Form method="post" key={loja.codigo}>
                <input type="hidden" name="destino" value={destino} />
                <input type="hidden" name="loja" value={loja.codigo} />
                <Button
                  type="submit"
                  disabled={enviando}
                  variant={loja.codigo === atual ? "default" : "outline"}
                  className={cn("h-12 w-full justify-start rounded-lg text-base")}
                >
                  <Kbd className="mr-1">{i + 1}</Kbd>
                  <span className="font-semibold">{loja.codigo}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {loja.nome !== loja.codigo ? loja.nome : ""}
                  </span>
                  {loja.codigo === atual ? (
                    <span className="ml-auto text-xs">atual</span>
                  ) : null}
                </Button>
              </Form>
            ))}
          </div>
        )}

        {actionData?.erro ? (
          <p className="mt-3 text-xs font-medium text-destructive" role="alert">
            {actionData.erro}
          </p>
        ) : null}
      </div>
    </main>
  )
}
