import { useEffect, useMemo, useRef, useState } from "react"
import { data, useFetcher } from "react-router"
import { Check, Plus, ShoppingCart, UserSearch, Users } from "lucide-react"

import type { Route } from "./+types/admin.clientes"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { FormularioCliente } from "~/components/pdv/formulario-cliente"
import { formatarCep, formatarCpfCnpj } from "~/lib/documento"
import {
  alternarCliente,
  atualizarCliente,
  criarCliente,
  lerCliente,
  listarClientes,
} from "~/lib/clientes.server"
import { moeda, quantidade as formatarQuantidade } from "~/lib/moeda"
import { FORMAS_PAGAMENTO } from "~/lib/pdv"
import { exigirUsuario } from "~/lib/sessao.server"
import type { HistoricoDoCliente } from "~/routes/cliente.historico"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Clientes — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  // Cadastrar cliente é tarefa de operador — o boleto precisa do pagador, e quem
  // atende é quem tem os dados na mão.
  const eu = await exigirUsuario(request)
  // Inclui inativos: é esta a tela que os reativa.
  return {
    clientes: await listarClientes({ incluirInativos: true }),
    // A loja do turno: é ela que vai marcar o cadastro que nascer aqui.
    loja: eu.loja,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)

  const form = await request.formData()
  const id = String(form.get("id") ?? "")

  if (String(form.get("acao")) === "alternar") {
    const resultado = await alternarCliente(id)
    return resultado.ok
      ? { ok: true as const, mensagem: resultado.mensagem }
      : data({ ok: false as const, erro: resultado.erro, campo: null }, { status: 400 })
  }

  const entrada = lerCliente(form)

  const resultado = id
    ? await atualizarCliente(id, entrada)
    : await criarCliente(entrada, { loja: eu.loja })

  if (!resultado.ok) {
    return data(
      { ok: false as const, erro: resultado.erro, campo: resultado.campo ?? null },
      { status: 400 }
    )
  }

  return {
    ok: true as const,
    mensagem: `${resultado.cliente.nome} ${id ? "atualizado" : "cadastrado"}`,
  }
}

type Cliente = Awaited<ReturnType<typeof listarClientes>>[number]

function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

