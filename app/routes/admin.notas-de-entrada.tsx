import { useMemo, useState } from "react"
import { Link, useFetcher, useNavigate, useNavigation, useSearchParams } from "react-router"
import { FileSearch, Loader2, RefreshCw, Search } from "lucide-react"

import type { Route } from "./+types/admin.notas-de-entrada"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Atalho, Campo, ESTILO_CAMPO, Pagina } from "~/components/pdv/filtros"
import { diaAtras, diaDeHoje } from "~/lib/dia"
import { formatarCpfCnpj } from "~/lib/documento"
import { listarLojas } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import {
  PERIODO_TODO,
  SITUACOES_NOTA,
  rotuloDaSituacaoNota,
  type FiltroNotas,
} from "~/lib/notas-fiscais"
import {
  buscarNotaPorChave,
  consultarNotas,
  fornecedoresComNota,
  lerFiltroNotas,
  sincronizarNotasDaLoja,
  situacaoSincronizacao,
  type ResultadoSincronizacao,
} from "~/lib/notas-fiscais.server"
import { sefazConfigurado, type ResultadoConsultaChave } from "~/lib/sefaz.server"
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
  const filtroDaUrl = lerFiltroNotas(url)

  const lojas = await listarLojas()
  const configuradas: Record<string, boolean> = {}
  for (const l of lojas) configuradas[l.codigo] = await sefazConfigurado(l.codigo)

  // Sem loja na URL, abre na primeira que tem certificado em vez de numa tela
  // vazia — quem chega por um link de fornecedor (vindo do pedido de compra)
  // não tem como saber qual empresa escolher, e "Escolher…" viraria beco sem
  // saída. O seletor continua ali para trocar.
  const loja = filtroDaUrl.loja || (lojas.find((l) => configuradas[l.codigo])?.codigo ?? "")
  const filtro = { ...filtroDaUrl, loja }

  const consulta = loja
    ? await consultarNotas(filtro)
    : { notas: [], total: 0, foraDoPeriodo: 0, paginas: 1, resumo: null }
  const sincronizacao = loja ? await situacaoSincronizacao(loja) : null
  const fornecedores = loja ? await fornecedoresComNota(loja) : []

  return {
    lojas,
    configuradas,
    filtro,
    loja,
    fornecedores,
    sincronizacao,
    ...consulta,
  }
}

type RespostaAction =
  | ({ intencao: "sincronizar" } & ResultadoSincronizacao)
  | ({ intencao: "buscarChave" } & ResultadoConsultaChave)

