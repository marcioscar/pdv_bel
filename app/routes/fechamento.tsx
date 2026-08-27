import { useState } from "react"
import { data, Form, Link, redirect, useNavigation, useSearchParams } from "react-router"
import { Banknote, Loader2, Lock, Printer, Trash2 } from "lucide-react"

import type { Route } from "./+types/fechamento"
import { Topo } from "~/components/pdv/topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  diferencaRelevante,
  retiradaDaGaveta,
  rotuloDoMovimento,
  SANGRIA_SEM_AUTORIZACAO,
  tipoDeCaixaValido,
  TIPOS_DE_MOVIMENTO_DE_CAIXA,
} from "~/lib/caixa"
import {
  cancelarMovimentoDeCaixa,
  fecharCaixa,
  lancarMovimentoDeCaixa,
  resumoDoDia,
} from "~/lib/caixa.server"
import { diaAtras, diaDeHoje, diaEmTexto } from "~/lib/dia"
import { imprimirDocumento } from "~/lib/impressao"
import { interpretarValor, moeda } from "~/lib/moeda"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { exigirUsuario } from "~/lib/sessao.server"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Fechamento de caixa — BrasSaco" }]
}

const DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * O fechamento do caixa do dia, na loja em que a pessoa está operando.
 *
 * A tela é a conta em voz alta: mostra de onde vem cada parcela do esperado —
 * troco da abertura, vendas em dinheiro, sangrias, reforços — e só então pede o
 * número que ela não sabe, que é quanto há de fato na gaveta. Mostrar só o total
 * esperado transformaria a conferência num "bate ou não bate", sem chance de
 * achar ONDE não bate.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const pedido = new URL(request.url).searchParams.get("dia")
  const dia = pedido && DIA.test(pedido) ? pedido : diaDeHoje()

  return { eu, dia, resumo: await resumoDoDia(eu.loja, dia) }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)
  const formulario = await request.formData()
  const intencao = String(formulario.get("intencao") ?? "")

  const pedido = String(formulario.get("dia") ?? "")
  // A loja vem da SESSÃO, nunca do formulário: com ela no payload daria para
  // mexer no caixa de outra loja.
  const dia = DIA.test(pedido) ? pedido : diaDeHoje()

  if (intencao === "lancar") {
    const tipo = formulario.get("tipo")
    if (!tipoDeCaixaValido(tipo)) {
      return data({ ok: false as const, erro: "Tipo de lançamento inválido" }, { status: 400 })
    }
    const valor = interpretarValor(String(formulario.get("valor") ?? ""))
    if (valor === null) {
      return data({ ok: false as const, erro: "Informe o valor" }, { status: 400 })
    }

    const r = await lancarMovimentoDeCaixa({
      loja: eu.loja,
      dia,
      tipo,
      valor,
      operador: eu.nome,
      operadorId: eu.id,
      observacao: String(formulario.get("observacao") ?? ""),
      gerenteEmail: String(formulario.get("gerenteEmail") ?? "") || undefined,
      gerenteSenha: String(formulario.get("gerenteSenha") ?? "") || undefined,
    })
    if (!r.ok) {
      return data(
        {
          ok: false as const,
          erro: r.erro,
          // A tela abre os campos do gerente em vez de só mostrar o erro.
          precisaGerente: "precisaGerente" in r,
        },
        { status: 400 }
      )
    }

    // Quem foi mandado para cá pelo caixa volta para lá assim que abre: ele
    // estava tentando vender, e provavelmente tem alguém esperando.
    if (tipo === "abertura" && new URL(request.url).searchParams.get("abrir") === "caixa") {
      throw redirect("/")
    }

    return {
      ok: true as const,
      mensagem: r.autorizadaPor
        ? `${rotuloDoMovimento(tipo)} de ${moeda(valor)} lançada — liberada por ${r.autorizadaPor}`
        : `${rotuloDoMovimento(tipo)} de ${moeda(valor)} lançada`,
    }
  }

  if (intencao === "apagar") {
    const r = await cancelarMovimentoDeCaixa(
      String(formulario.get("id") ?? ""),
      eu.loja,
      eu.nome
    )
    if (!r.ok) return data({ ok: false as const, erro: r.erro }, { status: 400 })
    return { ok: true as const, mensagem: "Lançamento cancelado — fica riscado na lista" }
  }

  if (intencao === "fechar") {
    const contado = interpretarValor(String(formulario.get("contado") ?? ""))
    if (contado === null) {
      return data({ ok: false as const, erro: "Informe quanto foi contado" }, { status: 400 })
    }

    const r = await fecharCaixa({
      loja: eu.loja,
      dia,
      contado,
      operador: eu.nome,
      operadorId: eu.id,
      observacao: String(formulario.get("observacao") ?? ""),
    })
    if (!r.ok) return data({ ok: false as const, erro: r.erro }, { status: 400 })

    return {
      ok: true as const,
      mensagem: diferencaRelevante(r.diferenca)
        ? `Caixa fechado com ${r.diferenca > 0 ? "sobra" : "falta"} de ${moeda(Math.abs(r.diferenca))}`
        : "Caixa fechado, gaveta batendo",
    }
  }

  return data({ ok: false as const, erro: "Ação desconhecida" }, { status: 400 })
}

