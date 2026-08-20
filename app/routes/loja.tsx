import { useState } from "react"
import { data, Form, useNavigation } from "react-router"
import { Store } from "lucide-react"

import type { Route } from "./+types/loja"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { listarLojas } from "~/lib/lojas.server"
import { cookieDaLojaDaMaquina, lojaDaMaquina } from "~/lib/maquina.server"
import { ACOES_DE_GERENTE, ehGerente } from "~/lib/permissoes"
import { definirLojaDaSessao, usuarioDaSessao } from "~/lib/sessao.server"
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
 * do cadastro.
 *
 * A tela faz duas coisas parecidas com pesos muito diferentes, e a diferença é
 * ter ou não loja na sessão:
 *
 * - **Escolher ao entrar** (sem loja ainda): qualquer um faz, senão o operador
 *   de duas lojas não conseguiria trabalhar.
 * - **Trocar no meio do turno** (já com loja): só gerente. Trocar move venda,
 *   estoque e caixa para outra prateleira, e um caixa aberto numa loja com o
 *   operador vendendo na outra é um dia inteiro de conferência errada.
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

  // `usuario.loja` só existe depois de escolhida: é ela que separa a entrada da
  // troca. Em `usuarioDaSessao` ela vem vazia enquanto ninguém escolheu.
  const trocando = Boolean(usuario.loja)
  if (trocando && !ehGerente(usuario.papel)) {
    throw new Response(ACOES_DE_GERENTE.trocarDeLoja, { status: 403 })
  }

  const todas = await listarLojas()
  const lojas = todas.filter((l) => usuario.lojasPermitidas.includes(l.codigo))

  return {
    nome: usuario.nome,
    atual: usuario.loja,
    lojas,
    destino,
    daMaquina: await lojaDaMaquina(request),
    // Configurar o terminal é do gerente: a loja fixa decide onde toda venda
    // feita aqui vai ser gravada, por todos os turnos seguintes.
    podeFixar: ehGerente(usuario.papel),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const usuario = await usuarioDaSessao(request)
  if (!usuario) throw new Response(null, { status: 302, headers: { location: "/entrar" } })

  // A guarda vale no action também: o loader protege a tela, e é o action que
  // move a loja de verdade.
  if (usuario.loja && !ehGerente(usuario.papel)) {
    return data({ erro: ACOES_DE_GERENTE.trocarDeLoja }, { status: 403 })
  }

  const form = await request.formData()
  const escolhida = String(form.get("loja") ?? "")
  const destino = destinoSeguro(String(form.get("destino") ?? "/"))

  // Só o que o cadastro permite. Sem esta checagem, um POST à mão escolheria
  // qualquer loja da rede.
  if (!usuario.lojasPermitidas.includes(escolhida)) {
    return data({ erro: "Você não tem acesso a essa loja" }, { status: 403 })
  }

  /**
   * Gravar o padrão da máquina é do GERENTE, e nunca automático.
   *
   * Antes, a primeira escolha de qualquer um virava o padrão do terminal: o
   * primeiro operador que entrasse decidia onde aquele caixa gravaria venda pelos
   * turnos seguintes. Configuração de terminal é decisão de quem responde pela
   * loja, não efeito colateral de um login.
   *
   * E continua opcional mesmo para o gerente, porque ele cobre turno em outra
   * loja: quem visita a QNE e troca de loja no terminal da QI não pode deixar
   * aquele caixa apontando para a QNE — o vendedor de segunda venderia na loja
   * errada sem tocar em nada.
   */
  const cookies: string[] = []
  if (String(form.get("padraoDaMaquina")) === "on" && ehGerente(usuario.papel)) {
    cookies.push(await cookieDaLojaDaMaquina(escolhida))
  }

  return definirLojaDaSessao(request, escolhida, destino, cookies)
}

export default function EscolherLoja({ loaderData, actionData }: Route.ComponentProps) {
  const { nome, atual, lojas, destino, daMaquina, podeFixar } = loaderData
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"
  const [fixar, setFixar] = useState(false)

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
                {/* Sem padrão nenhum ainda, a primeira escolha vira o padrão do
                    terminal — é o caso da instalação. Havendo padrão, só muda se
                    a pessoa marcar a caixa abaixo. */}
                {/* Fixar é sempre uma escolha explícita do gerente. */}
                <input
                  type="hidden"
                  name="padraoDaMaquina"
                  value={podeFixar && fixar ? "on" : "off"}
                />
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
                  <span className="ml-auto flex items-center gap-2 text-xs">
                    {loja.codigo === daMaquina ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        deste caixa
                      </span>
                    ) : null}
                    {loja.codigo === atual ? "atual" : null}
                  </span>
                </Button>
              </Form>
            ))}
          </div>
        )}

        {podeFixar ? (
          <label className="mt-4 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={fixar}
              onChange={(e) => setFixar(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              {daMaquina ? (
                <>
                  Este computador é o caixa da{" "}
                  <b className="font-semibold text-foreground">{daMaquina}</b>. Marque
                  para trocar o padrão do terminal — se você só está cobrindo um turno
                  em outra loja, deixe desmarcado.
                </>
              ) : (
                <>
                  <b className="font-semibold text-foreground">Fixar neste computador.</b>{" "}
                  Quem entrar aqui nos próximos turnos cai direto na loja escolhida, sem
                  poder trocar. É a configuração do terminal.
                </>
              )}
            </span>
          </label>
        ) : daMaquina ? (
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            Este computador é o caixa da{" "}
            <b className="font-semibold text-foreground">{daMaquina}</b>. Só um gerente
            muda isso.
          </p>
        ) : (
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            Escolha vale para este turno. Para o computador entrar sempre na mesma loja,
            um gerente precisa fixar.
          </p>
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