export async function action({ request }: Route.ActionArgs): Promise<RespostaAction> {
  await exigirGerente(request, "buscarNotaFiscal")

  const form = await request.formData()
  const intencao = String(form.get("intencao") ?? "")

  const loja = String(form.get("loja") ?? "")
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
  const {
    lojas,
    configuradas,
    filtro,
    loja,
    fornecedores,
    notas,
    total,
    foraDoPeriodo,
    paginas,
    resumo,
    sincronizacao,
  } = loaderData

  const [params, setParams] = useSearchParams()
  const navegar = useNavigate()
  const navegacao = useNavigation()
  const consultando = navegacao.state === "loading"
  const sincFetcher = useFetcher<RespostaAction>()
  const chaveFetcher = useFetcher<RespostaAction>()
  const [chave, setChave] = useState("")
  const [mostrarBuscaManual, setMostrarBuscaManual] = useState(false)

  const sincronizando = sincFetcher.state !== "idle"
  const buscandoChave = chaveFetcher.state !== "idle"

  /**
   * Muda um pedaço do filtro e volta para a primeira página.
   *
   * Preservar a página ao trocar o fornecedor levaria para a página 4 de uma
   * consulta que talvez só tenha uma — tela vazia que parece defeito.
   */
  function mudarFiltro(mudancas: Partial<Record<keyof FiltroNotas, string>>) {
    const proximos = new URLSearchParams(params)
    for (const [chave, valor] of Object.entries(mudancas)) {
      if (valor) proximos.set(chave, valor)
      else proximos.delete(chave)
    }
    proximos.delete("pagina")
    setParams(proximos)
  }

  function escolherLoja(novaLoja: string) {
    setParams(novaLoja ? { loja: novaLoja } : {})
  }

  const faltam = sincronizacao
    ? Math.max(0, Number(sincronizacao.maxNsu) - Number(sincronizacao.ultNsu))
    : 0

  // A SEFAZ bloqueia o CNPJ por uma hora quando se pergunta sem ter novidade.
  // Desabilitar o botão é mais honesto que deixar clicar e levar a recusa.
  const esperarAte = sincronizacao?.proximaConsultaEm
    ? new Date(sincronizacao.proximaConsultaEm)
    : null
  const minutosDeEspera = esperarAte
    ? Math.max(0, Math.ceil((esperarAte.getTime() - Date.now()) / 60_000))
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
            <Button
              type="submit"
              variant="outline"
              disabled={sincronizando || minutosDeEspera > 0}
              title={
                minutosDeEspera > 0
                  ? `A SEFAZ pede uma hora de intervalo quando não há novidade — libera em ${minutosDeEspera} min`
                  : undefined
              }
            >
              {sincronizando ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {minutosDeEspera > 0 ? `Sincronizar (${minutosDeEspera} min)` : "Sincronizar"}
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
          {minutosDeEspera > 0
            ? ` · a SEFAZ pede 1h de intervalo sem novidade; libera em ${minutosDeEspera} min`
            : ""}
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
        <>
          <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border p-3">
            <Campo rotulo="Fornecedor">
              <BuscaDeFornecedor
                fornecedores={fornecedores}
                valor={filtro.fornecedor}
                onEscolher={(fornecedor) => mudarFiltro({ fornecedor })}
              />
            </Campo>

            <Campo rotulo="Nº da nota">
              <Input
                defaultValue={filtro.numero}
                onBlur={(e) => mudarFiltro({ numero: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") mudarFiltro({ numero: e.currentTarget.value })
                }}
                className="w-28"
              />
            </Campo>

            <Campo rotulo="De">
              <input
                type="date"
                value={filtro.de === PERIODO_TODO.de ? "" : filtro.de}
                onChange={(e) => mudarFiltro({ de: e.target.value })}
                className={ESTILO_CAMPO}
              />
            </Campo>
            <Campo rotulo="Até">
              <input
                type="date"
                value={filtro.ate === PERIODO_TODO.ate ? "" : filtro.ate}
                onChange={(e) => mudarFiltro({ ate: e.target.value })}
                className={ESTILO_CAMPO}
              />
            </Campo>

            <Campo rotulo="Situação">
              <select
                value={filtro.situacao}
                onChange={(e) => mudarFiltro({ situacao: e.target.value })}
                className={cn(ESTILO_CAMPO, "w-36")}
              >
                {SITUACOES_NOTA.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.rotulo}
                  </option>
                ))}
              </select>
            </Campo>

            <div className="flex gap-1.5">
              <Atalho rotulo="30 dias" onClick={() => mudarFiltro({ de: diaAtras(30), ate: diaDeHoje() })} />
              <Atalho rotulo="90 dias" onClick={() => mudarFiltro({ de: diaAtras(90), ate: diaDeHoje() })} />
              <Atalho
                rotulo="Limpar"
                onClick={() =>
                  mudarFiltro({ fornecedor: "", numero: "", de: "", ate: "", situacao: "" })
                }
              />
            </div>

            {consultando ? <Search className="size-4 animate-pulse text-muted-foreground" /> : null}
          </div>

          {resumo ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                <strong className="text-foreground">{total}</strong>{" "}
                {total === 1 ? "nota" : "notas"} · {moeda(resumo.valor)}
              </span>
              <span>
                disponíveis: {resumo.disponivelQuantidade} · {moeda(resumo.disponivel)}
              </span>
              <span>
                recebidas: {resumo.recebidaQuantidade} · {moeda(resumo.recebida)}
              </span>
              {foraDoPeriodo > 0 ? (
                <span className="text-amber-600 dark:text-amber-500">
                  nada no período — mas há {foraDoPeriodo} fora dele
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {loja ? (
        <div className="mt-4">
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
                      {filtro.fornecedor || filtro.numero || filtro.situacao !== "todas"
                        ? "Nenhuma nota com esse filtro."
                        : "Nenhuma nota sincronizada ainda."}
                    </td>
                  </tr>
                ) : (
                  notas.map((n) => (
                    <tr
                      key={n.id}
                      onClick={() => navegar(`/admin/notas-de-entrada/${n.id}`)}
                      className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-2 py-1.5">
                        {/* Âncora de verdade dentro da linha clicável: quem quiser
                            abrir em outra aba ou navegar pelo teclado consegue. */}
                        <Link to={`/admin/notas-de-entrada/${n.id}`} className="hover:underline">
                          {n.emitenteNome}
                        </Link>
                      </td>
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
                        <div className="flex items-center gap-1">
                          <Badge variant={n.situacaoXml === "completa" ? "default" : "secondary"}>
                            {n.situacaoXml === "completa" ? "itens" : "resumo"}
                          </Badge>
                          {n.situacao !== "disponivel" ? (
                            <Badge variant="outline">{rotuloDaSituacaoNota(n.situacao)}</Badge>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {paginas > 1 ? (
              <div className="flex items-center gap-3 border-t px-2 py-2 text-xs text-muted-foreground">
                <Pagina params={params} para={filtro.pagina - 1} ativa={filtro.pagina > 1}>
                  ‹ Anteriores
                </Pagina>
                <span className="font-mono tabular-nums">
                  página {filtro.pagina} de {paginas}
                </span>
                <Pagina params={params} para={filtro.pagina + 1} ativa={filtro.pagina < paginas}>
                  Próximas ›
                </Pagina>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Escolhe o fornecedor digitando — o mesmo padrão da busca de produto na ficha
 * de estoque: campo de texto com a lista suspensa filtrando enquanto se digita.
 *
 * Um `<select>` puro não servia: são dezenas de fornecedores com razão social
 * longa e parecida ("COMERCIAL … LTDA"), e achar o certo numa lista rolante é
 * pior que digitar três letras. Procura por nome e por CNPJ no mesmo campo,
 * porque quem procura tem um ou outro na mão — o que dispensa o segundo campo
 * que existia aqui antes.
 */
function BuscaDeFornecedor({
  fornecedores,
  valor,
  onEscolher,
}: {
  fornecedores: { cnpj: string; nome: string; notas: number }[]
  valor: string
  onEscolher: (fornecedor: string) => void
}) {
  const [termo, setTermo] = useState(valor)
  const [aberto, setAberto] = useState(false)

  const achados = useMemo(() => {
    const busca = termo.trim().toLowerCase()
    if (!busca) return fornecedores.slice(0, 12)
    const digitos = busca.replace(/\D/g, "")
    return fornecedores
      .filter(
        (f) =>
          f.nome.toLowerCase().includes(busca) ||
          (digitos.length >= 3 && f.cnpj.includes(digitos))
      )
      .slice(0, 12)
  }, [fornecedores, termo])

  function escolher(nome: string) {
    setTermo(nome)
    setAberto(false)
    onEscolher(nome)
  }

  return (
    <div className="relative w-72">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={termo}
        onChange={(e) => {
          setTermo(e.target.value)
          setAberto(true)
        }}
        onFocus={() => setAberto(true)}
        // `onBlur` com atraso: o clique num item da lista dispara o blur antes
        // do próprio clique, e fechar na hora engoliria a escolha.
        onBlur={() => setTimeout(() => setAberto(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter") escolher(e.currentTarget.value)
          if (e.key === "Escape") setAberto(false)
        }}
        placeholder="Todos — nome ou CNPJ"
        type="search"
        autoComplete="off"
        className="pl-8"
      />

      {aberto ? (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto divide-y divide-border rounded-lg border border-border bg-card shadow-lg">
          <li>
            <button
              type="button"
              onClick={() => escolher("")}
              className="flex w-full items-center px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50"
            >
              Todos os fornecedores
            </button>
          </li>
          {achados.map((f) => (
            <li key={f.cnpj}>
              <button
                type="button"
                onClick={() => escolher(f.nome)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 truncate">{f.nome}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {formatarCpfCnpj(f.cnpj)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{f.notas}</span>
              </button>
            </li>
          ))}
          {achados.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">Nenhum fornecedor com esse termo.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
