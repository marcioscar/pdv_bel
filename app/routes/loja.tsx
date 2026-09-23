import { useState } from "react"
import { data, Form, useNavigation } from "react-router"
import { Store } from "lucide-react"

import type { Route } from "./+types/loja"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { listarLojas } from "~/lib/lojas.server"
import { cookieDaLojaDaMaquina, lojaDaMaquina } from "~/lib/maquina.server"
import { ACOES_DE_GERENTE, ehGerente } from "~/lib/permissoes"
import { conferirGerente, definirLojaDaSessao, usuarioDaSessao } from "~/lib/sessao.server"
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

  const daMaquina = await lojaDaMaquina(request)

  return {
    nome: usuario.nome,
    atual: usuario.loja,
    lojas,
    destino,
    daMaquina,
    // Navegador sem loja fixa — computador novo, aba anônima, cookies limpos —
    // não é o operador quem decide onde ele vende: o gerente digita a senha.
    precisaGerente: !daMaquina && !ehGerente(usuario.papel),
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
   * A primeira escolha num computador sem loja o fixa — e essa escolha é do
   * GERENTE.
   *
   * Fixado, o computador entra sempre na mesma loja: a sessão nova já nasce com
   * ela (`lojaParaEntrar`) e esta tela, com loja na sessão, é só do gerente. A
   * loja é do lugar, não da pessoa: os vendedores revezam, e o caixa da QNE
   * continua na QNE.
   *
   * Quem fixava era qualquer um, e o cookie da máquina é do navegador: numa aba
   * anônima ele não existe, e o operador escolhia a loja que quisesse. Agora,
   * sem loja fixa, o operador só passa daqui com a senha de um gerente — e num
   * computador fixo, só entra na loja dele.
   *
   * Já fixado, mudar é do gerente e continua opcional para ele, que cobre turno
   * em outra loja: quem visita a QNE e troca de loja no terminal da QI não pode
   * deixar aquele caixa apontando para a QNE.
   */
  const daMaquina = await lojaDaMaquina(request)
  if (!ehGerente(usuario.papel)) {
    if (daMaquina && escolhida !== daMaquina) {
      return data(
        { erro: `Este computador é o caixa da ${daMaquina} — só um gerente muda` },
        { status: 403 }
      )
    }
    if (!daMaquina) {
      const email = String(form.get("gerenteEmail") ?? "")
      const senha = String(form.get("gerenteSenha") ?? "")
      if (!email || !senha) {
        return data(
          { erro: "Este computador ainda não tem loja — um gerente precisa digitar a senha" },
          { status: 403 }
        )
      }
      const gerente = await conferirGerente(email, senha)
      if (!gerente.ok) return data({ erro: gerente.erro }, { status: 403 })
    }
  }

  const fixar =
    !daMaquina ||
    (String(form.get("padraoDaMaquina")) === "on" && ehGerente(usuario.papel))
  const cookies = fixar ? [await cookieDaLojaDaMaquina(escolhida)] : []

  return definirLojaDaSessao(request, escolhida, destino, cookies)
}

export default function EscolherLoja({ loaderData, actionData }: Route.ComponentProps) {
  const { nome, atual, lojas, destino, daMaquina, podeFixar, precisaGerente } = loaderData
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"
  const [fixar, setFixar] = useState(false)
  // Os campos do gerente valem para qualquer um dos botões de loja, então o
  // valor mora aqui e vai escondido em cada formulário.
  const [gerenteEmail, setGerenteEmail] = useState("")
  const [gerenteSenha, setGerenteSenha] = useState("")

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

        {precisaGerente && lojas.length > 0 ? (
          <div className="mt-5 rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
            <p className="text-xs">
              <b className="font-semibold">Este computador ainda não tem loja.</b> Um gerente
              digita a senha e escolhe a loja — daí em diante, quem entrar aqui cai direto
              nela.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Input
                type="email"
                value={gerenteEmail}
                onChange={(e) => setGerenteEmail(e.target.value)}
                placeholder="E-mail do gerente"
                autoComplete="off"
                className="h-9 min-w-44 flex-1 rounded-lg bg-background text-sm"
              />
              <Input
                type="password"
                value={gerenteSenha}
                onChange={(e) => setGerenteSenha(e.target.value)}
                placeholder="Senha"
                autoComplete="off"
                className="h-9 min-w-32 flex-1 rounded-lg bg-background text-sm"
              />
            </div>
          </div>
        ) : null}

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
                {precisaGerente ? (
                  <>
                    <input type="hidden" name="gerenteEmail" value={gerenteEmail} />
                    <input type="hidden" name="gerenteSenha" value={gerenteSenha} />
                  </>
                ) : null}
                {/* Sem padrão ainda, o action fixa de qualquer jeito. Havendo,
                    só muda se o gerente marcar a caixa abaixo. */}
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

        {!daMaquina ? (
          precisaGerente ? null : (
            <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
              <b className="font-semibold text-foreground">
                A loja escolhida fica fixa neste computador.
              </b>{" "}
              Quem entrar aqui depois cai direto nela, e só um gerente troca.
            </p>
          )
        ) : podeFixar ? (
          <label className="mt-4 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={fixar}
              onChange={(e) => setFixar(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Este computador é o caixa da{" "}
              <b className="font-semibold text-foreground">{daMaquina}</b>. Marque para
              trocar o padrão do terminal — se você só está cobrindo um turno em outra
              loja, deixe desmarcado.
            </span>
          </label>
        ) : (
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            Este computador é o caixa da{" "}
            <b className="font-semibold text-foreground">{daMaquina}</b>. Só um gerente
            muda isso.
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
