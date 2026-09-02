import { useEffect, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { AlertTriangle, Check, FileText } from "lucide-react"

import type { Route } from "./+types/admin.fiscal"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { formatarCpfCnpj } from "~/lib/documento"
import {
  CFOP_VENDA_INTERESTADUAL,
  CFOP_VENDA_INTERNA,
  CSOSN_PADRAO,
  pendenciasDoEmitente,
  REGIMES,
} from "~/lib/fiscal"
import {
  contarExcecoesFiscais,
  lerEmitente,
  listarEmitentes,
  salvarEmitente,
} from "~/lib/fiscal.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Fiscal — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  // A guarda de gerente é do layout de /admin, pela declaração em SECOES_ADMIN.
  await exigirUsuario(request)

  const [lojas, excecoes] = await Promise.all([listarEmitentes(), contarExcecoesFiscais()])

  return {
    excecoes,
    lojas: lojas.map((loja) => ({
      codigo: loja.codigo,
      nome: loja.nome,
      razaoSocial: loja.razaoSocial,
      cnpj: loja.cnpj,
      cidade: loja.cidade,
      uf: loja.uf,
      emiteNotaFiscal: loja.emiteNotaFiscal,
      inscricaoEstadual: loja.inscricaoEstadual ?? "",
      regimeTributario: loja.regimeTributario,
      serieNfce: loja.serieNfce,
      serieNfe: loja.serieNfe,
      cfopVendaInterna: loja.cfopVendaInterna ?? "",
      cfopVendaInterestadual: loja.cfopVendaInterestadual ?? "",
      csosnPadrao: loja.csosnPadrao ?? "",
      pendencias: pendenciasDoEmitente(loja),
    })),
  }
}

export async function action({ request }: Route.ActionArgs) {
  await exigirUsuario(request)

  const form = await request.formData()
  const codigo = String(form.get("codigo") ?? "")

  const resultado = await salvarEmitente(codigo, lerEmitente(form))
  return resultado.ok
    ? { ok: true as const, mensagem: resultado.mensagem }
    : data({ ok: false as const, erro: resultado.erro }, { status: 400 })
}

type Loja = Awaited<ReturnType<typeof loader>>["lojas"][number]

