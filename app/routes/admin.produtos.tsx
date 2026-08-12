import { useEffect, useMemo, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { Check, Package, PackageSearch, Plus, X } from "lucide-react"

import type { Route } from "./+types/admin.produtos"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { db } from "~/lib/db.server"
import { saldosPorProduto } from "~/lib/estoque.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { buscarProdutos, criarIndice } from "~/lib/pdv"
import {
  alternarProduto,
  atualizarProduto,
  codigosRepetidos,
  criarProduto,
  lerProduto,
} from "~/lib/produtos.server"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Produtos — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  // O layout de /admin já cobra o papel; aqui é explícito porque a action
  // também precisa, e é preço — dinheiro — que se edita nesta tela.
  const eu = await exigirGerente(request, "editarProdutos")

  // Aqui vêm os inativos também: esta é a tela que os reativa.
  const [cadastro, saldos, repetidos] = await Promise.all([
    db.produto.findMany({ orderBy: { descricao: "asc" } }),
    // O saldo mostrado é o da loja em que o gerente está — o catálogo é da rede,
    // o estoque é da prateleira.
    saldosPorProduto(eu.loja),
    codigosRepetidos(),
  ])

  return {
    loja: eu.loja,
    produtos: cadastro.map((produto) => ({
      ...produto,
      estoque: saldos.get(produto.id) ?? 0,
      codigoRepetido: repetidos.has(produto.codigo),
    })),
  }
}

export async function action({ request }: Route.ActionArgs) {
  await exigirGerente(request, "editarProdutos")

  const form = await request.formData()

  if (String(form.get("acao")) === "alternar") {
    const resultado = await alternarProduto(String(form.get("id") ?? ""))
    return resultado.ok
      ? { ok: true as const, mensagem: resultado.mensagem, id: null }
      : data({ ok: false as const, erro: resultado.erro }, { status: 400 })
  }

  const lido = lerProduto(form)
  if ("erro" in lido) {
    return data({ ok: false as const, erro: lido.erro }, { status: 400 })
  }

  const id = String(form.get("id") ?? "")
  const resultado = id ? await atualizarProduto(id, lido) : await criarProduto(lido)

  if (!resultado.ok) {
    return data({ ok: false as const, erro: resultado.erro }, { status: 400 })
  }

  return {
    ok: true as const,
    mensagem: `${resultado.produto.descricao} ${id ? "atualizado" : "cadastrado"}`,
    id: resultado.produto.id,
  }
}

type EmEdicao = {
  id: string | null
  codigo: string
  descricao: string
  unidade: string
  preco: string
}

const NOVO: EmEdicao = { id: null, codigo: "", descricao: "", unidade: "", preco: "" }

