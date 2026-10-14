import { useState } from "react"
import { data, useFetcher, useSearchParams } from "react-router"
import { Download, FileArchive, Loader2, Send } from "lucide-react"

import type { Route } from "./+types/admin.contador"
import { Badge } from "~/components/ui/badge"
import { Button, buttonVariants } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { Input } from "~/components/ui/input"
import {
  enviarAoContador,
  enviosRecentes,
  mesAnterior,
  mesValido,
  notasDoMes,
  resumir,
} from "~/lib/contador.server"
import { emailConfigurado } from "~/lib/email.server"
import { db } from "~/lib/db.server"
import { moeda } from "~/lib/moeda"
import { exigirGerente } from "~/lib/sessao.server"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Envio ao contador — BrasSaco" }]
}

/**
 * O fechamento fiscal do mês: os XMLs das notas de cada loja (cada uma é um
 * CNPJ), em ZIP, para a contadora. Ver contador.server para o que entra.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "enviarAoContador")
  const url = new URL(request.url)
  const pedido = url.searchParams.get("mes") ?? ""
  const mes = mesValido(pedido) ? pedido : mesAnterior()
  const comCanceladas = url.searchParams.get("canceladas") !== "0"

  // Só as lojas que emitem nota: as outras não têm o que mandar.
  const lojas = await db.loja.findMany({
    where: { codigo: { in: eu.lojasPermitidas }, emiteNotaFiscal: true },
    orderBy: { ordem: "asc" },
    select: { codigo: true, nome: true, razaoSocial: true, cnpj: true },
  })
  const porLoja = await Promise.all(
    lojas.map(async (l) => ({
      codigo: l.codigo,
      nome: l.razaoSocial ?? l.nome,
      cnpj: l.cnpj,
      resumo: resumir(await notasDoMes(l.codigo, mes, comCanceladas)),
    }))
  )
  const envios = await enviosRecentes(lojas.map((l) => l.codigo))

  return {
    mes,
    comCanceladas,
    porLoja,
    envios: envios.map((e) => ({ ...e, enviadoEm: e.enviadoEm.toISOString() })),
    // O e-mail do último envio: digita-se uma vez só.
    ultimoPara: envios[0]?.para ?? "",
    podeEnviar: emailConfigurado(),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirGerente(request, "enviarAoContador")
  const form = await request.formData()
  const loja = String(form.get("loja") ?? "")
  if (!eu.lojasPermitidas.includes(loja)) {
    return data({ ok: false as const, erro: "Loja não permitida" }, { status: 403 })
  }
  const r = await enviarAoContador({
    loja,
    mes: String(form.get("mes") ?? ""),
    para: String(form.get("para") ?? ""),
    comCanceladas: form.get("canceladas") !== "0",
    quem: eu.nome,
  })
  return r.ok ? r : data(r, { status: 400 })
}

const rotulo = (modelo: string) => (modelo === "nfe" ? "NF-e" : "NFC-e")
const nomeDoMes = (mes: string) => {
  const [ano, m] = mes.split("-").map(Number)
  return new Date(Date.UTC(ano, m - 1, 15)).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

/** Os últimos 24 meses até o atual, mais o escolhido se for mais antigo. */
function ultimosMeses(escolhido: string) {
  const hoje = new Date()
  const meses: string[] = []
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth() - i, 1))
    meses.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  if (!meses.includes(escolhido)) meses.push(escolhido)
  return meses
}

