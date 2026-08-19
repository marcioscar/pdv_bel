import { useEffect, useState } from "react"
import { Link, useNavigation, useSearchParams } from "react-router"
import { FileText, Loader2, Printer, Search, Wallet } from "lucide-react"

import type { Route } from "./+types/admin.contas-a-receber"
import { Atalho, Campo, ESTILO_CAMPO, Pagina } from "~/components/pdv/filtros"
import { Numero } from "~/components/pdv/numero"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  diaAdiante,
  diaAtras,
  diaDeHoje,
  diaEmTexto,
  inicioDoDia,
  PRIMEIRO_DIA,
} from "~/lib/dia"
import { imprimirDocumento } from "~/lib/impressao"
import { listarLojas } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import {
  PERIODO_TODO,
  SITUACOES_EM_ABERTO,
  SITUACOES_RECEBIDAS,
  SITUACOES_RECEBIVEIS,
  type FiltroRecebiveis,
} from "~/lib/recebiveis"
import {
  consultarRecebiveis,
  lerFiltroRecebiveis,
  type RecebivelConsultado,
} from "~/lib/recebiveis.server"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Contas a receber — BrasSaco" }]
}

/**
 * A carteira de boletos da rede, parcela a parcela.
 *
 * Vendas da rede mostra o que foi vendido; esta mostra o que ainda não entrou.
 * São a mesma cobrança vista por eixos diferentes — lá o tempo é a data da
 * venda, aqui é o vencimento — e por isso a mesma parcela cai em períodos
 * distintos nas duas telas. Quem cobra abre esta e lê de cima: a linha mais
 * atrasada é a primeira.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirGerente(request, "verContasAReceber")

  const filtro = lerFiltroRecebiveis(new URL(request.url), eu.lojasPermitidas)
  const [consulta, lojas] = await Promise.all([consultarRecebiveis(filtro), listarLojas()])

  return {
    filtro,
    // Só as lojas onde ele opera: o seletor não deve nem sugerir o que a consulta
    // recusaria.
    lojas: lojas.filter((loja) => eu.lojasPermitidas.includes(loja.codigo)),
    hoje: diaDeHoje(),
    ...consulta,
  }
}

export default function AdminContasAReceber({ loaderData }: Route.ComponentProps) {
  const { filtro, lojas, hoje, recebiveis, total, foraDoPeriodo, paginas, resumo } =
    loaderData

  const [params, setParams] = useSearchParams()
  const navegacao = useNavigation()
  const consultando = navegacao.state === "loading"

  // Como em vendas: os campos digitados vivem em estado porque os atalhos de
  // período os alteram, e o efeito os traz de volta ao que a URL diz depois de
  // cada navegação — inclusive a do botão "voltar" do navegador.
  const [campos, setCampos] = useState(filtro)
  useEffect(() => setCampos(filtro), [filtro])

  const [gerando, setGerando] = useState(false)
  const [erroDaFolha, setErroDaFolha] = useState<string | null>(null)

  /**
   * A folha de conferência sai com o MESMO recorte que está na tela — é a razão
   * de ela receber a query string inteira em vez de ter filtros próprios. Quem
   * quer os pagos põe Situação em "Recebidas" e imprime; a folha se intitula
   * sozinha a partir disso.
   */
  async function imprimir() {
    setGerando(true)
    setErroDaFolha(null)
    const problema = await imprimirDocumento(`/admin/contas-a-receber/impressao?${params}`)
    setGerando(false)
    if (problema) setErroDaFolha(problema)
  }

  function aplicar(mudanca: Partial<FiltroRecebiveis>) {
    const proximo = { ...campos, ...mudanca }
    setCampos(proximo)

    const novos = new URLSearchParams()
    novos.set("de", proximo.de)
    novos.set("ate", proximo.ate)
    if (proximo.loja !== "todas") novos.set("loja", proximo.loja)
    if (proximo.numero) novos.set("numero", proximo.numero)
    if (proximo.cliente) novos.set("cliente", proximo.cliente)
    if (proximo.situacao !== "abertas") novos.set("situacao", proximo.situacao)
    // Filtrar sempre volta para a primeira página: a terceira página do filtro
    // anterior quase nunca existe no novo, e a tela viria vazia sem dizer por quê.
    setParams(novos)
  }

  const tudo = () => aplicar(PERIODO_TODO)

  const nomeDaLoja = (codigo: string) =>
    lojas.find((loja) => loja.codigo === codigo)?.nome ?? codigo

  const periodo =
    filtro.de === filtro.ate
      ? diaEmTexto(filtro.de)
      : `${diaEmTexto(filtro.de)} a ${diaEmTexto(filtro.ate)}`

  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <Wallet className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Contas a receber</h1>
        <span className="text-xs text-muted-foreground">
          vence entre {periodo} ·{" "}
          {filtro.loja === "todas"
            ? `${lojas.length} ${lojas.length === 1 ? "loja" : "lojas"}`
            : nomeDaLoja(filtro.loja)}
        </span>

        <Button
          type="button"
          size="sm"
          variant="outline"
          // Folha vazia é papel gasto: sem linhas, não há o que conferir na gaveta.
          disabled={gerando || total === 0}
          onClick={imprimir}
          title="Imprime a lista deste filtro, para conferir a gaveta de boletos"
          className="ml-auto rounded-lg"
        >
          {gerando ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Printer className="size-4" aria-hidden />
          )}
          {gerando ? "Gerando…" : "Imprimir lista"}
        </Button>
      </div>

      {erroDaFolha ? (
        <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {erroDaFolha}
        </p>
      ) : null}

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(evento) => {
          evento.preventDefault()
          aplicar({})
        }}
      >
        <Campo rotulo="Vence de">
          <input
            type="date"
            value={campos.de}
            max={campos.ate}
            onChange={(e) => aplicar({ de: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>
        <Campo rotulo="Até">
          <input
            type="date"
            value={campos.ate}
            min={campos.de}
            onChange={(e) => aplicar({ ate: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>

        {/* Os atalhos olham para a FRENTE, ao contrário dos de vendas: numa
            carteira, "7 dias" é o que vou receber, não o que já recebi. O
            "Vencidas" é o único que olha para trás, e é o que mais se usa. */}
        <div className="flex gap-1 pb-0.5">
          <Atalho
            rotulo="Vencidas"
            onClick={() =>
              aplicar({ de: PRIMEIRO_DIA, ate: diaAtras(1), situacao: "abertas" })
            }
          />
          <Atalho rotulo="Hoje" onClick={() => aplicar({ de: diaDeHoje(), ate: diaDeHoje() })} />
          <Atalho rotulo="7 dias" onClick={() => aplicar({ de: diaDeHoje(), ate: diaAdiante(6) })} />
          <Atalho
            rotulo="30 dias"
            onClick={() => aplicar({ de: diaDeHoje(), ate: diaAdiante(29) })}
          />
          <Atalho rotulo="Tudo" onClick={tudo} />
        </div>

        <Campo rotulo="Loja">
          <select
            value={campos.loja}
            onChange={(e) => aplicar({ loja: e.target.value })}
            className={cn(ESTILO_CAMPO, "w-40")}
          >
            <option value="todas">Todas</option>
            {lojas.map((loja) => (
              <option key={loja.codigo} value={loja.codigo}>
                {loja.codigo} · {loja.nome}
              </option>
            ))}
          </select>
        </Campo>

        <Campo rotulo="Venda nº">
          <Input
            value={campos.numero}
            inputMode="numeric"
            onChange={(e) =>
              setCampos({ ...campos, numero: e.target.value.replace(/\D/g, "") })
            }
            placeholder="1234"
            type="search"
            autoComplete="off"
            className="h-9 w-24 rounded-lg border-border bg-background font-mono tabular-nums"
          />
        </Campo>

        <Campo rotulo="Cliente">
          <Input
            value={campos.cliente}
            onChange={(e) => setCampos({ ...campos, cliente: e.target.value })}
            placeholder="Nome ou CPF/CNPJ"
            type="search"
            autoComplete="off"
            className="h-9 w-56 rounded-lg border-border bg-background"
          />
        </Campo>

        <Campo rotulo="Situação">
          <select
            value={campos.situacao}
            onChange={(e) =>
              aplicar({ situacao: e.target.value as FiltroRecebiveis["situacao"] })
            }
            className={cn(ESTILO_CAMPO, "w-36")}
          >
            {SITUACOES_RECEBIVEIS.map((situacao) => (
              <option key={situacao.id} value={situacao.id}>
                {situacao.rotulo}
              </option>
            ))}
          </select>
        </Campo>

        <Button type="submit" size="sm" className="rounded-lg">
          <Search className="size-4" aria-hidden /> Filtrar
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setParams(new URLSearchParams())}
          className="rounded-lg"
        >
          Limpar
        </Button>
      </form>

      {/* Os cartões ignoram o seletor de situação: são a repartição do período,
          e obedecê-lo faria dois dos três serem sempre zero. */}
      <div className="mt-5 grid max-w-3xl gap-3 sm:grid-cols-3">
        <Numero
          rotulo="A receber"
          valor={moeda(resumo.aberto)}
          detalhe={`${resumo.abertoQuantidade} ${resumo.abertoQuantidade === 1 ? "parcela em aberto" : "parcelas em aberto"}`}
          destaque
        />
        <Numero
          rotulo="Vencido"
          valor={moeda(resumo.vencido)}
          detalhe={`${resumo.vencidoQuantidade} ${resumo.vencidoQuantidade === 1 ? "parcela" : "parcelas"} passou do dia`}
          alerta={resumo.vencido > 0}
        />
        <Numero
          rotulo="Recebido"
          valor={moeda(resumo.recebido)}
          detalhe={`${resumo.recebidoQuantidade} ${resumo.recebidoQuantidade === 1 ? "parcela paga" : "parcelas pagas"}`}
        />
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="w-32 py-2.5 text-left font-semibold">Vencimento</th>
              <th scope="col" className="w-20 px-2 py-2.5 text-left font-semibold">Venda</th>
              <th scope="col" className="w-16 px-2 py-2.5 text-left font-semibold">Loja</th>
              <th scope="col" className="px-2 py-2.5 text-left font-semibold">Cliente</th>
              <th scope="col" className="w-20 px-2 py-2.5 text-left font-semibold">Parcela</th>
              <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">Valor</th>
              <th scope="col" className="w-36 px-2 py-2.5 text-left font-semibold">Situação</th>
              <th scope="col" className="w-20 px-2 py-2.5 text-left font-semibold">Boleto</th>
            </tr>
          </thead>
          <tbody className={cn(consultando && "opacity-50")}>
            {recebiveis.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-16 text-center">
                  <Wallet className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
                  <p className="mt-3 text-sm text-muted-foreground">
                    Nenhuma conta vencendo em {periodo}
                    {filtro.loja === "todas" ? "" : ` na ${nomeDaLoja(filtro.loja)}`}.
                  </p>
                  {foraDoPeriodo > 0 ? (
                    <>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {foraDoPeriodo}{" "}
                        {foraDoPeriodo === 1
                          ? "conta casa com a busca fora deste período"
                          : "contas casam com a busca fora deste período"}
                        .
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={tudo}
                        className="mt-3 rounded-lg"
                      >
                        Procurar em toda a carteira
                      </Button>
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Amplie o período ou limpe os filtros acima.
                    </p>
                  )}
                </td>
              </tr>
            ) : (
              recebiveis.map((conta) => (
                <Linha key={conta.id} conta={conta} hoje={hoje} />
              ))
            )}
          </tbody>
        </table>
      </div>

      {paginas > 1 ? (
        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          <Pagina params={params} para={filtro.pagina - 1} ativa={filtro.pagina > 1}>
            ‹ Anteriores
          </Pagina>
          <span className="font-mono tabular-nums">
            página {filtro.pagina} de {paginas} · {total} parcelas
          </span>
          <Pagina params={params} para={filtro.pagina + 1} ativa={filtro.pagina < paginas}>
            Próximas ›
          </Pagina>
        </div>
      ) : total > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {total} {total === 1 ? "parcela" : "parcelas"} no filtro · uma linha por
          parcela, não por venda
        </p>
      ) : null}
    </div>
  )
}

/** Dias inteiros entre dois "YYYY-MM-DD" — sem `Date`, sem risco de fuso. */
function diasEntre(de: string, ate: string) {
  const um = inicioDoDia(de).getTime()
  const outro = inicioDoDia(ate).getTime()
  return Math.round((outro - um) / 86_400_000)
}

function Linha({ conta, hoje }: { conta: RecebivelConsultado; hoje: string }) {
  const vencimento = new Date(conta.vencimento)
  const dia = `${vencimento.getFullYear()}-${String(vencimento.getMonth() + 1).padStart(2, "0")}-${String(vencimento.getDate()).padStart(2, "0")}`

  const emAberto = SITUACOES_EM_ABERTO.includes(conta.situacao)
  const recebida = SITUACOES_RECEBIDAS.includes(conta.situacao)
  const atraso = emAberto ? diasEntre(dia, hoje) : 0

  return (
    <tr
      className={cn(
        "border-b border-border",
        !emAberto && !recebida && "opacity-60",
        conta.vendaCancelada && "bg-destructive/5"
      )}
    >
      <td className="py-2.5 pl-3">
        <span
          className={cn(
            "block font-mono text-xs tabular-nums",
            atraso > 0 && "font-semibold text-destructive"
          )}
        >
          {vencimento.toLocaleDateString("pt-BR")}
        </span>
        {/* O número de dias, e não só a cor: "23 dias" decide a ordem dos
            telefonemas, "vermelho" só diz que há algo errado. */}
        {atraso > 0 ? (
          <span className="text-[11px] text-destructive">
            {atraso === 1 ? "1 dia de atraso" : `${atraso} dias de atraso`}
          </span>
        ) : emAberto && atraso === 0 ? (
          <span className="text-[11px] text-muted-foreground">vence hoje</span>
        ) : null}
      </td>

      <td className="px-2 py-2.5">
        {/* Leva para a venda inteira, com o período aberto: o vencimento não diz
            de que dia foi a venda, e um link que herdasse o período desta tela
            cairia numa lista vazia. */}
        <Link
          to={`/admin/vendas?numero=${conta.vendaNumero}&loja=${conta.loja}&de=${PRIMEIRO_DIA}&ate=${hoje}`}
          className="font-mono font-semibold underline tabular-nums"
        >
          #{conta.vendaNumero}
        </Link>
        {conta.vendaEm ? (
          <span className="block font-mono text-[11px] text-muted-foreground tabular-nums">
            {new Date(conta.vendaEm).toLocaleDateString("pt-BR")}
          </span>
        ) : null}
      </td>

      <td className="px-2 py-2.5">
        <Badge variant="outline" className="font-mono text-[10px]">
          {conta.loja}
        </Badge>
      </td>

      <td className="max-w-[16rem] px-2 py-2.5">
        <span className="block truncate text-xs">
          {conta.clienteNome ?? "—"}
        </span>
        {conta.clienteCpfCnpj ? (
          <span className="block font-mono text-[11px] text-muted-foreground tabular-nums">
            {conta.clienteCpfCnpj}
          </span>
        ) : null}
        {conta.vendaCancelada ? (
          <span className="text-[11px] font-medium text-destructive">
            venda cancelada
          </span>
        ) : null}
      </td>

      <td className="px-2 py-2.5 font-mono text-xs tabular-nums">
        {conta.parcela}/{conta.parcelas}
      </td>

      <td className="px-2 py-2.5 text-right font-mono font-medium tabular-nums">
        {moeda(conta.valor)}
      </td>

      <td className="px-2 py-2.5">
        <Badge
          variant={recebida ? "default" : atraso > 0 ? "destructive" : "secondary"}
          className="font-mono text-[10px]"
        >
          {conta.situacao}
        </Badge>
      </td>

      <td className="px-2 py-2.5">
        {/* Só o que ainda pode ser pago: link de PDF de boleto cancelado leva a um
            503 do Inter, que na tela parece defeito nosso. */}
        {emAberto ? (
          <a
            href={`/vendas/${conta.vendaId}/boleto.pdf?parcela=${conta.parcela}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs underline"
          >
            <FileText className="size-3.5 shrink-0" aria-hidden /> abrir
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  )
}