export default function AdminClientes({ loaderData }: Route.ComponentProps) {
  const { clientes, loja } = loaderData

  const [busca, setBusca] = useState("")
  const [mostrarInativos, setMostrarInativos] = useState(false)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  // `editando` guarda quem está no diálogo mesmo depois de fechar, para a
  // animação de saída não perder o conteúdo; `chave` remonta o formulário a cada
  // abertura, que é o que garante campos limpos sem um efeito de sincronia.
  const [aberto, setAberto] = useState(false)
  const [historico, setHistorico] = useState<Cliente | null>(null)
  const [editando, setEditando] = useState<Cliente | null>(null)
  const [chave, setChave] = useState(0)

  const campoBusca = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  const visiveis = useMemo(
    () => (mostrarInativos ? clientes : clientes.filter((c) => c.ativo)),
    [clientes, mostrarInativos]
  )
  const inativos = clientes.length - clientes.filter((c) => c.ativo).length

  const encontrados = useMemo(() => {
    const termo = normalizar(busca)
    const digitos = busca.replace(/\D/g, "")
    if (!termo) return visiveis

    return visiveis.filter(
      (c) =>
        normalizar(c.nome).includes(termo) ||
        normalizar(c.cidade).includes(termo) ||
        (digitos.length >= 3 && c.cpfCnpj.includes(digitos))
    )
  }, [busca, visiveis])

  useEffect(() => {
    if (!aberto) campoBusca.current?.focus()
  }, [aberto])

  useEffect(() => {
    if (!aviso) return
    const id = setTimeout(() => setAviso(null), 5000)
    return () => clearTimeout(id)
  }, [aviso])

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data
    setAviso(
      fetcher.data.ok
        ? { texto: fetcher.data.mensagem, tipo: "sucesso" }
        : { texto: fetcher.data.erro, tipo: "erro" }
    )
  }, [fetcher.state, fetcher.data])

  function abrir(cliente: Cliente | null) {
    setEditando(cliente)
    setChave((n) => n + 1)
    setAberto(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="shrink-0 text-base font-semibold">Clientes</h1>
        <Input
          ref={campoBusca}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          type="search"
          placeholder="Buscar por nome, cidade ou CPF/CNPJ…"
          aria-label="Buscar cliente"
          autoComplete="off"
          spellCheck={false}
          className="h-9 max-w-md rounded-lg"
        />
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {visiveis.length} {visiveis.length === 1 ? "cadastrado" : "cadastrados"}
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
          onClick={() => abrir(null)}
          className="ml-auto shrink-0 rounded-lg"
        >
          <Plus className="size-4" />
          Novo cliente
        </Button>
      </div>

      <Dialog open={historico !== null} onOpenChange={(estado) => !estado && setHistorico(null)}>
        {historico ? <DialogoHistorico cliente={historico} /> : null}
      </Dialog>

      <Dialog open={aberto} onOpenChange={(estado) => setAberto(estado)}>
        <DialogoCliente
          key={chave}
          cliente={editando}
          loja={loja}
          aoConcluir={(mensagem) => {
            setAviso({ texto: mensagem, tipo: "sucesso" })
            setAberto(false)
          }}
        />
      </Dialog>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="px-5 py-2.5 text-left font-semibold">Nome</th>
              <th scope="col" className="w-44 px-2 py-2.5 text-left font-semibold">
                CPF / CNPJ
              </th>
              <th scope="col" className="px-2 py-2.5 text-left font-semibold">Endereço</th>
              <th scope="col" className="w-40 px-2 py-2.5 text-left font-semibold">
                Cidade
              </th>
              <th scope="col" className="w-28 px-2 py-2.5 text-left font-semibold">
                Cadastro
              </th>
              <th scope="col" className="w-24 px-5 py-2.5 text-right font-semibold" />
            </tr>
          </thead>
          <tbody>
            {encontrados.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-16 text-center">
                  <UserSearch
                    className="mx-auto size-10 text-muted-foreground/40"
                    aria-hidden
                  />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {busca
                      ? `Nada encontrado para “${busca}”`
                      : "Nenhum cliente cadastrado. A venda a prazo precisa de um."}
                  </p>
                </td>
              </tr>
            ) : (
              encontrados.map((cliente) => (
                <tr
                  key={cliente.id}
                  className={cn(
                    "border-b border-border",
                    aberto && editando?.id === cliente.id && "bg-accent",
                    !cliente.ativo && "opacity-60"
                  )}
                >
                  <td className="px-5 py-2 font-medium">
                    {cliente.nome}
                    <Badge variant="outline" className="ml-2 text-[9px]">
                      {cliente.tipoPessoa === "JURIDICA" ? "PJ" : "PF"}
                    </Badge>
                    {!cliente.ativo ? (
                      <Badge variant="destructive" className="ml-1.5 text-[9px]">
                        inativo
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                    {formatarCpfCnpj(cliente.cpfCnpj)}
                    {cliente.inscricaoEstadual ? (
                      <span className="block text-[10px] opacity-70">
                        IE {cliente.inscricaoEstadual}
                      </span>
                    ) : null}
                  </td>
                  <td className="max-w-xs truncate px-2 py-2 text-xs text-muted-foreground">
                    {cliente.endereco}
                    {cliente.numero ? `, ${cliente.numero}` : ""} · {cliente.bairro} ·{" "}
                    {formatarCep(cliente.cep)}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {cliente.cidade}/{cliente.uf}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {/* Os cadastros anteriores a este campo não têm loja: melhor
                        o travessão do que fingir que foi a loja de quem olha. */}
                    {cliente.lojaCadastro ?? "—"}
                    <span className="block font-mono text-[10px] tabular-nums opacity-70">
                      {cliente.criadoEm.toLocaleDateString("pt-BR")}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      title="O que este cliente já comprou, na rede toda"
                      onClick={() => setHistorico(cliente)}
                    >
                      Histórico
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => abrir(cliente)}
                    >
                      Editar
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={gravando}
                      title={
                        cliente.ativo
                          ? "Sai do F6 do caixa; vendas antigas continuam intactas"
                          : "Volta a aparecer no caixa"
                      }
                      onClick={() =>
                        fetcher.submit(
                          { acao: "alternar", id: cliente.id },
                          { method: "post" }
                        )
                      }
                      className={cn(cliente.ativo && "text-destructive")}
                    >
                      {cliente.ativo ? "Desativar" : "Reativar"}
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
          O endereço aqui é o que vai no boleto — endereço incompleto faz o Inter
          recusar a cobrança · cliente não é apagado, é desativado
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

/**
 * O que este cliente já comprou.
 *
 * A pergunta que ele faz por telefone é sempre a mesma — "repete o último
 * pedido" —, e a resposta são os ITENS, não o valor. Por isso a compra abre
 * mostrando o que levou, e não um resumo financeiro.
 *
 * Carrega quando abre, e não junto com a lista: são as compras de UM cliente
 * que interessam, no momento em que alguém pergunta.
 */
function DialogoHistorico({ cliente }: { cliente: Cliente }) {
  const busca = useFetcher<HistoricoDoCliente>()
  const [aberta, setAberta] = useState<string | null>(null)

  const carregar = busca.load
  useEffect(() => {
    carregar(`/clientes/${cliente.id}/historico`)
  }, [carregar, cliente.id])

  const compras = busca.data?.compras ?? []
  const carregando = busca.state !== "idle" && !busca.data

  // Só o que valeu: venda cancelada não conta como compra, mas continua na
  // lista — quem pergunta pelo pedido antigo precisa saber se ele foi desfeito.
  const validas = compras.filter((compra) => !compra.canceladaEm)
  const gasto = validas.reduce((total, compra) => total + compra.total, 0)

  return (
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{cliente.nome}</DialogTitle>
        <DialogDescription>
          {carregando
            ? "Buscando as compras…"
            : compras.length === 0
              ? "Este cliente ainda não comprou nada com o cadastro vinculado."
              : `${validas.length} ${validas.length === 1 ? "compra" : "compras"} · ${moeda(gasto)} · da rede toda, da mais recente para a mais antiga`}
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[60vh] overflow-y-auto">
        {compras.map((compra) => {
          const cancelada = Boolean(compra.canceladaEm)
          const detalhando = aberta === compra.id

          return (
            <div key={compra.id} className="border-b border-border last:border-0">
              <button
                type="button"
                onClick={() => setAberta(detalhando ? null : compra.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-1 py-2.5 text-left text-sm transition-colors hover:bg-muted/60",
                  cancelada && "opacity-60"
                )}
              >
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {new Date(compra.criadaEm).toLocaleDateString("pt-BR")}
                </span>
                <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                  {compra.loja}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {compra.itens.length === 1
                    ? compra.itens[0].descricao
                    : `${compra.itens.length} itens · ${compra.itens[0]?.descricao ?? ""}`}
                </span>
                {cancelada ? (
                  <Badge variant="destructive" className="shrink-0 text-[9px]">
                    cancelada
                  </Badge>
                ) : null}
                <span
                  className={cn(
                    "shrink-0 font-mono text-xs tabular-nums",
                    cancelada && "line-through"
                  )}
                >
                  {moeda(compra.total)}
                </span>
              </button>

              {detalhando ? (
                <div className="mb-2 rounded-lg bg-muted/40 px-3 py-2">
                  <div className="mb-1.5 flex justify-end">
                    {/*
                      O caminho de volta ao balcão: o cliente pediu "o de
                      sempre", e daqui sai o carrinho pronto. Os preços são os de
                      hoje e o desconto não vem junto — o pedido é o mesmo, o
                      acordo daquele dia não.
                    */}
                    <a
                      href={`/?repetir=${compra.id}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-background"
                    >
                      <ShoppingCart className="size-3.5" aria-hidden />
                      Repetir no caixa
                    </a>
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {compra.itens.map((item, i) => (
                        <tr key={`${item.codigo}-${i}`}>
                          <td className="py-1 pr-2 font-mono tabular-nums text-muted-foreground">
                            {formatarQuantidade(item.quantidade)} {item.unidade}
                          </td>
                          <td className="py-1 pr-2">{item.descricao}</td>
                          <td className="py-1 pr-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                            cód. {item.codigo}
                          </td>
                          <td className="py-1 text-right font-mono tabular-nums">
                            {moeda(item.subtotal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Venda #{compra.numero} ·{" "}
                    {FORMAS_PAGAMENTO.find((f) => f.id === compra.forma)?.rotulo ?? compra.forma}
                    {compra.desconto > 0 ? ` · desconto ${moeda(compra.desconto)}` : ""}
                    {compra.vendedorNome ? ` · ${compra.vendedorNome}` : ""}
                  </p>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <DialogFooter className="sm:justify-between">
        <span className="text-xs text-muted-foreground">
          Clique numa compra para ver o que ele levou
        </span>
        <DialogClose render={<Button type="button" variant="outline" />}>Fechar</DialogClose>
      </DialogFooter>
    </DialogContent>
  )
}

/**
 * O formulário mora num componente à parte, com estado próprio, e é remontado a
 * cada abertura. Antes ele era um painel na própria tela e o estado do cadastro
 * vivia junto com o da lista: o efeito que dava foco no primeiro campo dependia
 * do objeto do formulário e, como cada tecla criava um objeto novo, o foco
 * voltava para o Nome a cada caractere digitado em qualquer outro campo.
 *
 * Os campos vêm de ~/components/pdv/formulario-cliente, os mesmos que o F6 do
 * caixa abre. Aqui fica só o que é desta tela: o diálogo, a gravação e o
 * registro de onde o cadastro veio.
 */
function DialogoCliente({
  cliente,
  loja,
  aoConcluir,
}: {
  cliente: Cliente | null
  loja: string
  aoConcluir: (mensagem: string) => void
}) {
  const [erro, setErro] = useState<string | null>(null)

  const primeiroCampo = useRef<HTMLInputElement>(null)
  const ultimaResposta = useRef<unknown>(null)

  const fetcher = useFetcher<typeof action>()
  const gravando = fetcher.state !== "idle"

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    if (ultimaResposta.current === fetcher.data) return
    ultimaResposta.current = fetcher.data

    if (fetcher.data.ok) aoConcluir(fetcher.data.mensagem)
    else setErro(fetcher.data.erro)
  }, [fetcher.state, fetcher.data, aoConcluir])

  return (
    <DialogContent className="sm:max-w-3xl" initialFocus={primeiroCampo}>
      <DialogHeader>
        <DialogTitle>{cliente ? "Editar cliente" : "Novo cliente"}</DialogTitle>
        <DialogDescription>
          Comece pelo documento: com o CNPJ a Receita preenche o resto, e o CEP
          completa o endereço. Tudo o que está aqui é o que vai no boleto.
        </DialogDescription>
      </DialogHeader>

      <FormularioCliente
        cliente={cliente}
        gravando={gravando}
        erro={erro}
        primeiroCampo={primeiroCampo}
        aoSalvar={(dados) => {
          setErro(null)
          fetcher.submit({ ...dados, id: cliente?.id ?? "" }, { method: "post" })
        }}
        rodape={(salvar) => (
          <div className="flex flex-col-reverse items-center gap-2 sm:flex-row sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {cliente
                ? cliente.lojaCadastro
                  ? `Cadastrado em ${cliente.lojaCadastro} · ${cliente.criadoEm.toLocaleDateString("pt-BR")}`
                  : `Cadastrado em ${cliente.criadoEm.toLocaleDateString("pt-BR")}`
                : `Vai ficar registrado como cadastro da loja ${loja}`}
            </span>
            <div className="flex gap-2">
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="button" disabled={gravando} onClick={salvar}>
                <Check className="size-4" />
                {gravando ? "Salvando…" : cliente ? "Salvar" : "Cadastrar"}
              </Button>
            </div>
          </div>
        )}
      />
    </DialogContent>
  )
}