export default function AdminProdutos({ loaderData }: Route.ComponentProps) {
  const { produtos } = loaderData

  const [busca, setBusca] = useState("")
  const [mostrarInativos, setMostrarInativos] = useState(false)
  const [edicao, setEdicao] = useState<EmEdicao | null>(null)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const campoBusca = useRef<HTMLInputElement>(null)
  const primeiroCampo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)
  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  const visiveis = useMemo(
    () => (mostrarInativos ? produtos : produtos.filter((p) => p.ativo)),
    [mostrarInativos, produtos]
  )
  const indice = useMemo(() => criarIndice(visiveis), [visiveis])

  const encontrados = useMemo(() => {
    if (!busca.trim()) return visiveis.slice(0, 50)
    // O índice devolve ProdutoCatalogo; recuperamos a linha completa pelo id.
    const achados = buscarProdutos(indice, busca, 50)
    const porId = new Map(visiveis.map((p) => [p.id, p]))
    return achados.map((a) => porId.get(a.id)!).filter(Boolean)
  }, [busca, indice, visiveis])

  const inativos = produtos.length - produtos.filter((p) => p.ativo).length

  useEffect(() => {
    if (edicao) primeiroCampo.current?.focus()
    else campoBusca.current?.focus()
  }, [edicao])

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
      setAviso({ texto: fetcher.data.mensagem, tipo: "sucesso" })
      setEdicao(null)
    } else {
      setAviso({ texto: fetcher.data.erro, tipo: "erro" })
    }
  }, [fetcher.state, fetcher.data])

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.ctrlKey || evento.altKey || evento.metaKey) return
      if (evento.key === "Escape" && edicao) {
        evento.preventDefault()
        setEdicao(null)
      }
    }
    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [edicao])

  function salvar() {
    if (!edicao || gravando) return
    fetcher.submit(
      {
        id: edicao.id ?? "",
        codigo: edicao.codigo,
        descricao: edicao.descricao,
        unidade: edicao.unidade,
        preco: edicao.preco,
      },
      { method: "post" }
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Package className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Produtos</h1>
        <Input
          ref={campoBusca}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por código ou descrição…"
          aria-label="Buscar produto"
          autoComplete="off"
          spellCheck={false}
          className="h-9 max-w-md rounded-lg"
        />
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {visiveis.length.toLocaleString("pt-BR")} no catálogo
        </span>
        {inativos > 0 ? (
          <Button
            type="button"
            variant={mostrarInativos ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setMostrarInativos((v) => !v)}
            className="shrink-0 rounded-lg"
          >
            {mostrarInativos ? "Ocultar" : "Mostrar"} {inativos}{" "}
            {inativos === 1 ? "inativo" : "inativos"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={() => setEdicao(NOVO)}
          className="ml-auto shrink-0 rounded-lg"
        >
          <Plus className="size-4" />
          Novo produto
        </Button>
      </div>

      {edicao ? (
        <div className="grid grid-cols-12 items-end gap-3 border-b border-border bg-primary/5 px-5 py-3">
          <CampoEdicao
            ref={primeiroCampo}
            rotulo="Código"
            valor={edicao.codigo}
            onChange={(v) => setEdicao({ ...edicao, codigo: v })}
            className="col-span-2"
          />
          <CampoEdicao
            rotulo="Descrição"
            valor={edicao.descricao}
            onChange={(v) => setEdicao({ ...edicao, descricao: v })}
            className="col-span-5"
          />
          <CampoEdicao
            rotulo="Unidade"
            valor={edicao.unidade}
            onChange={(v) => setEdicao({ ...edicao, unidade: v })}
            className="col-span-1"
          />
          <CampoEdicao
            rotulo="Preço"
            valor={edicao.preco}
            onChange={(v) => setEdicao({ ...edicao, preco: v })}
            onEnter={salvar}
            className="col-span-2"
          />
          <div className="col-span-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={gravando}
              onClick={salvar}
              className="rounded-lg"
            >
              <Check className="size-4" />
              {gravando ? "Salvando…" : "Salvar"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEdicao(null)}
              className="rounded-lg"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="w-24 px-5 py-2.5 text-left font-semibold">
                Código
              </th>
              <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                Descrição
              </th>
              <th scope="col" className="w-16 px-2 py-2.5 text-left font-semibold">
                Un
              </th>
              <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">
                Preço
              </th>
              <th scope="col" className="w-24 px-2 py-2.5 text-right font-semibold">
                Saldo
              </th>
              <th scope="col" className="w-24 px-5 py-2.5 text-right font-semibold" />
            </tr>
          </thead>
          <tbody>
            {encontrados.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-16 text-center">
                  <PackageSearch
                    className="mx-auto size-10 text-muted-foreground/40"
                    aria-hidden
                  />
                  <p className="mt-3 text-sm text-muted-foreground">
                    Nada encontrado para “{busca}”
                  </p>
                </td>
              </tr>
            ) : (
              encontrados.map((produto) => (
                <tr
                  key={produto.id}
                  className={cn(
                    "border-b border-border",
                    edicao?.id === produto.id && "bg-accent",
                    !produto.ativo && "opacity-60"
                  )}
                >
                  <td className="px-5 py-2 font-mono text-xs tabular-nums">
                    {produto.codigo}
                    {!produto.ativo ? (
                      <Badge variant="destructive" className="ml-1.5 text-[9px]">
                        inativo
                      </Badge>
                    ) : null}
                    {produto.codigoRepetido ? (
                      <Badge
                        variant="outline"
                        className="ml-1.5 text-[9px]"
                        title="Outro produto usa o mesmo código; o caixa pede para escolher"
                      >
                        repetido
                      </Badge>
                    ) : null}
                  </td>
                  <td className="max-w-md px-2 py-2">{produto.descricao}</td>
                  <td className="px-2 py-2">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {produto.unidade}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 text-right font-mono font-medium tabular-nums">
                    {moeda(produto.preco)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right font-mono text-xs tabular-nums",
                      produto.estoque <= 0 ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {produto.estoque <= 0 ? "0" : formatarQuantidade(produto.estoque)}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        setEdicao({
                          id: produto.id,
                          codigo: produto.codigo,
                          descricao: produto.descricao,
                          unidade: produto.unidade,
                          // Vírgula, como se digita — interpretarValor aceita as duas.
                          preco: produto.preco.toFixed(2).replace(".", ","),
                        })
                      }
                    >
                      Editar
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={gravando}
                      title={
                        produto.ativo
                          ? "Sai do caixa e das buscas; o histórico continua"
                          : "Volta a aparecer no caixa"
                      }
                      onClick={() =>
                        fetcher.submit(
                          { acao: "alternar", id: produto.id },
                          { method: "post" }
                        )
                      }
                      className={cn(produto.ativo && "text-destructive")}
                    >
                      {produto.ativo ? "Desativar" : "Reativar"}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs">
        <span className="text-muted-foreground">
          Mostrando {encontrados.length} · <Kbd>Esc</Kbd> cancela a edição · alterar o
          preço aqui não muda venda já registrada · produto não é apagado, é
          desativado — o histórico depende dele
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

function CampoEdicao({
  ref,
  rotulo,
  valor,
  onChange,
  onEnter,
  className,
}: {
  ref?: React.Ref<HTMLInputElement>
  rotulo: string
  valor: string
  onChange: (valor: string) => void
  onEnter?: () => void
  className?: string
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </label>
      <Input
        ref={ref}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
        autoComplete="off"
        spellCheck={false}
        className="h-9 rounded-lg"
      />
    </div>
  )
}
