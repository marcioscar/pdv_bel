import type { Prisma } from "@prisma/client"
import { useEffect, useState } from "react"
import { data, Link, useNavigation, useSearchParams } from "react-router"
import { FileCode, FileText, Search } from "lucide-react"

import type { Route } from "./+types/admin.notas"
import { EmailDaNota } from "~/components/pdv/email-da-nota"
import { Atalho, Campo, ESTILO_CAMPO, Pagina } from "~/components/pdv/filtros"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { db } from "~/lib/db.server"
import { depoisDoDia, diaAtras, diaDeHoje, diaEmTexto, inicioDoDia, PRIMEIRO_DIA } from "~/lib/dia"
import { formatarCpfCnpj } from "~/lib/documento"
import { urlDoArquivo } from "~/lib/focus.server"
import { listarLojas } from "~/lib/lojas.server"
import { moeda } from "~/lib/moeda"
import { enviarNotaPorEmail } from "~/lib/nota-email.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Notas emitidas — BrasSaco" }]
}

/**
 * As notas que a rede emitiu, para achar a de uma venda antiga.
 *
 * O caso que a motivou: o cliente volta semanas depois pedindo a nota. /vendas
 * já mostra e reenvia, mas só da loja do turno e só do que está no período — e
 * o cliente nem sempre lembra onde comprou. Aqui se procura pelo nome ou pelo
 * CPF/CNPJ em todas as lojas, e o DANFE e o XML se abrem ou vão por e-mail.
 *
 * Fica fora de Contas a receber porque a maior parte das notas é de venda à
 * vista: nunca houve boleto para ela aparecer lá.
 */

const POR_PAGINA = 50
const DIA = /^\d{4}-\d{2}-\d{2}$/
const OBJECT_ID = /^[a-f0-9]{24}$/

const MODELOS = [
  { id: "", rotulo: "Todos" },
  { id: "nfe", rotulo: "NF-e" },
  { id: "nfce", rotulo: "NFC-e" },
] as const

const SITUACOES = [
  { id: "autorizadas", rotulo: "Autorizadas" },
  { id: "todas", rotulo: "Todas" },
] as const

type Filtro = {
  loja: string
  de: string
  ate: string
  cliente: string
  numero: string
  modelo: (typeof MODELOS)[number]["id"]
  situacao: (typeof SITUACOES)[number]["id"]
  pagina: number
}

function lerFiltro(url: URL, lojasPermitidas: string[]): Filtro {
  const params = url.searchParams
  const texto = (nome: string) => (params.get(nome) ?? "").trim()

  // Sem período, os últimos noventa dias: quem pede a nota de volta raramente
  // pede a de ontem, e um mês só esconderia justamente o caso desta tela.
  const de = DIA.test(texto("de")) ? texto("de") : diaAtras(89)
  const ateBruto = DIA.test(texto("ate")) ? texto("ate") : diaDeHoje()
  const [inicio, fim] = ateBruto < de ? [ateBruto, de] : [de, ateBruto]

  const modelo = MODELOS.find((m) => m.id === texto("modelo"))?.id ?? ""
  return {
    loja: lojasPermitidas.includes(texto("loja")) ? texto("loja") : "todas",
    de: inicio,
    ate: fim,
    cliente: texto("cliente").slice(0, 60),
    numero: texto("numero").replace(/\D/g, "").slice(0, 9),
    modelo,
    situacao: texto("situacao") === "todas" ? "todas" : "autorizadas",
    pagina: Math.max(1, Math.trunc(Number(params.get("pagina"))) || 1),
  }
}