export default function Fechamento({ loaderData, actionData }: Route.ComponentProps) {
  const { eu, dia, resumo } = loaderData
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  const [params, setParams] = useSearchParams()
  // Veio do caixa porque tentou vender antes de abrir: a tela precisa dizer isso,
  // senão a pessoa acha que clicou errado.
  const veioDoCaixa = params.get("abrir") === "caixa"
  // O servidor recusou por falta de gerente: a tela abre os campos da senha.
  const precisaGerente =
    actionData && !actionData.ok && "precisaGerente" in actionData && actionData.precisaGerente
  const navegacao = useNavigation()
  const enviando = navegacao.state !== "idle"
  const fechado = resumo.fechamento

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        loja={eu.loja}
        lojasPermitidas={eu.lojasPermitidas.length}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Banknote className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="text-base font-semibold">Fechamento de caixa</h1>
          <Badge variant="outline" className="font-mono text-[10px]">{eu.loja}</Badge>

          <div className="flex items-center gap-1">
            <input
              type="date"
              value={dia}
              max={diaDeHoje()}
              onChange={(e) => setParams({ dia: e.target.value })}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring"
            />
            {dia !== diaDeHoje() ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setParams({ dia: diaDeHoje() })}
                className="rounded-lg"
              >
                Hoje
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setParams({ dia: diaAtras(1) })}
                className="rounded-lg"
              >
                Ontem
              </Button>
            )}
          </div>
        </div>

        {actionData ? (
          <p
            role="alert"
            className={cn(
              "mt-3 max-w-2xl rounded-lg px-3 py-2 text-sm",
              actionData.ok
                ? "bg-primary/10 text-foreground"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {actionData.ok ? actionData.mensagem : actionData.erro}
          </p>
        ) : null}

        {/* O dia foi reaberto: quem chega aqui precisa saber que está refazendo
            uma contagem, e qual foi a anterior. */}
        {resumo.reabertura ? (
          <div className="mt-4 max-w-2xl rounded-xl border-2 border-primary/40 bg-primary/5 px-4 py-3">
            <p className="text-sm">
              <b>Este caixa foi reaberto</b> por {resumo.reabertura.por} em{" "}
              {new Date(resumo.reabertura.em).toLocaleString("pt-BR")}.
            </p>
            {resumo.reabertura.ultima ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Na contagem anterior, {resumo.reabertura.ultima.fechadoPor} contou{" "}
                <b className="font-mono">{moeda(resumo.reabertura.ultima.contado)}</b> para{" "}
                <span className="font-mono">{moeda(resumo.reabertura.ultima.esperado)}</span>{" "}
                esperados
                {diferencaRelevante(resumo.reabertura.ultima.diferenca)
                  ? ` — ${resumo.reabertura.ultima.diferenca > 0 ? "sobra" : "falta"} de ${moeda(Math.abs(resumo.reabertura.ultima.diferenca))}`
                  : ""}
                . Confira de novo e feche.
              </p>
            ) : null}
          </div>
        ) : null}

        {fechado ? (
          <div className="mt-4 flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
            <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-sm">
              Fechado por <b>{fechado.fechadoPor}</b> em{" "}
              {new Date(fechado.fechadoEm).toLocaleString("pt-BR")}
            </span>
            <BotaoPapel id={fechado.id} />
          </div>
        ) : null}

        {/*
          * Abrir o caixa é a PRIMEIRA coisa do dia, e estava escondida num
          * seletor cujo padrão era "sangria", numa tela chamada Fechamento —
          * ninguém procuraria ali de manhã. Enquanto não há abertura, ela é a
          * única coisa que a tela pede.
          */}
        {!fechado && resumo.abertura === 0 ? (
          <section className="mt-5 max-w-2xl rounded-xl border-2 border-primary/40 bg-primary/5 p-4">
            <h2 className="text-sm font-semibold">
              {veioDoCaixa ? "Abra o caixa antes de vender" : "Abra o caixa deste dia"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {veioDoCaixa
                ? "O caixa desta loja ainda não foi aberto hoje. Conte o troco da gaveta, lance aqui e você volta direto para a venda."
                : "Conte o troco que ficou na gaveta e lance aqui. É esse valor que entra na conta do fim do dia — sem ele, a conferência vai acusar falta."}
            </p>
            <Form
              method="post"
              action={veioDoCaixa ? "/fechamento?abrir=caixa" : undefined}
              className="mt-3 flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="intencao" value="lancar" />
              <input type="hidden" name="dia" value={dia} />
              <input type="hidden" name="tipo" value="abertura" />
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Troco na gaveta
                </span>
                <Input
                  name="valor"
                  inputMode="decimal"
                  placeholder="0,00"
                  required
                  autoComplete="off"
                  autoFocus
                  className="h-12 w-40 rounded-lg border-border bg-background text-right font-mono text-lg tabular-nums"
                />
              </label>
              <Button type="submit" disabled={enviando} className="h-12 rounded-lg px-6 font-semibold">
                Abrir o caixa
              </Button>
            </Form>
          </section>
        ) : null}

        <div className="mt-5 grid max-w-5xl gap-5 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <section>
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Dinheiro na gaveta
            </h2>

            {/* A conta aberta, parcela por parcela. */}
            <dl className="mt-3 rounded-xl border border-border p-4 text-sm">
              <Linha rotulo="Troco da abertura" valor={resumo.abertura} />
              <Linha rotulo="Vendas em dinheiro" valor={resumo.vendasDinheiro} />
              {resumo.suprimentos > 0 ? (
                <Linha rotulo="Reforços" valor={resumo.suprimentos} />
              ) : null}
              {resumo.sangrias > 0 ? (
                <Linha rotulo="Sangrias" valor={-resumo.sangrias} />
              ) : null}

              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Deve haver
                </dt>
                <dd className="font-mono text-xl font-bold tabular-nums">
                  {moeda(fechado ? fechado.esperado : resumo.esperado)}
                </dd>
              </div>

              {/*
                * Quanto sai e quanto fica.
                *
                * Antes de fechar a conta é sobre o ESPERADO, que é uma
                * previsão; depois, sobre o CONTADO, que é o dinheiro que
                * existe de verdade. Prometer sobre o esperado e entregar
                * sobre o contado seria mandar alguém ao cofre com um valor
                * que a gaveta não tem.
                */}
              {(fechado ? fechado.abertura : resumo.abertura) > 0 ? (
                <>
                  <div className="mt-2 flex items-baseline justify-between text-sm">
                    <dt className="text-muted-foreground">
                      Fundo de caixa, fica na gaveta
                    </dt>
                    <dd className="font-mono tabular-nums text-muted-foreground">
                      − {moeda(fechado ? fechado.abertura : resumo.abertura)}
                    </dd>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {fechado ? "A retirar" : "A retirar, se bater"}
                    </dt>
                    <dd className="font-mono text-xl font-bold tabular-nums">
                      {moeda(
                        retiradaDaGaveta(
                          fechado ? fechado.contado : resumo.esperado,
                          fechado ? fechado.abertura : resumo.abertura
                        )
                      )}
                    </dd>
                  </div>
                </>
              ) : null}

              {/* O dia foi reaberto: quem chega aqui precisa saber que está refazendo
            uma contagem, e qual foi a anterior. */}
        {resumo.reabertura ? (
          <div className="mt-4 max-w-2xl rounded-xl border-2 border-primary/40 bg-primary/5 px-4 py-3">
            <p className="text-sm">
              <b>Este caixa foi reaberto</b> por {resumo.reabertura.por} em{" "}
              {new Date(resumo.reabertura.em).toLocaleString("pt-BR")}.
            </p>
            {resumo.reabertura.ultima ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Na contagem anterior, {resumo.reabertura.ultima.fechadoPor} contou{" "}
                <b className="font-mono">{moeda(resumo.reabertura.ultima.contado)}</b> para{" "}
                <span className="font-mono">{moeda(resumo.reabertura.ultima.esperado)}</span>{" "}
                esperados
                {diferencaRelevante(resumo.reabertura.ultima.diferenca)
                  ? ` — ${resumo.reabertura.ultima.diferenca > 0 ? "sobra" : "falta"} de ${moeda(Math.abs(resumo.reabertura.ultima.diferenca))}`
                  : ""}
                . Confira de novo e feche.
              </p>
            ) : null}
          </div>
        ) : null}

        {fechado ? (
                <>
                  <div className="mt-3 flex items-baseline justify-between border-t border-border pt-2">
                    <dt className="text-muted-foreground">Contado</dt>
                    <dd className="font-mono text-lg font-semibold tabular-nums">
                      {moeda(fechado.contado)}
                    </dd>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between">
                    <dt className="text-muted-foreground">Diferença</dt>
                    <dd
                      className={cn(
                        "font-mono text-lg font-bold tabular-nums",
                        diferencaRelevante(fechado.diferenca) && "text-destructive"
                      )}
                    >
                      {fechado.diferenca > 0 ? "+" : ""}
                      {moeda(fechado.diferenca)}
                    </dd>
                  </div>
                  {fechado.observacao ? (
                    <p className="mt-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs">
                      {fechado.observacao}
                    </p>
                  ) : null}
                </>
              ) : (
                <Form method="post" className="mt-4 border-t border-border pt-3">
                  <input type="hidden" name="intencao" value="fechar" />
                  <input type="hidden" name="dia" value={dia} />
                  <label className="block">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Contei na gaveta
                    </span>
                    <Input
                      name="contado"
                      inputMode="decimal"
                      placeholder="0,00"
                      autoComplete="off"
                      required
                      className="mt-1 h-12 rounded-lg border-border bg-background text-right font-mono text-lg tabular-nums"
                    />
                  </label>
                  <Input
                    name="observacao"
                    placeholder="Observação (opcional)"
                    autoComplete="off"
                    className="mt-2 h-10 rounded-lg border-border bg-background text-sm"
                  />
                  <Button
                    type="submit"
                    disabled={enviando}
                    className="mt-3 h-12 w-full rounded-lg text-base font-semibold"
                  >
                    <Lock className="size-4" aria-hidden /> Fechar o caixa deste dia
                  </Button>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Depois de fechado, os lançamentos deste dia não podem mais mudar.
                  </p>
                </Form>
              )}
            </dl>
          </section>

          <section>
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Movimento do dia · {diaEmTexto(dia)}
            </h2>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Cartao rotulo="Dinheiro" valor={resumo.vendasDinheiro} />
              <Cartao rotulo="Pix" valor={resumo.vendasPix} />
              <Cartao rotulo="Débito" valor={resumo.vendasDebito} />
              <Cartao rotulo="Crédito" valor={resumo.vendasCredito} />
              <Cartao rotulo="A prazo" valor={resumo.vendasPrazo} />
              {resumo.vendasLink > 0 ? (
                <Cartao rotulo="Link" valor={resumo.vendasLink} />
              ) : null}
              <Cartao rotulo="Total vendido" valor={resumo.totalVendido} destaque />
            </div>

            <p className="mt-2 text-xs text-muted-foreground">
              {resumo.quantidadeVendas}{" "}
              {resumo.quantidadeVendas === 1 ? "venda" : "vendas"}
              {resumo.canceladas > 0
                ? ` · ${resumo.canceladas} cancelada${resumo.canceladas === 1 ? "" : "s"} (não entram em nada aqui)`
                : ""}
            </p>

            {!fechado ? (
              <>
                <h2 className="mt-6 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Lançar na gaveta
                </h2>
                <Form method="post" className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="intencao" value="lancar" />
                  <input type="hidden" name="dia" value={dia} />
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      O que é
                    </span>
                    <select
                      name="tipo"
                      defaultValue="sangria"
                      className="h-10 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring"
                    >
                      {/* A abertura sai da lista depois de feita: é uma por dia,
                          e deixá-la aqui só produziria a recusa do servidor. */}
                      {Object.entries(TIPOS_DE_MOVIMENTO_DE_CAIXA)
                        .filter(([id]) => id !== "abertura" || resumo.abertura === 0)
                        .map(([id, t]) => (
                          <option key={id} value={id} title={t.ajuda}>
                            {t.rotulo}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Valor
                    </span>
                    <Input
                      name="valor"
                      inputMode="decimal"
                      placeholder="0,00"
                      required
                      autoComplete="off"
                      className="h-10 w-32 rounded-lg border-border bg-background text-right font-mono tabular-nums"
                    />
                  </label>
                  <Input
                    name="observacao"
                    placeholder="Motivo — depósito, pagamento, troco"
                    autoComplete="off"
                    className="h-10 min-w-48 flex-1 rounded-lg border-border bg-background text-sm"
                  />
                  <Button type="submit" disabled={enviando} className="h-10 rounded-lg">
                    Lançar
                  </Button>

                  {/*
                    * Os campos do gerente aparecem só depois de o servidor
                    * recusar. Deixá-los sempre à vista ensinaria o operador a
                    * pedir a senha por reflexo, e uma senha digitada no
                    * automático não é uma segunda pessoa conferindo.
                    */}
                  {precisaGerente ? (
                    <div className="flex w-full flex-wrap items-end gap-2 rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
                      <p className="w-full text-xs">
                        Sangria acima de {moeda(SANGRIA_SEM_AUTORIZACAO)} precisa de um
                        gerente. Ele digita aqui — a sangria continua no nome de quem
                        está operando.
                      </p>
                      <Input
                        name="gerenteEmail"
                        type="email"
                        placeholder="E-mail do gerente"
                        autoComplete="off"
                        className="h-10 min-w-48 flex-1 rounded-lg border-border bg-background text-sm"
                      />
                      <Input
                        name="gerenteSenha"
                        type="password"
                        placeholder="Senha"
                        autoComplete="off"
                        className="h-10 min-w-36 flex-1 rounded-lg border-border bg-background text-sm"
                      />
                    </div>
                  ) : null}
                </Form>
              </>
            ) : null}

            {resumo.movimentos.length > 0 ? (
              <ul className="mt-4 divide-y divide-border border-y border-border">
                {resumo.movimentos.map((m) => (
                  <li
                    key={m.id}
                    className={cn(
                      "flex items-center gap-2 py-2 text-sm",
                      // Cancelado fica visível e riscado: sumir da lista seria o
                      // mesmo que apagar, só que com passo a mais.
                      m.canceladoEm && "opacity-60"
                    )}
                  >
                    <Badge
                      variant={m.canceladoEm ? "destructive" : "outline"}
                      className="shrink-0 text-[10px]"
                    >
                      {m.canceladoEm ? "cancelado" : rotuloDoMovimento(m.tipo)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {m.canceladoEm
                        ? `${rotuloDoMovimento(m.tipo)} cancelada por ${m.canceladoPor}`
                        : (m.observacao ?? "")}
                      <span className="ml-1 font-mono">
                        {new Date(m.criadoEm).toLocaleTimeString("pt-BR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        · {m.operador}
                        {m.autorizadaPor ? ` · liberada por ${m.autorizadaPor}` : ""}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono tabular-nums",
                        m.tipo === "sangria" && !m.canceladoEm && "text-destructive",
                        m.canceladoEm && "line-through"
                      )}
                    >
                      {m.tipo === "sangria" ? "−" : "+"}
                      {moeda(m.valor)}
                    </span>
                    {/* O comprovante que acompanha o dinheiro. Vale para a
                        sangria (sai) e para o reforço (entra): nos dois casos
                        alguém carregou dinheiro de um lugar para outro. */}
                    {!m.canceladoEm ? <BotaoComprovante id={m.id} /> : null}
                    {!fechado && !m.canceladoEm ? (
                      <Form method="post" className="shrink-0">
                        <input type="hidden" name="intencao" value="apagar" />
                        <input type="hidden" name="dia" value={dia} />
                        <input type="hidden" name="id" value={m.id} />
                        <Button
                          type="submit"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Remover lançamento"
                          className="text-muted-foreground"
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </Form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">
                Nenhum lançamento de gaveta neste dia.
                {resumo.abertura === 0 && !fechado
                  ? " Comece pela abertura, com o troco que ficou na gaveta."
                  : ""}
              </p>
            )}

            <p className="mt-6 text-[11px] text-muted-foreground">
              Venda a venda em{" "}
              <Link to="/vendas" className="underline">
                Vendas
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}

function Linha({ rotulo, valor }: { rotulo: string; valor: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-muted-foreground">{rotulo}</dt>
      <dd className={cn("font-mono tabular-nums", valor < 0 && "text-destructive")}>
        {valor < 0 ? "− " : ""}
        {moeda(Math.abs(valor))}
      </dd>
    </div>
  )
}

function Cartao({
  rotulo,
  valor,
  destaque,
}: {
  rotulo: string
  valor: number
  destaque?: boolean
}) {
  return (
    <div className={cn("rounded-xl border border-border p-3", destaque && "bg-muted/40")}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono font-bold tabular-nums",
          destaque ? "text-lg" : "text-base"
        )}
      >
        {moeda(valor)}
      </div>
    </div>
  )
}

/** Imprime o comprovante de um lançamento da gaveta. */
function BotaoComprovante({ id }: { id: string }) {
  const [gerando, setGerando] = useState(false)

  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      disabled={gerando}
      aria-label="Imprimir comprovante"
      title="Imprimir o comprovante para acompanhar o dinheiro"
      className="shrink-0 text-muted-foreground"
      onClick={async () => {
        setGerando(true)
        await imprimirDocumento(`/sangria/${id}/comprovante`)
        setGerando(false)
      }}
    >
      {gerando ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Printer className="size-4" aria-hidden />
      )}
    </Button>
  )
}

function BotaoPapel({ id }: { id: string }) {
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={gerando}
        className="ml-auto rounded-lg"
        onClick={async () => {
          setGerando(true)
          setErro(await imprimirDocumento(`/fechamento/${id}/papel`))
          setGerando(false)
        }}
      >
        {gerando ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Printer className="size-4" aria-hidden />
        )}
        Imprimir
      </Button>
      {erro ? (
        <span role="alert" className="text-xs text-destructive">
          {erro}
        </span>
      ) : null}
    </>
  )
}
