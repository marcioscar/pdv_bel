import { useMemo, useState } from "react"
import { data, Form, useNavigation } from "react-router"
import { Loader2, PackageCheck, Printer, Search, Send, Truck, X } from "lucide-react"

import type { Route } from "./+types/transferencias"
import { Topo } from "~/components/pdv/topo"
import { CabecalhoDaTransferencia } from "~/components/pdv/transferencia-celulas"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { db } from "~/lib/db.server"
import { saldosPorProduto } from "~/lib/estoque.server"
import { listarLojas } from "~/lib/lojas.server"
import { quantidade as formatarQuantidade } from "~/lib/moeda"
import {
  buscarProdutos,
  criarIndice,
  interpretarComando,
  produtosPorCodigo,
  type ProdutoCatalogo,
} from "~/lib/pdv"
import { SOMENTE_ATIVOS } from "~/lib/produtos.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { faltaEmAberto, rotuloDaSituacao } from "~/lib/transferencias"
import {
  cancelarTransferencia,
  conferirTransferencia,
  enviarTransferencia,
  listarTransferencias,
  type TransferenciaListada,
} from "~/lib/transferencias.server"
import { imprimirDocumento } from "~/lib/impressao"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Transferências — BrasSaco" }]
}

/**
 * Mercadoria indo de uma loja para outra.
 *
 * A tela é dividida pelo que cada pessoa precisa fazer, não pelo que o sistema
 * guarda: primeiro o que chegou e espera conferência (é urgente, o estoque do
 * destino está defasado até alguém contar), depois o que saiu e ainda está no
 * caminho, depois a montagem de uma remessa nova.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const [cadastro, saldos, lojas, transferencias] = await Promise.all([
    db.produto.findMany({ where: SOMENTE_ATIVOS, orderBy: { descricao: "asc" } }),
    saldosPorProduto(eu.loja),
    listarLojas(),
    listarTransferencias(eu.lojasPermitidas),
  ])

  /**
   * O catálogo INTEIRO, com o saldo de cada um — sem filtrar por quem tem saldo.
   *
   * A primeira versão só oferecia o que tinha estoque, o que parecia prudente e
   * na prática deixava a busca vazia: o estoque desta base está praticamente
   * zerado, então o operador digitava "copo" e não achava nada. Pior, não havia
   * como ele saber por quê.
   *
   * É a mesma escolha que o caixa já faz ao vender com estoque 0: mostra, avisa
   * e deixa seguir. Ser mais rígido aqui do que no balcão seria incoerente — e a
   * mercadoria que está sendo carregada no carro existe, independentemente do
   * que o sistema ache que existe.
   */
  const produtos = cadastro.map((p) => ({ ...p, estoque: saldos.get(p.id) ?? 0 }))

  return {
    eu,
    produtos,
    lojas: lojas.filter((l) => eu.lojasPermitidas.includes(l.codigo)),
    transferencias,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)
  const formulario = await request.formData()
  const intencao = String(formulario.get("intencao") ?? "")

  if (intencao === "enviar") {
    const itens = JSON.parse(String(formulario.get("itens") ?? "[]")) as {
      produtoId: string
      quantidade: number
    }[]

    const resultado = await enviarTransferencia({
      // A origem é a loja da SESSÃO, nunca do formulário: com ela no payload,
      // daria para tirar mercadoria de uma loja onde não se está.
      origem: eu.loja,
      destino: String(formulario.get("destino") ?? ""),
      itens,
      operador: eu.nome,
      operadorId: eu.id,
      observacao: String(formulario.get("observacao") ?? ""),
    })

    if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
    return { ok: true as const, mensagem: `Transferência #${resultado.numero} despachada` }
  }

  if (intencao === "conferir") {
    const conferidos = JSON.parse(String(formulario.get("conferidos") ?? "[]")) as {
      produtoId: string
      recebida: number
    }[]

    const resultado = await conferirTransferencia({
      id: String(formulario.get("id") ?? ""),
      conferidos,
      operador: eu.nome,
      operadorId: eu.id,
      lojasPermitidas: eu.lojasPermitidas,
    })

    if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
    return {
      ok: true as const,
      mensagem: resultado.faltou
        ? `Conferida com falta em ${resultado.itensComFalta} ${resultado.itensComFalta === 1 ? "item" : "itens"} — um gerente precisa resolver`
        : "Conferida: tudo o que saiu chegou",
    }
  }

  if (intencao === "cancelar") {
    const resultado = await cancelarTransferencia({
      id: String(formulario.get("id") ?? ""),
      operador: eu.nome,
    })
    if (!resultado.ok) return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
    return { ok: true as const, mensagem: "Transferência cancelada — a carga voltou para a origem" }
  }

  return data({ ok: false as const, erro: "Ação desconhecida" }, { status: 400 })
}