export default function AdminFiscal({ loaderData }: Route.ComponentProps) {
  const { lojas, excecoes } = loaderData

  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 6000)
    return () => clearTimeout(id)
  }, [aviso])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Fiscal</h1>
        <span className="text-xs text-muted-foreground">
          O que a nota precisa saber de cada loja. Certificado, CSC e token ficam no
          painel da Focus NFe — aqui é só o cadastro.
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-4">
          {lojas.map((loja) => (
            <Emitente key={loja.codigo} loja={loja} aoSalvar={setAviso} />
          ))}
        </div>

        <div className="mt-6 rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Como está o catálogo</p>
          <p className="mt-1">
            {excecoes.semNcm === 0
              ? "Todos os produtos ativos têm NCM — é o campo que a nota exige em cada item."
              : `${excecoes.semNcm} produto(s) ativo(s) sem NCM: a nota que incluir um deles é rejeitada.`}{" "}
            {excecoes.comCsosn === 0
              ? "Nenhum produto tem tributação própria cadastrada, então todos saem no padrão da loja — o que só está certo se nada tiver substituição tributária."
              : `${excecoes.comCsosn} produto(s) com tributação própria, ${excecoes.comCest} com CEST.`}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs">
        <span className="text-muted-foreground">
          CFOP, CSOSN e substituição tributária são definição do contador — o
          sistema só repete o que estiver aqui
        </span>
        {aviso ? (
          <span
            className={cn(
              "font-medium",
              aviso.tipo === "erro" ? "text-destructive" : "text-foreground"
            )}
            role="status"
          >
            {aviso.texto}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Emitente({
  loja,
  aoSalvar,
}: {
  loja: Loja
  aoSalvar: (aviso: { texto: string; tipo: "erro" | "sucesso" }) => void
}) {
  const [form, setForm] = useState({
    emiteNotaFiscal: loja.emiteNotaFiscal,
    inscricaoEstadual: loja.inscricaoEstadual,
    regimeTributario: loja.regimeTributario ? String(loja.regimeTributario) : "",
    serieNfce: loja.serieNfce ? String(loja.serieNfce) : "",
    serieNfe: loja.serieNfe ? String(loja.serieNfe) : "",
    cfopVendaInterna: loja.cfopVendaInterna,
    cfopVendaInterestadual: loja.cfopVendaInterestadual,
    csosnPadrao: loja.csosnPadrao,
  })

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"
  const ultimaResposta = useRef<unknown>(null)

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data

    aoSalvar(
      fetcher.data.ok
        ? { texto: fetcher.data.mensagem, tipo: "sucesso" }
        : { texto: `${loja.codigo}: ${fetcher.data.erro}`, tipo: "erro" }
    )
  }, [fetcher.state, fetcher.data, aoSalvar, loja.codigo])

  function alterar(campos: Partial<typeof form>) {
    setForm((atual) => ({ ...atual, ...campos }))
  }

  function salvar() {
    if (gravando) return
    fetcher.submit(
      {
        ...form,
        codigo: loja.codigo,
        emiteNotaFiscal: form.emiteNotaFiscal ? "sim" : "nao",
      },
      { method: "post" }
    )
  }

  const impedimentos = loja.pendencias

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card",
        form.emiteNotaFiscal && "border-primary/40"
      )}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{loja.nome}</h2>
        <Badge variant="outline" className="font-mono text-[10px]">
          {loja.codigo}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatarCpfCnpj(loja.cnpj)}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {loja.razaoSocial ?? "sem razão social"}
        </span>
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={form.emiteNotaFiscal}
            onChange={(e) => alterar({ emiteNotaFiscal: e.target.checked })}
            className="size-4 accent-primary"
          />
          Emite nota fiscal
        </label>
      </div>

      {/* Vermelho só na loja que emite: numa loja que ainda está no cupom não
          fiscal, o mesmo texto seria um alarme sobre algo que não está ligado. */}
      {impedimentos.length > 0 ? (
        <p
          className={cn(
            "flex items-center gap-2 border-b border-border px-4 py-2 text-xs",
            form.emiteNotaFiscal
              ? "bg-destructive/5 text-destructive"
              : "text-muted-foreground"
          )}
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {form.emiteNotaFiscal
            ? `Falta ${impedimentos.join(", ")} — sem isso a SEFAZ recusa a nota.`
            : `Para emitir, falta ${impedimentos.join(", ")}.`}
        </p>
      ) : null}

      <div className="grid grid-cols-12 gap-3 px-4 py-3">
        <Campo
          rotulo="Inscrição estadual"
          valor={form.inscricaoEstadual}
          onChange={(v) => alterar({ inscricaoEstadual: v.replace(/\D/g, "") })}
          className="col-span-3"
        />
        <div className="col-span-4">
          <Rotulo>Regime tributário</Rotulo>
          <select
            value={form.regimeTributario}
            onChange={(e) => alterar({ regimeTributario: e.target.value })}
            className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
          >
            <option value="">—</option>
            {REGIMES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.rotulo}
              </option>
            ))}
          </select>
        </div>
        <Campo
          rotulo="Série NFC-e"
          valor={form.serieNfce}
          onChange={(v) => alterar({ serieNfce: v.replace(/\D/g, "") })}
          className="col-span-2"
        />
        <Campo
          rotulo="Série NF-e"
          valor={form.serieNfe}
          onChange={(v) => alterar({ serieNfe: v.replace(/\D/g, "") })}
          className="col-span-2"
        />

        <Campo
          rotulo="CFOP no DF"
          valor={form.cfopVendaInterna}
          onChange={(v) => alterar({ cfopVendaInterna: v.replace(/\D/g, "").slice(0, 4) })}
          placeholder={CFOP_VENDA_INTERNA}
          className="col-span-2"
        />
        <Campo
          rotulo="CFOP fora do DF"
          valor={form.cfopVendaInterestadual}
          onChange={(v) => alterar({ cfopVendaInterestadual: v.replace(/\D/g, "").slice(0, 4) })}
          placeholder={CFOP_VENDA_INTERESTADUAL}
          className="col-span-2"
        />
        <Campo
          rotulo="CSOSN padrão"
          valor={form.csosnPadrao}
          onChange={(v) => alterar({ csosnPadrao: v.replace(/\D/g, "").slice(0, 3) })}
          placeholder={CSOSN_PADRAO}
          className="col-span-2"
        />

        <div className="col-span-6 flex items-end justify-end">
          <Button type="button" size="sm" disabled={gravando} onClick={salvar} className="rounded-lg">
            <Check className="size-4" />
            {gravando ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </div>
    </section>
  )
}

function Rotulo({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </label>
  )
}

function Campo({
  rotulo,
  valor,
  onChange,
  placeholder,
  className,
}: {
  rotulo: string
  valor: string
  onChange: (valor: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={className}>
      <Rotulo>{rotulo}</Rotulo>
      <Input
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        className="h-9 rounded-lg font-mono tabular-nums"
      />
    </div>
  )
}