/** O Prisma entrega o `contains` ao Mongo como regex cru: "(teste" derrubava a busca. */
function literal(busca: string) {
  return busca.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)
  const filtro = lerFiltro(new URL(request.url), eu.lojasPermitidas)
  const lojas = filtro.loja === "todas" ? eu.lojasPermitidas : [filtro.loja]

  const condicoes: Prisma.NotaFiscalEmitidaWhereInput[] = [
    { loja: { in: lojas } },
    // Nota de homologação não vale nada: mandar uma ao cliente seria pior que
    // não mandar nenhuma.
    { ambiente: "producao" },
    { criadaEm: { gte: inicioDoDia(filtro.de), lt: depoisDoDia(filtro.ate) } },
  ]
  if (filtro.situacao === "autorizadas") condicoes.push({ status: "autorizado" })
  if (filtro.modelo) condicoes.push({ modelo: filtro.modelo })
  if (filtro.cliente) {
    // O nome e o documento que saíram NA NOTA, não os do cadastro de hoje: é a
    // nota que o cliente tem em mãos (ou perdeu).
    const digitos = filtro.cliente.replace(/\D/g, "")
    condicoes.push({
      OR: [
        { destinatarioNome: { contains: literal(filtro.cliente), mode: "insensitive" } },
        ...(digitos.length >= 3 ? [{ destinatarioCpfCnpj: { contains: digitos } }] : []),
      ],
    })
  }
  if (filtro.numero) {
    // Um campo só para os dois números: o cliente diz o do cupom, o vendedor
    // acha o da venda, e nenhum dos dois sabe qual o outro tem.
    const vendas = await db.venda.findMany({
      where: { numero: Number(filtro.numero), loja: { in: lojas } },
      select: { id: true },
    })
    condicoes.push({
      OR: [{ numero: filtro.numero }, { vendaId: { in: vendas.map((v) => v.id) } }],
    })
  }

  const where = { AND: condicoes }
  const [emitidas, total, todasAsLojas] = await Promise.all([
    db.notaFiscalEmitida.findMany({
      where,
      orderBy: { criadaEm: "desc" },
      skip: (filtro.pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
    }),
    db.notaFiscalEmitida.count({ where }),
    listarLojas(),
  ])

  // O número da venda e o e-mail do cliente, que moram na venda e no cadastro.
  const vendaIds = emitidas.map((n) => n.vendaId).filter((v): v is string => Boolean(v))
  const vendas = await db.venda.findMany({
    where: { id: { in: vendaIds } },
    select: { id: true, numero: true, clienteId: true },
  })
  const clientes = await db.cliente.findMany({
    where: { id: { in: vendas.map((v) => v.clienteId).filter((c): c is string => Boolean(c)) } },
    select: { id: true, email: true },
  })
  const emailPorCliente = new Map(clientes.map((c) => [c.id, c.email?.trim() || null]))
  const vendaPorId = new Map(vendas.map((v) => [v.id, v]))

  const notas = emitidas.map((nota) => {
    const venda = nota.vendaId ? vendaPorId.get(nota.vendaId) : undefined
    return {
      id: nota.id,
      loja: nota.loja,
      modelo: nota.modelo,
      numero: nota.numero,
      serie: nota.serie,
      status: nota.status,
      chave: nota.chave,
      criadaEm: nota.criadaEm.toISOString(),
      valorTotal: nota.valorTotal,
      destinatarioNome: nota.destinatarioNome,
      destinatarioCpfCnpj: nota.destinatarioCpfCnpj,
      vendaNumero: venda?.numero ?? null,
      temDanfe: Boolean(nota.caminhoDanfe),
      xml: urlDoArquivo(nota.caminhoXml),
      emailDoCliente: venda?.clienteId ? (emailPorCliente.get(venda.clienteId) ?? null) : null,
      emailEnviadoEm: nota.emailEnviadoEm?.toISOString() ?? null,
      emailEnviadoPara: nota.emailEnviadoPara,
      emailEnviadoPor: nota.emailEnviadoPor,
      emailErro: nota.emailErro,
    }
  })

  return {
    filtro,
    lojas: todasAsLojas.filter((loja) => eu.lojasPermitidas.includes(loja.codigo)),
    notas,
    total,
    paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
    hoje: diaDeHoje(),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)
  const form = await request.formData()
  if (form.get("acao") !== "emailNota") {
    return data({ ok: false as const, tipo: "?", erro: "Ação desconhecida" }, { status: 400 })
  }

  const notaId = String(form.get("notaId") ?? "")
  if (!OBJECT_ID.test(notaId)) {
    return data({ ok: false as const, tipo: "emailNota" as const, erro: "Nota inválida" }, { status: 400 })
  }
  // A guarda da loja é cobrada aqui, e não só na lista: o id vem do formulário.
  const nota = await db.notaFiscalEmitida.findUnique({ where: { id: notaId }, select: { loja: true } })
  if (!nota || !eu.lojasPermitidas.includes(nota.loja)) {
    return data({ ok: false as const, tipo: "emailNota" as const, erro: "Nota não encontrada" }, { status: 404 })
  }

  const r = await enviarNotaPorEmail({ notaId, para: String(form.get("para") ?? ""), quem: eu.nome })
  return r.ok
    ? { ok: true as const, tipo: "emailNota" as const, para: r.para }
    : data({ ok: false as const, tipo: "emailNota" as const, erro: r.erro }, { status: 400 })
}

