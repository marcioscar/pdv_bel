import { useState } from "react"
import { useFetcher, useSearchParams } from "react-router"
import { FileSearch, Loader2, RefreshCw } from "lucide-react"

import type { Route } from "./+types/admin.notas-de-entrada"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { ESTILO_CAMPO } from "~/components/pdv/filtros"
import { listarLojas } from "~/lib/lojas.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import {
  buscarNotaPorChave,
  listarNotasDaLoja,
  sincronizarNotasDaLoja,
  situacaoSincronizacao,
  type ResultadoSincronizacao,
} from "~/lib/notas-fiscais.server"
import { resumoDoProcNFe, sefazConfigurado, type ResultadoConsultaChave } from "~/lib/sefaz.server"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Notas de entrada — BrasSaco" }]
}

/**
 * O catálogo de NF-e de fornecedor destinadas a cada loja, sincronizado direto
 * da SEFAZ (`distNSU`) — do mesmo jeito que o painel de manifestação que já
 * usávamos: escolhe a empresa, vê o que chegou, entra na que interessa.
 *
 * Ainda não dá entrada de estoque a partir daqui — isso exige decidir como
 * casar item da nota com produto do catálogo, o que é a próxima etapa. Por
 * ora, é o "o que existe para escolher".
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "buscarNotaFiscal")

  const url = new URL(request.url)
  const loja = url.searchParams.get("loja") ?? ""
  const notaId = url.searchParams.get("nota") ?? ""

  const lojas = await listarLojas()
  const configuradas: Record<string, boolean> = {}
  for (const l of lojas) configuradas[l.codigo] = await sefazConfigurado(l.codigo)

  const notas = loja ? await listarNotasDaLoja(loja) : []
  const sincronizacao = loja ? await situacaoSincronizacao(loja) : null

  const notaSelecionada = notaId ? (notas.find((n) => n.id === notaId) ?? null) : null
  const itensDaNota =
    notaSelecionada?.xml && notaSelecionada.situacaoXml === "completa"
      ? (resumoDoProcNFe(notaSelecionada.xml)?.itens ?? [])
      : null

  return { lojas, configuradas, loja, notas, sincronizacao, notaSelecionada, itensDaNota }
}

type RespostaAction =
  | ({ intencao: "sincronizar" } & ResultadoSincronizacao)
  | ({ intencao: "buscarChave" } & ResultadoConsultaChave)

export async function action({ request }: Route.ActionArgs): Promise<RespostaAction> {
  await exigirGerente(request, "buscarNotaFiscal")

  const form = await request.formData()
  const loja = String(form.get("loja") ?? "")
  const intencao = String(form.get("intencao") ?? "")

  if (!loja) return { intencao: "sincronizar", ok: false, erro: "Escolha a loja/empresa", novas: 0 }

  if (intencao === "buscarChave") {
    const chave = String(form.get("chave") ?? "")
    const resultado = await buscarNotaPorChave(loja, chave)
    return { intencao: "buscarChave", ...resultado }
  }

  const resultado = await sincronizarNotasDaLoja(loja)
  return { intencao: "sincronizar", ...resultado }
}

export default function AdminNotasDeEntrada({ loaderData }: Route.ComponentProps) {
  const { lojas, configuradas, loja, notas, sincronizacao, notaSelecionada, itensDaNota } = loaderData
  const [, setSearchParams] = useSearchParams()
  const sincFetcher = useFetcher<RespostaAction>()
  const chaveFetcher = useFetcher<RespostaAction>()
  const [chave, setChave] = useState("")
  const [mostrarBuscaManual, setMostrarBuscaManual] = useState(false)

  const sincronizando = sincFetcher.state !== "idle"
  const buscandoChave = chaveFetcher.state !== "idle"

  function escolherLoja(novaLoja: string) {
    setSearchParams(novaLoja ? { loja: novaLoja } : {})
  }

  function escolherNota(id: string) {
    setSearchParams(loja ? { loja, nota: id } : {})
  }

  const faltam =
    sincronizacao && sincronizacao.ultNsu !== sincronizacao.maxNsu
      ? Number(sincronizacao.maxNsu) - Number(sincronizacao.ultNsu)
      : 0

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FileSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Notas de entrada</h1>
        <span className="text-xs text-muted-foreground">
          NF-e de fornecedor sincronizadas da SEFAZ, por empresa
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Empresa/loja</span>
          <select
            value={loja}
            onChange={(e) => escolherLoja(e.target.value)}
            className={cn(ESTILO_CAMPO, "w-48")}
          >
            <option value="">Escolher…</option>
            {lojas.map((l) => (
              <option key={l.codigo} value={l.codigo} disabled={!configuradas[l.codigo]}>
                {l.nome}
                {configuradas[l.codigo] ? "" : " (sem certificado)"}
              </option>
            ))}
          </select>
        </label>

        {loja ? (
          <sincFetcher.Form method="post">
            <input type="hidden" name="loja" value={loja} />
            <input type="hidden" name="intencao" value="sincronizar" />
            <Button type="submit" variant="outline" disabled={sincronizando}>
              {sincronizando ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sincronizar
            </Button>
          </sincFetcher.Form>
        ) : null}

        {loja ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => setMostrarBuscaManual((v) => !v)}
          >
            {mostrarBuscaManual ? "esconder busca por chave" : "buscar por chave manualmente"}
          </button>
        ) : null}
      </div>

      {loja && sincronizacao ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Sincronizado até NSU {Number(sincronizacao.ultNsu)}
          {faltam > 0 ? ` — faltam ~${faltam} documentos (clique em Sincronizar de novo)` : " — em dia"}
        </p>
      ) : null}

      {sincFetcher.data?.intencao === "sincronizar" ? (
        <p className={cn("mt-1 text-xs", sincFetcher.data.ok ? "text-muted-foreground" : "text-destructive")}>
          {sincFetcher.data.ok
            ? `${sincFetcher.data.novas} nota(s) nova(s) — ${sincFetcher.data.completo ? "sincronização em dia" : "ainda falta mais, clique de novo"}`
            : sincFetcher.data.erro}
        </p>
      ) : null}

      {mostrarBuscaManual && loja ? (
        <chaveFetcher.Form method="post" className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border p-3">
          <input type="hidden" name="loja" value={loja} />
          <input type="hidden" name="intencao" value="buscarChave" />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Chave de acesso (44 dígitos)</span>
            <Input
              name="chave"
              value={chave}
              onChange={(e) => setChave(e.target.value.replace(/\D/g, "").slice(0, 44))}
              className="w-96 font-mono"
              placeholder="00000000000000000000000000000000000000000000"
            />
          </label>
          <Button type="submit" disabled={buscandoChave || chave.length !== 44}>
            {buscandoChave ? <Loader2 className="size-4 animate-spin" /> : null}
            Buscar
          </Button>
          {chaveFetcher.data?.intencao === "buscarChave" ? (
            <span className={cn("text-xs", chaveFetcher.data.ok ? "text-muted-foreground" : "text-destructive")}>
              {chaveFetcher.data.ok
                ? chaveFetcher.data.documento
                  ? "Encontrada e adicionada à lista abaixo"
                  : `Nada encontrado (${chaveFetcher.data.xMotivo})`
                : chaveFetcher.data.erro}
            </span>
          ) : null}
        </chaveFetcher.Form>
      ) : null}

      {loja ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                  <th className="px-2 py-1.5">Emitente</th>
                  <th className="px-2 py-1.5">Nº</th>
                  <th className="px-2 py-1.5">Emissão</th>
                  <th className="px-2 py-1.5 text-right">Valor</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {notas.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-4 text-center text-muted-foreground">
                      Nenhuma nota sincronizada ainda.
                    </td>
                  </tr>
                ) : (
                  notas.map((n) => (
                    <tr
                      key={n.id}
                      onClick={() => escolherNota(n.id)}
                      className={cn(
                        "cursor-pointer border-b last:border-0 hover:bg-muted/40",
                        notaSelecionada?.id === n.id && "bg-muted/60"
                      )}
                    >
                      <td className="px-2 py-1.5">{n.emitenteNome}</td>
                      <td className="px-2 py-1.5">
                        {n.numero ?? "—"}
                        {n.serie ? `/${n.serie}` : ""}
                      </td>
                      <td className="px-2 py-1.5">
                        {n.dataEmissao ? new Date(n.dataEmissao).toLocaleDateString("pt-BR") : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {n.valorTotal != null ? moeda(n.valorTotal) : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        <Badge variant={n.situacaoXml === "completa" ? "default" : "secondary"}>
                          {n.situacaoXml === "completa" ? "itens" : "resumo"}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border p-4">
            {!notaSelecionada ? (
              <p className="text-sm text-muted-foreground">Escolha uma nota na lista para ver os detalhes.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Emitente</dt>
                  <dd>
                    {notaSelecionada.emitenteNome} ({notaSelecionada.emitenteCnpj})
                  </dd>
                  <dt className="text-muted-foreground">Nº / série</dt>
                  <dd>
                    {notaSelecionada.numero ?? "—"} / {notaSelecionada.serie ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Emissão</dt>
                  <dd>
                    {notaSelecionada.dataEmissao
                      ? new Date(notaSelecionada.dataEmissao).toLocaleString("pt-BR")
                      : "—"}
                  </dd>
                  <dt className="text-muted-foreground">Valor total</dt>
                  <dd>{notaSelecionada.valorTotal != null ? moeda(notaSelecionada.valorTotal) : "—"}</dd>
                </dl>

                {notaSelecionada.situacaoXml !== "completa" ? (
                  <p className="text-amber-600 dark:text-amber-500">
                    Só o resumo está disponível — a SEFAZ já não distribui o XML completo
                    com os itens para esta nota (mais antiga).
                  </p>
                ) : itensDaNota && itensDaNota.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1 pr-2">Código</th>
                        <th className="py-1 pr-2">Descrição</th>
                        <th className="py-1 pr-2 text-right">Qtd</th>
                        <th className="py-1 pr-2 text-right">Unit.</th>
                        <th className="py-1 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itensDaNota.map((item, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1 pr-2">{item.codigo}</td>
                          <td className="py-1 pr-2">{item.descricao}</td>
                          <td className="py-1 pr-2 text-right">
                            {item.quantidade != null
                              ? `${formatarQuantidade(item.quantidade)} ${item.unidade ?? ""}`
                              : "—"}
                          </td>
                          <td className="py-1 pr-2 text-right">
                            {item.valorUnitario != null ? moeda(item.valorUnitario) : "—"}
                          </td>
                          <td className="py-1 text-right">
                            {item.valorTotal != null ? moeda(item.valorTotal) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
