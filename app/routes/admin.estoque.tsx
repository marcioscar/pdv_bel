import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { PackagePlus } from "lucide-react"

import type { Route } from "./+types/admin.estoque"
import { BarraComando } from "~/components/pdv/barra-comando"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { db } from "~/lib/db.server"
import {
  movimentosRecentes,
  registrarAjuste,
  registrarEntrada,
  registrarUso,
  saldosPorProduto,
} from "~/lib/estoque.server"
import { SOMENTE_ATIVOS } from "~/lib/produtos.server"
import { exigirGerente } from "~/lib/sessao.server"
import {
  interpretarValor,
  QUANTIDADE_INTEIRA,
  quantidade as formatarQuantidade,
} from "~/lib/moeda"
import { ACOES_DE_GERENTE, ehGerente } from "~/lib/permissoes"
import {
  buscarProdutos,
  criarIndice,
  interpretarComando,
  produtosPorCodigo,
  type ProdutoCatalogo,
} from "~/lib/pdv"
import { cn } from "~/lib/utils"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export function meta(_: Route.MetaArgs) {
  return [{ title: "Entradas e inventário — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  // O layout de /admin já barra o operador, mas os loaders rodam em paralelo
  // com o dele: a tela cobra a própria guarda.
  const eu = await exigirGerente(request, "entradaManual")

  const [cadastro, saldos, movimentos] = await Promise.all([
    db.produto.findMany({ where: SOMENTE_ATIVOS, orderBy: { descricao: "asc" } }),
    saldosPorProduto(eu.loja),
    movimentosRecentes(eu.loja),
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

  // Os três são do gerente. Inventário reescreve o saldo para o número que a
  // pessoa diz ter contado — é por onde uma falta desaparece sem rastro. A baixa
  // de uso tira do saldo sem venda e sem documento. E a entrada manual cria
  // estoque sem nota nem remessa: aberta ao operador, destravava venda de
  // produto sem saldo e deixava o estoque sem ninguém para conferir.
  const eu =
    modo === "ajuste"
      ? await exigirGerente(request, "inventario")
      : modo === "uso"
        ? await exigirGerente(request, "baixaDeUso")
        : await exigirGerente(request, "entradaManual")

  if (!OBJECT_ID.test(produtoId)) {
    return data({ ok: false as const, erro: "Produto inválido" }, { status: 400 })
  }
  if (!Number.isFinite(valor)) {
    return data({ ok: false as const, erro: "Quantidade inválida" }, { status: 400 })
  }
  // Vale para os três modos: entrada, uso e o saldo contado no inventário.
  if (!Number.isInteger(valor)) {
    return data({ ok: false as const, erro: QUANTIDADE_INTEIRA }, { status: 400 })
  }
  if (modo !== "entrada" && modo !== "ajuste" && modo !== "uso") {
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
    await registrarEntrada(produtoId, eu.loja, valor, eu.nome)
    return {
      ok: true as const,
      mensagem: `Entrada de ${valor} ${produto.unidade} · ${produto.descricao}`,
    }
  }

  if (modo === "uso") {
    const motivo = String(form.get("motivo") ?? "")
    const resultado = await registrarUso(produtoId, eu.loja, valor, eu.nome, motivo)
    if (!resultado.ok) {
      return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
    }
    return {
      ok: true as const,
      mensagem: `Uso da loja: ${valor} ${produto.unidade} · ${produto.descricao} · restam ${resultado.saldo}`,
    }
  }

  if (valor < 0) {
    return data({ ok: false as const, erro: "O saldo contado não pode ser negativo" }, { status: 400 })
  }

  const { diferenca } = await registrarAjuste(produtoId, eu.loja, valor, eu.nome)
  return {
    ok: true as const,
    mensagem:
      diferenca === 0
        ? `${produto.descricao} já estava com ${valor} ${produto.unidade}`
        : `Ajuste de ${diferenca > 0 ? "+" : ""}${diferenca} · ${produto.descricao} agora tem ${valor} ${produto.unidade}`,
  }
}

type Modo = "entrada" | "ajuste" | "uso"

/** A ordem que o F4 percorre. Entrada primeiro: é o que se faz todo dia. */
const MODOS_DO_GERENTE: Modo[] = ["entrada", "ajuste", "uso"]

const ROTULO_DO_MODO: Record<Modo, string> = {
  entrada: "Entrada de",
  ajuste: "Saldo contado de",
  uso: "Uso da loja —",
}

export default function Estoque({ loaderData }: Route.ComponentProps) {
  const { eu, produtos, movimentos } = loaderData
  const podeInventariar = ehGerente(eu.papel)

  const [entrada, setEntrada] = useState("")
  const [indiceResultado, setIndiceResultado] = useState(0)
  const [selecionado, setSelecionado] = useState<ProdutoCatalogo | null>(null)
  const [modo, setModo] = useState<Modo>("entrada")
  // A quantidade já informada na baixa de uso, enquanto se digita o motivo. É o
  // que separa os dois passos: com ela preenchida, a barra pede o para quê.
  const [quantidadeUso, setQuantidadeUso] = useState<number | null>(null)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const campo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)
  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

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

  // Trocar de modo ou de produto recomeça a baixa: a quantidade digitada era
  // daquele produto naquele modo, e carregá-la adiante lançaria outra coisa.
  useEffect(() => setQuantidadeUso(null), [modo, selecionado])

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
      setQuantidadeUso(null)
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

    // Terceiro passo, só na baixa de uso: o para quê. Vem depois da quantidade
    // porque é o campo que se pode esquecer, e esquecê-lo aqui trava o envio em
    // vez de gravar uma saída sem explicação.
    if (modo === "uso" && quantidadeUso !== null) {
      const motivo = entrada.trim()
      if (!motivo) {
        avisar("Diga para que é a saída — balcão, limpeza, amostra…", "erro")
        return
      }
      fetcher.submit(
        {
          produtoId: selecionado.id,
          modo,
          valor: String(quantidadeUso),
          motivo,
        },
        { method: "post" }
      )
      return
    }

    const valor = interpretarValor(entrada)
    if (valor === null) {
      avisar("Quantidade inválida", "erro")
      return
    }
    if (!Number.isInteger(valor)) {
      avisar(QUANTIDADE_INTEIRA, "erro")
      return
    }

    if (modo === "uso") {
      if (valor <= 0) {
        avisar("A quantidade deve ser positiva", "erro")
        return
      }
      if (valor > selecionado.estoque) {
        avisar(
          selecionado.estoque <= 0
            ? "Não há saldo desse produto nesta loja"
            : `Há só ${formatarQuantidade(selecionado.estoque)} ${selecionado.unidade} nesta loja`,
          "erro"
        )
        return
      }
      setQuantidadeUso(valor)
      setEntrada("")
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
    quantidadeUso,
    resultados,
    selecionado,
  ])

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      const { key, ctrlKey, altKey } = evento

      // Ctrl+F1..F3 navegam e Ctrl+F6 troca o tema, tratados no layout de admin
      // e em ~/lib/navegacao. Aqui só as teclas sem modificador.
      if (ctrlKey || altKey || evento.metaKey) return

      switch (key) {
        case "Enter":
          evento.preventDefault()
          confirmar()
          return
        case "Escape":
          evento.preventDefault()
          // Um passo de cada vez: no meio da baixa de uso, Esc volta para a
          // quantidade em vez de jogar fora o produto já escolhido.
          if (quantidadeUso !== null) {
            setQuantidadeUso(null)
            setEntrada("")
            return
          }
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
          setModo((atual) => {
            const i = MODOS_DO_GERENTE.indexOf(atual)
            return MODOS_DO_GERENTE[(i + 1) % MODOS_DO_GERENTE.length]
          })
          setEntrada("")
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
  }, [avisar, confirmar, podeInventariar, quantidadeUso, resultados.length, selecionado])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <PackagePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">
          {podeInventariar ? "Entradas e inventário" : "Entrada de mercadoria"}
        </h1>

      </div>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {selecionado ? (
            <div className="flex items-center gap-3 border-b border-border bg-primary/5 px-5 py-3">
              <span className="shrink-0 text-sm font-semibold text-primary">
                {ROTULO_DO_MODO[modo]}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {selecionado.descricao}
              </span>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {selecionado.unidade}
              </Badge>
              {quantidadeUso !== null ? (
                <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                  −{formatarQuantidade(quantidadeUso)}
                </Badge>
              ) : null}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                saldo atual {formatarQuantidade(selecionado.estoque)}
              </span>
            </div>
          ) : null}

          <BarraComando
            ref={campo}
            modo={
              !selecionado
                ? "busca"
                : quantidadeUso !== null
                  ? "motivo"
                  : "quantidade"
            }
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
                <>
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
                  <Button
                    type="button"
                    tabIndex={-1}
                    variant={modo === "uso" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setModo("uso")}
                    className="rounded-lg"
                  >
                    Uso da loja
                  </Button>
                </>
              ) : null}
              <span className="ml-1 text-xs text-muted-foreground">
                {podeInventariar ? (
                  <>
                    <Kbd>F4</Kbd> alterna ·{" "}
                    {modo === "entrada"
                      ? "soma ao saldo"
                      : modo === "ajuste"
                        ? "grava a diferença até o saldo contado"
                        : "sai do saldo sem venda — a sacola do balcão, o papel da limpeza"}
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
                {gravando
                  ? "gravando…"
                  : modo === "uso"
                    ? "Busque o produto, Enter, quantidade, Enter, o para quê, Enter"
                    : "Busque o produto, Enter, quantidade, Enter"}
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