const ROTULO_DO_STATUS: Record<string, string> = {
  autorizado: "autorizada",
  cancelado: "cancelada",
  processando_autorizacao: "na fila",
  erro_autorizacao: "recusada",
  denegado: "denegada",
}

export default function NotasEmitidas({ loaderData }: Route.ComponentProps) {
  const { filtro, lojas, notas, total, paginas, hoje } = loaderData
  const [params, setParams] = useSearchParams()
  const consultando = useNavigation().state === "loading"

  const [campos, setCampos] = useState(filtro)
  useEffect(() => setCampos(filtro), [filtro])

  function aplicar(mudanca: Partial<Filtro>) {
    const proximo = { ...campos, ...mudanca }
    setCampos(proximo)
    const novos = new URLSearchParams()
    novos.set("de", proximo.de)
    novos.set("ate", proximo.ate)
    if (proximo.loja !== "todas") novos.set("loja", proximo.loja)
    if (proximo.cliente) novos.set("cliente", proximo.cliente)
    if (proximo.numero) novos.set("numero", proximo.numero)
    if (proximo.modelo) novos.set("modelo", proximo.modelo)
    if (proximo.situacao !== "autorizadas") novos.set("situacao", proximo.situacao)
    setParams(novos)
  }

  const periodo =
    filtro.de === filtro.ate
      ? diaEmTexto(filtro.de)
      : `${diaEmTexto(filtro.de)} a ${diaEmTexto(filtro.ate)}`

  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <FileText className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Notas emitidas</h1>
        <span className="text-xs text-muted-foreground">
          emitidas entre {periodo} · {filtro.loja === "todas" ? "todas as lojas" : filtro.loja}
        </span>
      </div>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(evento) => {
          evento.preventDefault()
          aplicar({})
        }}
      >
        <Campo rotulo="Cliente">
          <Input
            value={campos.cliente}
            onChange={(e) => setCampos({ ...campos, cliente: e.target.value })}
            placeholder="Nome ou CPF/CNPJ"
            type="search"
            autoComplete="off"
            autoFocus
            className="h-9 w-64 rounded-lg border-border bg-background"
          />
        </Campo>
        <Campo rotulo="Nº nota ou venda">
          <Input
            value={campos.numero}
            inputMode="numeric"
            onChange={(e) => setCampos({ ...campos, numero: e.target.value.replace(/\D/g, "") })}
            placeholder="1234"
            type="search"
            autoComplete="off"
            className="h-9 w-28 rounded-lg border-border bg-background font-mono tabular-nums"
          />
        </Campo>

        <Campo rotulo="Emitida de">
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
        <div className="flex gap-1 pb-0.5">
          <Atalho rotulo="30 dias" onClick={() => aplicar({ de: diaAtras(29), ate: diaDeHoje() })} />
          <Atalho rotulo="90 dias" onClick={() => aplicar({ de: diaAtras(89), ate: diaDeHoje() })} />
          <Atalho rotulo="12 meses" onClick={() => aplicar({ de: diaAtras(364), ate: diaDeHoje() })} />
          <Atalho rotulo="Tudo" onClick={() => aplicar({ de: PRIMEIRO_DIA, ate: diaDeHoje() })} />
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
        <Campo rotulo="Modelo">
          <select
            value={campos.modelo}
            onChange={(e) => aplicar({ modelo: e.target.value as Filtro["modelo"] })}
            className={cn(ESTILO_CAMPO, "w-28")}
          >
            {MODELOS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.rotulo}
              </option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Situação">
          <select
            value={campos.situacao}
            onChange={(e) => aplicar({ situacao: e.target.value as Filtro["situacao"] })}
            className={cn(ESTILO_CAMPO, "w-32")}
          >
            {SITUACOES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.rotulo}
              </option>
            ))}
          </select>
        </Campo>

        <Button type="submit" size="sm" className="rounded-lg">
          <Search className="size-4" aria-hidden /> Buscar
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

      {/* Sem `overflow-x-auto` em volta: ele cortaria o balão do e-mail, que se
          abre para cima de dentro da linha. */}
      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="w-28 py-2.5 text-left font-semibold">Emitida</th>
            <th scope="col" className="w-32 px-2 py-2.5 text-left font-semibold">Nota</th>
            <th scope="col" className="w-20 px-2 py-2.5 text-left font-semibold">Venda</th>
            <th scope="col" className="w-16 px-2 py-2.5 text-left font-semibold">Loja</th>
            <th scope="col" className="px-2 py-2.5 text-left font-semibold">Cliente</th>
            <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">Valor</th>
            <th scope="col" className="px-2 py-2.5 text-right font-semibold">Documentos</th>
          </tr>
        </thead>
        <tbody className={cn(consultando && "opacity-50")}>
          {notas.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-16 text-center">
                <FileText className="mx-auto size-10 text-muted-foreground/40" aria-hidden />
                <p className="mt-3 text-sm text-muted-foreground">
                  Nenhuma nota emitida em {periodo} com este filtro.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  A compra pode ser mais antiga: tente “12 meses” ou “Tudo”.
                </p>
              </td>
            </tr>
          ) : (
            notas.map((nota) => {
              const rotulo = nota.modelo === "nfe" ? "NF-e" : "NFC-e"
              const autorizada = nota.status === "autorizado"
              return (
                <tr
                  key={nota.id}
                  className={cn("border-b border-border", !autorizada && "opacity-60")}
                >
                  <td className="py-2.5 pl-3 font-mono text-xs tabular-nums">
                    {new Date(nota.criadaEm).toLocaleDateString("pt-BR")}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="font-medium">
                      {rotulo} {nota.numero ?? ""}
                    </span>
                    {autorizada ? null : (
                      <Badge variant="outline" className="ml-1 text-[9px]">
                        {ROTULO_DO_STATUS[nota.status] ?? nota.status}
                      </Badge>
                    )}
                    {nota.serie ? (
                      <span className="block text-[11px] text-muted-foreground">série {nota.serie}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5">
                    {nota.vendaNumero ? (
                      <Link
                        to={`/admin/vendas?numero=${nota.vendaNumero}&loja=${nota.loja}&de=${PRIMEIRO_DIA}&ate=${hoje}`}
                        className="font-mono font-semibold underline tabular-nums"
                      >
                        #{nota.vendaNumero}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {nota.loja}
                    </Badge>
                  </td>
                  <td className="max-w-[18rem] px-2 py-2.5">
                    <span className="block truncate text-xs">
                      {nota.destinatarioNome ?? "Consumidor final"}
                    </span>
                    {nota.destinatarioCpfCnpj ? (
                      <span className="block font-mono text-[11px] text-muted-foreground tabular-nums">
                        {formatarCpfCnpj(nota.destinatarioCpfCnpj)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono font-medium tabular-nums">
                    {moeda(nota.valorTotal)}
                  </td>
                  <td className="px-2 py-2.5">
                    {autorizada ? (
                      <div className="flex items-center justify-end gap-1.5">
                        {nota.temDanfe ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-lg"
                            nativeButton={false}
                            render={<a href={`/notas/${nota.id}/danfe`} target="_blank" rel="noopener" />}
                          >
                            <FileText className="size-4" aria-hidden /> DANFE
                          </Button>
                        ) : null}
                        {nota.xml ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-lg"
                            nativeButton={false}
                            render={<a href={nota.xml} target="_blank" rel="noopener" />}
                          >
                            <FileCode className="size-4" aria-hidden /> XML
                          </Button>
                        ) : null}
                        <EmailDaNota key={nota.id} nota={nota} alinhar="direita" />
                      </div>
                    ) : null}
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>

      {paginas > 1 ? (
        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          <Pagina params={params} para={filtro.pagina - 1} ativa={filtro.pagina > 1}>
            ‹ Anteriores
          </Pagina>
          <span className="font-mono tabular-nums">
            página {filtro.pagina} de {paginas} · {total} notas
          </span>
          <Pagina params={params} para={filtro.pagina + 1} ativa={filtro.pagina < paginas}>
            Próximas ›
          </Pagina>
        </div>
      ) : total > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {total} {total === 1 ? "nota" : "notas"} no filtro
        </p>
      ) : null}
    </div>
  )
}
