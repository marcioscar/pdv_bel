import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { PackagePlus } from "lucide-react"

import type { Route } from "./+types/estoque"
import { BarraComando } from "~/components/pdv/barra-comando"
import { Topo } from "~/components/pdv/topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { db } from "~/lib/db.server"
import {
  movimentosRecentes,
  registrarAjuste,
  registrarEntrada,
  saldosPorProduto,
} from "~/lib/estoque.server"
import { exigirGerente, exigirUsuario } from "~/lib/sessao.server"
import { interpretarValor, quantidade as formatarQuantidade } from "~/lib/moeda"
import { ACOES_DE_GERENTE, ehGerente } from "~/lib/permissoes"
import {
  buscarProdutos,
  criarIndice,
  interpretarComando,
  produtosPorCodigo,
  type ProdutoCatalogo,
} from "~/lib/pdv"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export function meta(_: Route.MetaArgs) {
  return [{ title: "Estoque — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const [cadastro, saldos, movimentos] = await Promise.all([
    db.produto.findMany({ orderBy: { descricao: "asc" } }),
    saldosPorProduto(),
    movimentosRecentes(),
  ])

  return {
    eu,
    produtos: cadastro.map((produto) => ({
      ...produto,
      estoque: saldos.get(produto.id) ?? 0,
    })),
    movimentos,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData()
  const produtoId = String(form.get("produtoId") ?? "")
  const modo = String(form.get("modo") ?? "entrada")
  const valor = Number(form.get("valor"))

  // Entrada tem nota por trás e é trabalho de quem recebe mercadoria. Inventário
  // reescreve o saldo para o número que a pessoa diz ter contado — é por onde uma
  // falta desaparece sem deixar rastro, então fica com o gerente.
  const eu =
    modo === "ajuste"
      ? await exigirGerente(request, "inventario")
      : await exigirUsuario(request)

  if (!OBJECT_ID.test(produtoId)) {
    return data({ ok: false as const, erro: "Produto inválido" }, { status: 400 })
  }
  if (!Number.isFinite(valor)) {
    return data({ ok: false as const, erro: "Quantidade inválida" }, { status: 400 })
  }
  if (modo !== "entrada" && modo !== "ajuste") {
    return data({ ok: false as const, erro: "Operação inválida" }, { status: 400 })
  }

  const produto = await db.produto.findUnique({ where: { id: produtoId } })
  if (!produto) {
    return data({ ok: false as const, erro: "Produto não encontrado" }, { status: 400 })
  }

  if (modo === "entrada") {
    if (valor <= 0) {
      return data({ ok: false as const, erro: "A entrada deve ser positiva" }, { status: 400 })
    }
    await registrarEntrada(produtoId, valor, eu.nome)
    return {
      ok: true as const,
      mensagem: `Entrada de ${valor} ${produto.unidade} · ${produto.descricao}`,
    }
  }

  if (valor < 0) {
    return data({ ok: false as const, erro: "O saldo contado não pode ser negativo" }, { status: 400 })
  }

  const { diferenca } = await registrarAjuste(produtoId, valor, eu.nome)
  return {
    ok: true as const,
    mensagem:
      diferenca === 0
        ? `${produto.descricao} já estava com ${valor} ${produto.unidade}`
        : `Ajuste de ${diferenca > 0 ? "+" : ""}${diferenca} · ${produto.descricao} agora tem ${valor} ${produto.unidade}`,
  }
}

type Modo = "entrada" | "ajuste"

export default function Estoque({ loaderData }: Route.ComponentProps) {
  const { eu, produtos, movimentos } = loaderData
  const podeInventariar = ehGerente(eu.papel)

  const [entrada, setEntrada] = useState("")
  const [indiceResultado, setIndiceResultado] = useState(0)
  const [selecionado, setSelecionado] = useState<ProdutoCatalogo | null>(null)
  const [modo, setModo] = useState<Modo>("entrada")
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const campo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)
  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  const indice = useMemo(() => criarIndice(produtos), [produtos])
  const comando = useMemo(() => interpretarComando(entrada), [entrada])

  const resultados = useMemo(() => {
    if (selecionado) return []
    if (comando.tipo === "texto") return buscarProdutos(indice, comando.termo)
    if (comando.tipo === "codigo") {
      const achados = produtosPorCodigo(produtos, comando.codigo)
      return achados.length > 1 ? achados : []
    }
    return []
  }, [selecionado, comando, indice, produtos])

  useEffect(() => setIndiceResultado(0), [entrada])

  const focar = useCallback(() => campo.current?.focus(), [])
  useEffect(() => focar(), [focar, selecionado])

  const avisar = useCallback((texto: string, tipo: "erro" | "sucesso") => {
    setAviso({ texto, tipo })
  }, [])

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 5000)
    return () => clearTimeout(id)
  }, [aviso])

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data

    if (fetcher.data.ok) {
      avisar(fetcher.data.mensagem, "sucesso")
      setSelecionado(null)
      setEntrada("")
    } else {
      avisar(fetcher.data.erro, "erro")
    }
  }, [fetcher.state, fetcher.data, avisar])

  const confirmar = useCallback(() => {
    if (gravando) return

    // Primeiro passo: escolher o produto. Segundo: informar a quantidade.
    if (!selecionado) {
      if (comando.tipo === "vazio") return

      if (comando.tipo === "codigo") {
        const achados = produtosPorCodigo(produtos, comando.codigo)
        if (achados.length === 0) {
          setEntrada("")
          avisar(`Código ${comando.codigo} não encontrado`, "erro")
          return
        }
        const escolhido = achados.length === 1 ? achados[0] : achados[indiceResultado]
        if (escolhido) {
          setSelecionado(escolhido)
          setEntrada("")
        }
        return
      }

      const escolhido = resultados[indiceResultado]
      if (!escolhido) {
        avisar(`Nada encontrado para “${comando.termo}”`, "erro")
        return
      }
      setSelecionado(escolhido)
      setEntrada("")
      return
    }

    const valor = interpretarValor(entrada)
    if (valor === null) {
      avisar("Quantidade inválida", "erro")
      return
    }

    fetcher.submit(
      { produtoId: selecionado.id, modo, valor: String(valor) },
      { method: "post" }
    )
  }, [
    avisar,
    comando,
    entrada,
    fetcher,
    gravando,
    indiceResultado,
    modo,
    produtos,
    resultados,
    selecionado,
  ])

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      const { key, ctrlKey, shiftKey, altKey } = evento

      if (ctrlKey && !shiftKey && !altKey && key === "F6") {
        evento.preventDefault()
        alternar()
        return
      }

      // Ctrl+F1..F3 navegam (ver ~/lib/navegacao); o resto é sem modificador.
      if (ctrlKey || altKey || evento.metaKey) return

      switch (key) {
        case "Enter":
          evento.preventDefault()
          confirmar()
          return
        case "Escape":
          evento.preventDefault()
          if (selecionado) setSelecionado(null)
          setEntrada("")
          return
        case "F2":
          evento.preventDefault()
          setSelecionado(null)
          setEntrada("")
          return
        case "F4":
          evento.preventDefault()
          if (!podeInventariar) {
            avisar(ACOES_DE_GERENTE.inventario, "erro")
            return
          }
          setModo((atual) => (atual === "entrada" ? "ajuste" : "entrada"))
          return
      }

      if (selecionado || resultados.length === 0) return

      if (key === "ArrowDown" || key === "ArrowUp") {
        evento.preventDefault()
        const delta = key === "ArrowDown" ? 1 : -1
        setIndiceResultado((atual) =>
          Math.min(Math.max(atual + delta, 0), resultados.length - 1)
        )
      }
    }

    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [alternar, avisar, confirmar, podeInventariar, resultados.length, selecionado])

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      >
        <span>{produtos.length.toLocaleString("pt-BR")} produtos</span>
      </Topo>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {selecionado ? (
            <div className="flex items-center gap-3 border-b border-border bg-primary/5 px-5 py-3">
              <span className="shrink-0 text-sm font-semibold text-primary">
                {modo === "entrada" ? "Entrada de" : "Saldo contado de"}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {selecionado.descricao}
              </span>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {selecionado.unidade}
              </Badge>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                saldo atual {formatarQuantidade(selecionado.estoque)}
              </span>
            </div>
          ) : null}

          <BarraComando
            ref={campo}
            modo={selecionado ? "quantidade" : "busca"}
            valor={entrada}
            onValorChange={setEntrada}
            onBlur={() => requestAnimationFrame(focar)}
            resultados={resultados}
            indiceResultado={indiceResultado}
            onEscolherResultado={(i) => {
              setIndiceResultado(i)
              confirmar()
            }}
            multiplicador={1}
          />

          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="px-5 py-2.5 text-left font-semibold">
                    Quando
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                    Tipo
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                    Produto
                  </th>
                  <th scope="col" className="w-24 px-2 py-2.5 text-right font-semibold">
                    Qtd
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-left font-semibold">
                    Observação
                  </th>
                </tr>
              </thead>
              <tbody>
                {movimentos.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-16 text-center">
                      <PackagePlus
                        className="mx-auto size-10 text-muted-foreground/40"
                        aria-hidden
                      />
                      <p className="mt-3 text-sm text-muted-foreground">
                        Nenhum movimento ainda. Busque um produto e informe a quantidade.
                      </p>
                    </td>
                  </tr>
                ) : (
                  movimentos.map((movimento) => (
                    <tr key={movimento.id} className="border-b border-border">
                      <td className="px-5 py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                        {new Date(movimento.criadoEm).toLocaleString("pt-BR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge
                          variant={movimento.tipo === "venda" ? "outline" : "secondary"}
                          className="font-mono text-[10px]"
                        >
                          {movimento.tipo}
                        </Badge>
                      </td>
                      <td className="max-w-md px-2 py-2.5">
                        <span className="font-mono text-xs text-muted-foreground">
                          {movimento.codigo}
                        </span>{" "}
                        <span className="truncate">{movimento.descricao}</span>
                      </td>
                      <td
                        className={cn(
                          "px-2 py-2.5 text-right font-mono font-medium tabular-nums",
                          movimento.quantidade < 0 ? "text-destructive" : "text-foreground"
                        )}
                      >
                        {movimento.quantidade > 0 ? "+" : ""}
                        {formatarQuantidade(movimento.quantidade)}
                      </td>
                      <td className="px-5 py-2.5 text-xs text-muted-foreground">
                        {movimento.vendaNumero ? `venda #${movimento.vendaNumero} · ` : ""}
                        {movimento.observacao ?? ""}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                tabIndex={-1}
                variant={modo === "entrada" ? "default" : "outline"}
                size="sm"
                onClick={() => setModo("entrada")}
                className="rounded-lg"
              >
                Entrada
              </Button>
              {podeInventariar ? (
                <Button
                  type="button"
                  tabIndex={-1}
                  variant={modo === "ajuste" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setModo("ajuste")}
                  className="rounded-lg"
                >
                  Inventário
                </Button>
              ) : null}
              <span className="ml-1 text-xs text-muted-foreground">
                {podeInventariar ? (
                  <>
                    <Kbd>F4</Kbd> alterna ·{" "}
                    {modo === "entrada"
                      ? "soma ao saldo"
                      : "grava a diferença até o saldo contado"}
                  </>
                ) : (
                  "a entrada soma ao saldo · inventário é do gerente"
                )}
              </span>
            </div>

            {aviso ? (
              <span
                className={cn(
                  "text-xs font-medium",
                  aviso.tipo === "erro" ? "text-destructive" : "text-foreground"
                )}
                role="status"
              >
                {aviso.texto}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {gravando ? "gravando…" : "Busque o produto, Enter, quantidade, Enter"}
              </span>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