export default function Contador({ loaderData }: Route.ComponentProps) {
  const { mes, comCanceladas, porLoja, envios, ultimoPara, podeEnviar } = loaderData
  const [, setParams] = useSearchParams()
  const [para, setPara] = useState(ultimoPara)

  function mudar(proximo: { mes?: string; canceladas?: boolean }) {
    const params = new URLSearchParams()
    params.set("mes", proximo.mes ?? mes)
    if (!(proximo.canceladas ?? comCanceladas)) params.set("canceladas", "0")
    setParams(params)
  }

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center gap-3">
        <FileArchive className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Envio ao contador</h1>
        <span className="text-xs text-muted-foreground">
          os XMLs das notas de saída do mês, uma loja (CNPJ) por envio
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Mês
          {/*
            Lista, e não <input type="month">: o Safari não tem o seletor de mês
            e mostra um campo de texto, que mandava o mês pela metade a cada
            tecla — e a tela voltava para o mês anterior.
          */}
          <select
            value={mes}
            onChange={(e) => mudar({ mes: e.target.value })}
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm capitalize"
          >
            {ultimosMeses(mes).map((m) => (
              <option key={m} value={m}>
                {nomeDoMes(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={comCanceladas}
            onChange={(e) => mudar({ canceladas: e.target.checked })}
            className="size-4"
          />
          Incluir canceladas
          <span className="text-xs text-muted-foreground">(vão marcadas, fora do total)</span>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          E-mail da contadora
          <Input
            type="email"
            value={para}
            onChange={(e) => setPara(e.target.value)}
            placeholder="contadora@escritorio.com.br"
            className="w-72"
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Vão só notas autorizadas pela SEFAZ, em produção — recusada, com erro, processando ou de
        teste nunca entram. O e-mail sai de brassaco@brassaco.com.br com o ZIP e os totais.
      </p>
      {!podeEnviar ? (
        <p className="mt-2 text-xs font-medium text-destructive">
          O e-mail não está configurado no servidor (SMTP) — dá para baixar o ZIP, mas não enviar.
        </p>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {porLoja.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma loja que emite nota fiscal.</p>
        ) : (
          porLoja.map((loja) => (
            <CartaoDaLoja
              key={loja.codigo}
              loja={loja}
              mes={mes}
              comCanceladas={comCanceladas}
              para={para}
              podeEnviar={podeEnviar}
              jaEnviado={envios.find((e) => e.loja === loja.codigo && e.mes === mes) ?? null}
            />
          ))
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Últimos envios</h2>
        {envios.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nenhum envio ainda.</p>
        ) : (
          <table className="mt-2 w-full max-w-3xl text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2 font-semibold">Quando</th>
                <th className="px-2 py-2 font-semibold">Loja</th>
                <th className="px-2 py-2 font-semibold">Mês</th>
                <th className="px-2 py-2 font-semibold">Para</th>
                <th className="px-2 py-2 text-right font-semibold">Notas</th>
                <th className="px-2 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {envios.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 text-xs tabular-nums text-muted-foreground">
                    {new Date(e.enviadoEm).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · {e.enviadoPor}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">{e.loja}</td>
                  <td className="px-2 py-2 text-xs">{e.mes.split("-").reverse().join("/")}</td>
                  <td className="px-2 py-2 text-xs">{e.para}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{e.quantidade}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{moeda(e.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

type LojaDoMes = Route.ComponentProps["loaderData"]["porLoja"][number]
type Envio = Route.ComponentProps["loaderData"]["envios"][number]

function CartaoDaLoja({
  loja,
  mes,
  comCanceladas,
  para,
  podeEnviar,
  jaEnviado,
}: {
  loja: LojaDoMes
  mes: string
  comCanceladas: boolean
  para: string
  podeEnviar: boolean
  jaEnviado: Envio | null
}) {
  const fetcher = useFetcher<typeof action>()
  const enviando = fetcher.state !== "idle"
  const vazio = loja.resumo.quantidade === 0
  const linkZip = `/admin/contador/zip?loja=${loja.codigo}&mes=${mes}${comCanceladas ? "" : "&canceladas=0"}`

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-sm font-semibold">{loja.codigo}</span>
        <span className="text-sm">{loja.nome}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {loja.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}
        </span>
        {jaEnviado ? (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {nomeDoMes(mes)} já enviado em{" "}
            {new Date(jaEnviado.enviadoEm).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
          </Badge>
        ) : null}
      </div>

      {vazio ? (
        <p className="mt-3 text-sm text-muted-foreground">Nenhuma nota em {nomeDoMes(mes)}.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <tbody className="divide-y divide-border">
            {loja.resumo.porModelo.map((m) => (
              <tr key={m.modelo}>
                <td className="py-1.5 font-medium">{rotulo(m.modelo)}</td>
                <td className="py-1.5 text-muted-foreground">
                  {m.autorizadas} autorizada{m.autorizadas === 1 ? "" : "s"}
                  {m.canceladas ? ` · ${m.canceladas} cancelada${m.canceladas === 1 ? "" : "s"}` : ""}
                </td>
                <td className="py-1.5 text-right tabular-nums">{moeda(m.totalAutorizadas)}</td>
              </tr>
            ))}
            <tr>
              <td className="py-1.5 font-semibold">Total</td>
              <td className="py-1.5 text-muted-foreground">
                {loja.resumo.quantidade} nota{loja.resumo.quantidade === 1 ? "" : "s"} no ZIP
              </td>
              <td className="py-1.5 text-right font-semibold tabular-nums">{moeda(loja.resumo.total)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Link, e não fetch: o navegador baixa o arquivo direto. */}
        <a
          href={vazio ? undefined : linkZip}
          aria-disabled={vazio}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            vazio && "pointer-events-none opacity-50"
          )}
        >
          <Download className="size-4" /> Baixar ZIP
        </a>
        <Button
          type="button"
          size="sm"
          disabled={vazio || enviando || !podeEnviar || !para.trim()}
          onClick={() =>
            fetcher.submit(
              { loja: loja.codigo, mes, para, canceladas: comCanceladas ? "1" : "0" },
              { method: "post" }
            )
          }
        >
          {enviando ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {enviando ? "Enviando…" : jaEnviado ? "Reenviar para a contadora" : "Enviar para a contadora"}
        </Button>
        {fetcher.data ? (
          fetcher.data.ok ? (
            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {fetcher.data.mensagem}
            </span>
          ) : (
            <span className="text-xs text-destructive">{fetcher.data.erro}</span>
          )
        ) : null}
      </div>
    </div>
  )
}