export default function Transferencias({ loaderData, actionData }: Route.ComponentProps) {
  const { eu, produtos, lojas, transferencias } = loaderData
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  const chegando = transferencias.filter(
    (t) => t.situacao === "em_transito" && t.destino === eu.loja
  )
  const saindo = transferencias.filter(
    (t) => t.situacao === "em_transito" && t.origem === eu.loja
  )
  const encerradas = transferencias.filter(
    (t) => t.situacao !== "em_transito" && !faltaEmAberto(t)
  )

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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Transferências</h1>
        <span className="text-xs text-muted-foreground">
          você está operando em <b className="font-mono">{eu.loja}</b>
        </span>
      </div>

      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        A mercadoria sai do estoque na hora em que é despachada — é quando ela deixa a
        prateleira. Entra no destino quando alguém confere, e o que entra é o que foi{" "}
        <b>contado</b>, não o que foi mandado.
      </p>

      {actionData ? (
        <p
          role="alert"
          className={cn(
            "mt-3 rounded-lg px-3 py-2 text-sm",
            actionData.ok
              ? "bg-primary/10 text-foreground"
              : "bg-destructive/10 text-destructive"
          )}
        >
          {actionData.ok ? actionData.mensagem : actionData.erro}
        </p>
      ) : null}

      {chegando.length > 0 ? (
        <Secao
          titulo={`Chegando em ${eu.loja}`}
          detalhe="confira o que chegou para entrar no estoque"
          destaque
        >
          {chegando.map((t) => (
            <Conferencia key={t.id} transferencia={t} euId={eu.id} />
          ))}
        </Secao>
      ) : null}

      <Secao titulo="Nova remessa" detalhe={`sai de ${eu.loja}`}>
        <NovaRemessa
          produtos={produtos}
          lojas={lojas.filter((l) => l.codigo !== eu.loja)}
          origem={eu.loja}
        />
      </Secao>

      {saindo.length > 0 ? (
        <Secao titulo="Saíram daqui, ainda no caminho">
          {saindo.map((t) => (
            <EmTransito key={t.id} transferencia={t} />
          ))}
        </Secao>
      ) : null}

      {encerradas.length > 0 ? (
        <Secao titulo="Histórico">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2.5 text-left font-semibold">Nº</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Quando</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Rota</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Itens</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Situação</th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">Papel</th>
                </tr>
              </thead>
              <tbody>
                {encerradas.map((t) => (
                  <tr key={t.id} className="border-b border-border">
                    <td className="py-2.5 font-mono font-semibold tabular-nums">#{t.numero}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                      {new Date(t.criadaEm).toLocaleDateString("pt-BR")}
                    </td>
                    <td className="px-2 py-2.5 font-mono text-xs">
                      {t.origem} → {t.destino}
                    </td>
                    <td className="px-2 py-2.5 text-xs text-muted-foreground">
                      {t.itens.length} {t.itens.length === 1 ? "produto" : "produtos"}
                    </td>
                    <td className="px-2 py-2.5">
                      <Badge
                        variant={
                          t.situacao === "cancelada"
                            ? "outline"
                            : t.situacao === "recebida_com_falta"
                              ? "destructive"
                              : "default"
                        }
                        className="text-[10px]"
                      >
                        {rotuloDaSituacao(t.situacao)}
                      </Badge>
                    </td>
                    <td className="px-2 py-2.5">
                      <a
                        href={`/transferencias/${t.id}/romaneio`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline"
                      >
                        romaneio
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Secao>
      ) : null}
      </div>
    </main>
  )
}

function Secao({
  titulo,
  detalhe,
  destaque,
  children,
}: {
  titulo: string
  detalhe?: string
  destaque?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="mt-7">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={cn(destaque && "text-destructive")}>{titulo}</span>
        {detalhe ? <span className="font-normal normal-case">· {detalhe}</span> : null}
      </h2>
      <div className="mt-3 grid gap-3">{children}</div>
    </section>
  )
}

type ItemDaRemessa = { produto: ProdutoCatalogo; quantidade: number }

function NovaRemessa({
  produtos,
  lojas,
  origem,
}: {
  produtos: ProdutoCatalogo[]
  lojas: { codigo: string; nome: string }[]
  origem: string
}) {
  const navegacao = useNavigation()
  const enviando = navegacao.formData?.get("intencao") === "enviar"

  const [destino, setDestino] = useState(lojas[0]?.codigo ?? "")
  const [termo, setTermo] = useState("")
  const [erro, setErro] = useState<string | null>(null)
  const [itens, setItens] = useState<ItemDaRemessa[]>([])

  const indice = useMemo(() => criarIndice(produtos), [produtos])

  /**
   * A mesma linguagem do caixa: `3*10` são três do código 10, `4 x copo` são
   * quatro do que casar com "copo", e um código sozinho é uma unidade.
   *
   * É `interpretarComando`, a mesma função que o balcão usa — e não uma cópia
   * parecida. Quem monta a remessa é a mesma pessoa que vende, e duas telas que
   * entendem a digitação de jeitos diferentes é o tipo de detalhe que faz alguém
   * mandar 1 quando queria mandar 12.
   */
  const comando = useMemo(() => interpretarComando(termo), [termo])

  const achados = useMemo(
    () => (comando.tipo === "texto" ? buscarProdutos(indice, comando.termo, 6) : []),
    [comando, indice]
  )

  function adicionar(produto: ProdutoCatalogo, quantidade: number) {
    setErro(null)
    setItens((atuais) => {
      const existe = atuais.find((i) => i.produto.id === produto.id)
      // Bipar duas vezes o mesmo produto soma, como no carrinho — não repete a linha.
      if (existe) {
        return atuais.map((i) =>
          i.produto.id === produto.id ? { ...i, quantidade: i.quantidade + quantidade } : i
        )
      }
      return [...atuais, { produto, quantidade }]
    })
    setTermo("")
  }

  /**
   * Enter resolve o que estiver digitado.
   *
   * Código exato entra direto, sem passar pela lista: é o caminho do leitor de
   * código de barras, que termina a leitura com Enter. Se o texto casar com um
   * produto só, esse entra; com vários, a lista fica na tela para escolher.
   */
  function confirmarDigitado() {
    if (comando.tipo === "vazio") return

    if (comando.tipo === "codigo") {
      const achadosPorCodigo = produtosPorCodigo(produtos, comando.codigo)
      if (achadosPorCodigo.length === 0) {
        // O leitor termina com Enter: deixar o texto faria a próxima leitura
        // concatenar no código que falhou.
        setTermo("")
        setErro(`Código ${comando.codigo} não existe no catálogo`)
        return
      }
      adicionar(achadosPorCodigo[0], comando.quantidade)
      return
    }

    if (achados.length === 1) {
      adicionar(achados[0], comando.quantidade)
      return
    }
    if (achados.length === 0) {
      setErro(`Nada encontrado para "${comando.termo}" no catálogo`)
    }
  }

  const total = itens.reduce((acc, i) => acc + i.quantidade, 0)

  if (lojas.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        Não há outra loja para onde mandar — você só opera nesta.
      </p>
    )
  }

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Para
          </span>
          <select
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
            className="h-10 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring"
          >
            {lojas.map((l) => (
              <option key={l.codigo} value={l.codigo}>
                {l.codigo} · {l.nome}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-52 flex-1 flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Produto
          </span>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={termo}
              onChange={(e) => {
                setTermo(e.target.value)
                setErro(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  confirmarDigitado()
                }
              }}
              placeholder="3*10, 4 x copo, ou bipe o código"
              type="search"
              autoComplete="off"
              className="h-10 rounded-lg border-border bg-background pl-8"
            />
          </div>
        </label>
      </div>

      {erro ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {erro}
        </p>
      ) : null}

      {/* O que a digitação virou, antes de o Enter ser apertado: com "3*10" na
          barra, a lista mostra o produto e o cabeçalho lembra que vão três. */}
      {comando.tipo !== "vazio" && comando.quantidade !== 1 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          vão <b className="font-mono">{formatarQuantidade(comando.quantidade)}</b> unidades
        </p>
      ) : null}

      {achados.length > 0 ? (
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
          {achados.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() =>
                  adicionar(p, comando.tipo === "vazio" ? 1 : comando.quantidade)
                }
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
              >
                <span className="font-mono text-xs text-muted-foreground">{p.codigo}</span>
                <span className="min-w-0 flex-1 truncate">{p.descricao}</span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-xs tabular-nums",
                    p.estoque > 0 ? "text-muted-foreground" : "text-destructive"
                  )}
                >
                  {p.estoque > 0
                    ? `${formatarQuantidade(p.estoque)} ${p.unidade}`
                    : "sem saldo"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {itens.length > 0 ? (
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {itens.map(({ produto, quantidade }) => (
            <li key={produto.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{produto.descricao}</span>
                <span
                  className={cn(
                    "font-mono text-[11px] tabular-nums",
                    quantidade > produto.estoque ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {produto.codigo} ·{" "}
                  {quantidade > produto.estoque
                    ? `o sistema só tem ${formatarQuantidade(produto.estoque)} ${produto.unidade} aqui`
                    : `tem ${formatarQuantidade(produto.estoque)} ${produto.unidade}`}
                </span>
              </span>
              <Input
                value={String(quantidade)}
                inputMode="decimal"
                onChange={(e) => {
                  const valor = Number(e.target.value.replace(",", "."))
                  setItens((atuais) =>
                    atuais.map((i) =>
                      i.produto.id === produto.id
                        ? { ...i, quantidade: Number.isFinite(valor) ? valor : 0 }
                        : i
                    )
                  )
                }}
                aria-label={`Quantidade de ${produto.descricao}`}
                className={cn(
                  "h-10 w-24 rounded-lg border-border bg-background text-right font-mono tabular-nums",
                  // Marca, mas não impede: o despacho passa mesmo assim, como a
                  // venda passa com estoque zerado. O vermelho é para quem
                  // carrega conferir se é a mercadoria certa, não uma trava.
                  quantidade > produto.estoque && "border-destructive text-destructive"
                )}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Tirar ${produto.descricao}`}
                onClick={() =>
                  setItens((atuais) => atuais.filter((i) => i.produto.id !== produto.id))
                }
              >
                <X className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <Form method="post" className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="intencao" value="enviar" />
        <input type="hidden" name="destino" value={destino} />
        <input
          type="hidden"
          name="itens"
          value={JSON.stringify(
            itens.map((i) => ({ produtoId: i.produto.id, quantidade: i.quantidade }))
          )}
        />
        <Input
          name="observacao"
          placeholder="Observação (opcional) — quem levou, em que carro"
          autoComplete="off"
          className="h-10 w-full min-w-0 rounded-lg border-border bg-background text-sm sm:w-auto sm:flex-1"
        />
        <Button
          type="submit"
          disabled={enviando || itens.length === 0 || itens.some((i) => i.quantidade <= 0)}
          className="h-11 w-full rounded-lg sm:w-auto"
        >
          <Send className="size-4" aria-hidden />
          {enviando ? "Despachando…" : `Despachar ${total > 0 ? `${formatarQuantidade(total)} un` : ""}`}
        </Button>
      </Form>
    </div>
  )
}

/**
 * Imprime o romaneio: o papel que vai junto com a carga.
 *
 * Vai direto para a impressora em vez de abrir aba, como o cupom: quem está
 * despachando tem as mãos ocupadas e não vai procurar a janela, apertar Ctrl+P e
 * fechá-la.
 */
function BotaoRomaneio({ id, rotulo }: { id: string; rotulo: string }) {
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={gerando}
        className="rounded-lg"
        onClick={async () => {
          setGerando(true)
          const problema = await imprimirDocumento(`/transferencias/${id}/romaneio`)
          setGerando(false)
          setErro(problema)
        }}
      >
        {gerando ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Printer className="size-4" aria-hidden />
        )}
        {rotulo}
      </Button>
      {erro ? (
        <span role="alert" className="text-xs text-destructive">
          {erro}
        </span>
      ) : null}
    </>
  )
}

function Conferencia({
  transferencia: t,
  euId,
}: {
  transferencia: TransferenciaListada
  euId: string
}) {
  const navegacao = useNavigation()
  const enviando = navegacao.formData?.get("id") === t.id

  const [contagem, setContagem] = useState<Record<string, string>>(
    () => Object.fromEntries(t.itens.map((i) => [i.produtoId, String(i.enviada)]))
  )

  // Quem despachou não confere a própria carga: seria assinar os dois lados.
  const foiEuQueEnviei = t.enviadaPorId === euId

  return (
    <article className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
      <CabecalhoDaTransferencia transferencia={t} />
      {t.observacao ? (
        <p className="mt-1 text-xs text-muted-foreground">{t.observacao}</p>
      ) : null}

      {foiEuQueEnviei ? (
        <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs">
          Você despachou esta carga — a conferência tem de ser feita por outra pessoa de{" "}
          {t.destino}.
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs text-muted-foreground">
            Conte o que chegou. O campo já vem com o que foi mandado — corrija onde
            estiver diferente.
          </p>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {t.itens.map((item) => {
              const digitado = Number((contagem[item.produtoId] ?? "").replace(",", "."))
              const diverge = Number.isFinite(digitado) && digitado !== item.enviada
              return (
                <li key={item.produtoId} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{item.descricao}</span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      saiu {formatarQuantidade(item.enviada)} {item.unidade}
                    </span>
                  </span>
                  <Input
                    value={contagem[item.produtoId] ?? ""}
                    inputMode="decimal"
                    onChange={(e) =>
                      setContagem((c) => ({ ...c, [item.produtoId]: e.target.value }))
                    }
                    aria-label={`Contado de ${item.descricao}`}
                    className={cn(
                      "h-10 w-24 rounded-lg border-border bg-background text-right font-mono tabular-nums",
                      diverge && "border-destructive font-semibold text-destructive"
                    )}
                  />
                </li>
              )
            })}
          </ul>

          <Form method="post" className="mt-3 flex flex-wrap gap-2">
            <input type="hidden" name="intencao" value="conferir" />
            <input type="hidden" name="id" value={t.id} />
            <input
              type="hidden"
              name="conferidos"
              value={JSON.stringify(
                t.itens.map((i) => ({
                  produtoId: i.produtoId,
                  recebida: Number((contagem[i.produtoId] ?? "0").replace(",", ".")) || 0,
                }))
              )}
            />
            <Button type="submit" disabled={enviando} className="h-11 flex-1 rounded-lg sm:flex-none">
              <PackageCheck className="size-4" aria-hidden />
              {enviando ? "Conferindo…" : "Confirmar o que chegou"}
            </Button>
          </Form>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <BotaoRomaneio id={t.id} rotulo="Imprimir para conferir no papel" />
          </div>
        </>
      )}
    </article>
  )
}

function EmTransito({ transferencia: t }: { transferencia: TransferenciaListada }) {
  const navegacao = useNavigation()
  const enviando = navegacao.formData?.get("id") === t.id

  return (
    <article className="rounded-xl border border-border p-4">
      <CabecalhoDaTransferencia transferencia={t} />
      <ul className="mt-2 text-xs text-muted-foreground">
        {t.itens.map((i) => (
          <li key={i.produtoId}>
            {formatarQuantidade(i.enviada)} {i.unidade} · {i.descricao}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <BotaoRomaneio id={t.id} rotulo="Imprimir romaneio" />
        <Form method="post">
          <input type="hidden" name="intencao" value="cancelar" />
          <input type="hidden" name="id" value={t.id} />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={enviando}
            className="rounded-lg"
            title="A carga voltou: devolve tudo ao estoque desta loja"
          >
            <X className="size-4" aria-hidden /> Cancelar e devolver
          </Button>
        </Form>
      </div>
    </article>
  )
}

