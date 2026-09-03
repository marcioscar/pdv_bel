import { useCallback, useEffect, useRef, useState } from "react"
import { data, useFetcher, useRevalidator, useSearchParams } from "react-router"
import { FileText, Loader2, Printer, Receipt } from "lucide-react"

import type { Route } from "./+types/vendas"
import { Topo } from "~/components/pdv/topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { imprimirDocumento } from "~/lib/impressao"
import { db } from "~/lib/db.server"
import { CobrancaDialogo } from "~/components/pdv/cobranca-dialogo"
import { ItensDaVenda, SituacaoCobrancas } from "~/components/pdv/venda-celulas"
import {
  cancelarCobrancasDaVenda,
  cobrancasDaVenda,
  emitirParaVenda,
  type CobrancaDaVenda,
} from "~/lib/cobranca.server"
import { cancelarVenda } from "~/lib/estoque.server"
import { focusConfigurada, urlDoArquivo } from "~/lib/focus.server"
import { modeloDaVenda } from "~/lib/fiscal"
import {
  atualizarStatusDaNota,
  desfazerNotaDaVenda,
  emitirDaVenda,
  notasPendentes,
} from "~/lib/nota-fiscal.server"
import { exigirGerente, exigirUsuario } from "~/lib/sessao.server"
import { consultarVendas, lerFiltroVendas, type FiltroVendas } from "~/lib/vendas.server"
import { vendedoresDaLoja } from "~/lib/vendedores.server"
import { Atalho, Campo, ESTILO_CAMPO, Pagina } from "~/components/pdv/filtros"
import { diaAtras, diaDeHoje, PRIMEIRO_DIA } from "~/lib/dia"
import { Input } from "~/components/ui/input"
import { moeda } from "~/lib/moeda"
import { ACOES_DE_GERENTE, ehGerente } from "~/lib/permissoes"
import { FORMAS_PAGAMENTO } from "~/lib/pdv"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export function meta(_: Route.MetaArgs) {
  return [{ title: "Vendas — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  /**
   * Só as vendas DESTA loja, e a trava é passar a loja da sessão como a única
   * permitida: daí `?loja=` na barra de endereço não tem o que escolher, em vez
   * de depender de alguém lembrar de filtrar na consulta.
   */
  const filtro = lerFiltroVendas(new URL(request.url), [eu.loja])
  const [consulta, vendedores] = await Promise.all([
    consultarVendas(filtro),
    vendedoresDaLoja(eu.loja),
  ])

  /*
   * A nota é assíncrona: sai daqui "processando" e a SEFAZ responde depois. Sem
   * perguntar de novo ao abrir a tela, uma nota autorizada continuaria aparecendo
   * como pendente para sempre. Só as pendentes, e em paralelo — Focus fora do ar
   * não pode impedir a tela de abrir.
   */
  const pendentes = await notasPendentes(eu.loja)
  if (pendentes.length > 0) {
    await Promise.all(pendentes.map((nota) => atualizarStatusDaNota(nota.id)))
  }

  const emitidas = await db.notaFiscalEmitida.findMany({
    where: { vendaId: { in: consulta.vendas.map((venda) => venda.id) } },
    orderBy: { criadaEm: "desc" },
  })

  const notas: Record<string, {
    modelo: string
    status: string
    numero: string | null
    caminhoDanfe: string | null
    erro: string | null
  }> = {}
  for (const nota of emitidas) {
    if (!nota.vendaId || notas[nota.vendaId]) continue
    notas[nota.vendaId] = {
      modelo: nota.modelo,
      status: nota.status,
      numero: nota.numero,
      // Normaliza na leitura também: as notas gravadas antes de o endereço virar
      // absoluto continuariam apontando para o próprio PDV.
      caminhoDanfe: urlDoArquivo(nota.caminhoDanfe),
      erro: nota.erro,
    }
  }

  return {
    eu,
    filtro,
    vendedores,
    notas,
    // A tela só oferece emitir onde faz sentido: loja habilitada e Focus com
    // token. Sem isso, o botão prometeria o que não pode cumprir.
    podeEmitirNota: focusConfigurada() && Boolean(await lojaEmite(eu.loja)),
    ...consulta,
  }
}

async function lojaEmite(codigo: string) {
  const loja = await db.loja.findUnique({
    where: { codigo },
    select: { emiteNotaFiscal: true },
  })
  return loja?.emiteNotaFiscal ?? false
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData()
  const vendaId = String(form.get("vendaId") ?? "")
  const acao = String(form.get("acao") ?? "")

  // Ver/emitir cobrança é operação de turno; cancelar desfaz faturamento e
  // estorna estoque, então é do gerente. A guarda vem antes de qualquer trabalho.
  // Emitir nota e ver cobrança são operação de turno; cancelar desfaz
  // faturamento, e por isso continua sendo do gerente.
  const eu =
    acao === "cobranca" || acao === "nota"
      ? await exigirUsuario(request)
      : await exigirGerente(request, "cancelarVenda")

  if (!OBJECT_ID.test(vendaId)) {
    return data(
      { ok: false as const, tipo: "cancelamento" as const, erro: "Venda inválida" },
      { status: 400 }
    )
  }

  if (acao === "nota") {
    const resultado = await emitirDaVenda(vendaId, { emitidaPor: eu.nome })
    return resultado.ok
      ? {
          ok: true as const,
          tipo: "nota" as const,
          mensagem:
            resultado.status === "autorizado"
              ? `${resultado.modelo.toUpperCase()} autorizada`
              : `${resultado.modelo.toUpperCase()} enviada — aguardando a SEFAZ`,
        }
      : data(
          { ok: false as const, tipo: "nota" as const, erro: resultado.erro },
          { status: 400 }
        )
  }

  // Ver/emitir a cobrança de uma venda a prazo.
  if (acao === "cobranca") {
    try {
      const venda = await db.venda.findUnique({
        where: { id: vendaId },
        select: { canceladaEm: true, loja: true },
      })
      if (venda && venda.loja !== eu.loja) {
        return data(
          { ok: false as const, tipo: "cobranca" as const, erro: `Venda de outra loja (${venda.loja})` },
          { status: 400 }
        )
      }

      return {
        ok: true as const,
        tipo: "cobranca" as const,
        // `emitirParaVenda` é idempotente: devolve o que já existe sem chamar o
        // Inter e emite só o que falta — o que cobre um parcelamento cuja emissão
        // parou no meio. Venda cancelada não emite, mas ver o que já saiu vale.
        cobrancas: venda?.canceladaEm
          ? await cobrancasDaVenda(vendaId)
          : await emitirParaVenda(vendaId),
      }
    } catch (erro) {
      return data(
        {
          ok: false as const,
          tipo: "cobranca" as const,
          erro: erro instanceof Error ? erro.message : "Falha ao emitir a cobrança",
        },
        { status: 400 }
      )
    }
  }

  /*
   * A nota vem primeiro, pelo mesmo motivo do boleto: desfazer a venda com a
   * nota de pé deixaria um documento fiscal sem venda, e isso não aparece em
   * tela nenhuma — só na apuração do contador.
   *
   * Recusa da SEFAZ interrompe o cancelamento inteiro. Quase sempre é prazo
   * vencido, e aí a nota é fato consumado: o caminho é uma nota de devolução,
   * não um botão que apaga a venda e deixa o documento valendo.
   */
  const numeroDaVenda = await db.venda.findUnique({
    where: { id: vendaId },
    select: { numero: true },
  })
  const nota = await desfazerNotaDaVenda(
    vendaId,
    `Cancelamento da venda ${numeroDaVenda?.numero ?? ""} no PDV por ${eu.nome}`.trim()
  )
  if (!nota.ok) {
    return data(
      { ok: false as const, tipo: "cancelamento" as const, erro: nota.erro },
      { status: 400 }
    )
  }

  // O boleto é cancelado no Inter ANTES de a venda ser desfeita aqui. Na ordem
  // inversa, uma falha no banco deixaria um boleto vivo numa venda cancelada — e
  // isso não aparece em nenhuma tela. Falhando assim, a venda segue ativa, e a
  // cobrança cancelada aparece como CANCELADO na lista: visível e recuperável.
  const cobrancas = await cancelarCobrancasDaVenda(vendaId)
  if (!cobrancas.ok) {
    return data(
      { ok: false as const, tipo: "cancelamento" as const, erro: cobrancas.erro },
      { status: 400 }
    )
  }

  const resultado = await cancelarVenda(vendaId, eu.loja, eu.nome)
  if (!resultado.ok) {
    return data({ ...resultado, tipo: "cancelamento" as const }, { status: 400 })
  }

  const partes = [
    `${resultado.estornados} ${resultado.estornados === 1 ? "item estornado" : "itens estornados"}`,
  ]
  if (nota.cancelada) partes.push("nota fiscal cancelada na SEFAZ")
  if (cobrancas.canceladas > 0) {
    partes.push(
      `${cobrancas.canceladas} ${cobrancas.canceladas === 1 ? "boleto cancelado" : "boletos cancelados"} no Inter`
    )
  }
  // Só o que o Inter confirmou é dito como cancelado; o resto é dito como o que é.
  if (cobrancas.emAndamento > 0) {
    partes.push(
      `${cobrancas.emAndamento} ${cobrancas.emAndamento === 1 ? "boleto" : "boletos"} em cancelamento no Inter — confira em instantes`
    )
  }

  return {
    ok: true as const,
    tipo: "cancelamento" as const,
    mensagem: `Venda #${resultado.numero} cancelada · ${partes.join(" · ")}`,
  }
}

export default function Vendas({ loaderData }: Route.ComponentProps) {
  const { eu, filtro, vendedores, vendas, total, foraDoPeriodo, paginas, resumo, notas, podeEmitirNota } =
    loaderData
  const podeCancelar = ehGerente(eu.papel)

  const [params, setParams] = useSearchParams()

  // Os campos digitados vivem em estado porque os atalhos de período os alteram;
  // o efeito os traz de volta ao que a URL diz depois de cada navegação,
  // inclusive a do botão "voltar" do navegador.
  const [campos, setCampos] = useState(filtro)
  useEffect(() => setCampos(filtro), [filtro])

  /** Muda um pedaço do filtro e volta para a primeira página. */
  function aplicar(mudanca: Partial<FiltroVendas>) {
    const proximo = { ...campos, ...mudanca }
    setCampos(proximo)

    const novos = new URLSearchParams()
    novos.set("de", proximo.de)
    novos.set("ate", proximo.ate)
    if (proximo.vendedor) novos.set("vendedor", proximo.vendedor)
    if (proximo.cliente) novos.set("cliente", proximo.cliente)
    if (proximo.numero) novos.set("numero", proximo.numero)
    if (proximo.valor) novos.set("valor", proximo.valor)
    if (proximo.forma) novos.set("forma", proximo.forma)
    setParams(novos, { preventScrollReset: true })
  }

  const [indiceAtivo, setIndiceAtivo] = useState(0)
  const [confirmando, setConfirmando] = useState<string | null>(null)
  const [comprovante, setComprovante] = useState<{
    vendaNumero: number
    vendaId: string
    cobrancas: CobrancaDaVenda[]
    erro: string | null
    emitindo: boolean
  } | null>(null)
  const [aviso, setAviso] = useState<{ texto: string; tipo: "erro" | "sucesso" } | null>(null)

  const linhaAtiva = useRef<HTMLTableRowElement>(null)
  const ultimaResposta = useRef<unknown>(null)
  const fetcher = useFetcher<typeof action>()
  const cancelando = fetcher.state !== "idle"

  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  /**
   * A lista se atualiza sozinha a cada 20s.
   *
   * A baixa do boleto chega pelo webhook, direto no banco — a tela não tem como
   * saber sem perguntar. Sem isso o operador via "A_RECEBER" numa cobrança já
   * paga e só descobria dando F5, o que não é comportamento de quem confere caixa.
   */
  const revalidador = useRevalidator()
  const [atualizadoEm, setAtualizadoEm] = useState<string | null>(null)

  useEffect(() => {
    const id = setInterval(() => {
      // Não recarrega no meio de um cancelamento nem com diálogo aberto.
      if (revalidador.state === "idle" && !confirmando && !comprovante) {
        revalidador.revalidate()
      }
    }, 20_000)
    return () => clearInterval(id)
  }, [revalidador, confirmando, comprovante])

  useEffect(() => {
    if (revalidador.state === "idle") {
      setAtualizadoEm(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))
    }
  }, [revalidador.state, vendas])

  const ativa = vendas[indiceAtivo]

  useEffect(() => {
    linhaAtiva.current?.scrollIntoView({ block: "nearest" })
  }, [indiceAtivo])

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

    const resposta = fetcher.data

    // A cobrança pertence ao comprovante; o cancelamento, à barra de status.
    if (resposta.tipo === "cobranca") {
      const atualizacao = resposta.ok
        ? { cobrancas: resposta.cobrancas, erro: null, emitindo: false }
        : { cobrancas: [], erro: resposta.erro, emitindo: false }
      setComprovante((atual) => (atual === null ? null : { ...atual, ...atualizacao }))
      return
    }

    setConfirmando(null)
    avisar(
      resposta.ok ? resposta.mensagem : resposta.erro,
      resposta.ok ? "sucesso" : "erro"
    )
  }, [fetcher.state, fetcher.data, avisar])

  /**
   * Emite a nota da venda selecionada.
   *
   * O modelo não é escolha de quem clica: cliente empresa e venda a prazo vão de
   * NF-e, o resto do balcão de NFC-e. Oferecer a escolha seria oferecer a chance
   * de emitir o documento errado.
   */
  const emitirNotaFiscal = useCallback(() => {
    if (!ativa || cancelando) return
    if (ativa.canceladaEm) {
      avisar(`Venda #${ativa.numero} está cancelada`, "erro")
      return
    }

    const jaTem = notas[ativa.id]
    if (jaTem?.caminhoDanfe && jaTem.status === "autorizado") {
      window.open(jaTem.caminhoDanfe, "_blank", "noopener")
      return
    }

    fetcher.submit({ acao: "nota", vendaId: ativa.id }, { method: "post" })
  }, [ativa, cancelando, avisar, fetcher, notas])

  const verCobranca = useCallback(() => {
    if (!ativa || cancelando) return
    if (ativa.forma !== "prazo") {
      avisar("Só venda a prazo tem boleto", "erro")
      return
    }
    // Emitir boleto de venda cancelada cobraria o cliente por algo desfeito.
    // Ver uma cobrança que já existe continua liberado.
    if (ativa.canceladaEm && ativa.cobrancas.length === 0) {
      avisar(`Venda #${ativa.numero} está cancelada`, "erro")
      return
    }
    setComprovante({
      vendaNumero: ativa.numero,
      vendaId: ativa.id,
      cobrancas: [],
      erro: null,
      // Sem cobrança ainda, o action emite; com cobrança, só devolve a existente.
      emitindo: true,
    })
    fetcher.submit({ vendaId: ativa.id, acao: "cobranca" }, { method: "post" })
  }, [ativa, avisar, cancelando, fetcher])

  const pedirCancelamento = useCallback(() => {
    if (!ativa || cancelando) return
    // Espelha exigirGerente: o operador recebe o motivo, não um 403 seco.
    if (!podeCancelar) {
      avisar(ACOES_DE_GERENTE.cancelarVenda, "erro")
      return
    }
    if (ativa.canceladaEm) {
      avisar(`Venda #${ativa.numero} já está cancelada`, "erro")
      return
    }
    // Cancelar estorna estoque; exige uma segunda confirmação deliberada.
    setConfirmando(ativa.id)
  }, [ativa, avisar, cancelando, podeCancelar])

  const confirmarCancelamento = useCallback(() => {
    if (!confirmando) return
    fetcher.submit({ vendaId: confirmando }, { method: "post" })
  }, [confirmando, fetcher])

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

      if (comprovante) {
        if (key === "Escape" || key === "Enter") {
          evento.preventDefault()
          if (!comprovante.emitindo) setComprovante(null)
        }
        return
      }

      if (confirmando) {
        if (key === "Enter") {
          evento.preventDefault()
          confirmarCancelamento()
        } else if (key === "Escape") {
          evento.preventDefault()
          setConfirmando(null)
        }
        return
      }

      /**
       * Com um campo de filtro em foco, o teclado é dele.
       *
       * Sem isto a seta moveria a linha selecionada em vez do cursor, e —
       * pior — Delete tentaria CANCELAR a venda selecionada enquanto se apaga
       * um dígito do valor procurado.
       */
      const alvo = evento.target
      if (
        alvo instanceof HTMLInputElement ||
        alvo instanceof HTMLSelectElement ||
        alvo instanceof HTMLTextAreaElement
      ) {
        return
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        evento.preventDefault()
        const delta = key === "ArrowDown" ? 1 : -1
        setIndiceAtivo((atual) =>
          Math.min(Math.max(atual + delta, 0), Math.max(vendas.length - 1, 0))
        )
        return
      }

      if (key === "F8") {
        evento.preventDefault()
        verCobranca()
        return
      }

      if (key === "F9" || key === "Delete") {
        evento.preventDefault()
        pedirCancelamento()
      }
    }

    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [
    alternar,
    comprovante,
    confirmando,
    confirmarCancelamento,
    pedirCancelamento,
    verCobranca,
    vendas.length,
  ])

  const vendaConfirmando = vendas.find((venda) => venda.id === confirmando)

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        loja={eu.loja}
        lojasPermitidas={eu.lojasPermitidas.length}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      >
        <span>
          <b className="font-semibold text-foreground">{resumo.vendas}</b>{" "}
          {resumo.vendas === 1 ? "venda" : "vendas"} ·{" "}
          <b className="font-semibold text-foreground">{moeda(resumo.faturamento)}</b>
          {resumo.canceladas > 0
            ? ` · ${resumo.canceladas} ${resumo.canceladas === 1 ? "cancelada" : "canceladas"}`
            : ""}
        </span>
      </Topo>

      <div className="flex flex-wrap items-end gap-2 border-b border-border px-5 py-2.5">
        <Campo rotulo="De">
          <input
            type="date"
            value={campos.de}
            onChange={(e) => aplicar({ de: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>
        <Campo rotulo="Até">
          <input
            type="date"
            value={campos.ate}
            onChange={(e) => aplicar({ ate: e.target.value })}
            className={ESTILO_CAMPO}
          />
        </Campo>

        <Campo rotulo="Vendedor">
          <select
            value={campos.vendedor}
            onChange={(e) => aplicar({ vendedor: e.target.value })}
            className={cn(ESTILO_CAMPO, "w-36")}
          >
            <option value="">Todos</option>
            {vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.nome}
              </option>
            ))}
          </select>
        </Campo>

        <Campo rotulo="Cliente">
          <Input
            value={campos.cliente}
            onChange={(e) => setCampos({ ...campos, cliente: e.target.value })}
            onBlur={(e) => aplicar({ cliente: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") aplicar({ cliente: e.currentTarget.value })
            }}
            placeholder="nome ou CPF/CNPJ"
            className="h-8 w-44 text-xs"
          />
        </Campo>

        <Campo rotulo="Nº">
          <Input
            value={campos.numero}
            onChange={(e) => setCampos({ ...campos, numero: e.target.value })}
            onBlur={(e) => aplicar({ numero: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") aplicar({ numero: e.currentTarget.value })
            }}
            className="h-8 w-20 font-mono text-xs"
          />
        </Campo>

        <Campo rotulo="Valor">
          <Input
            value={campos.valor}
            onChange={(e) => setCampos({ ...campos, valor: e.target.value })}
            onBlur={(e) => aplicar({ valor: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") aplicar({ valor: e.currentTarget.value })
            }}
            placeholder="127,50"
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </Campo>

        <Campo rotulo="Forma">
          <select
            value={campos.forma}
            onChange={(e) => aplicar({ forma: e.target.value })}
            className={cn(ESTILO_CAMPO, "w-28")}
          >
            <option value="">Todas</option>
            {FORMAS_PAGAMENTO.map((f) => (
              <option key={f.id} value={f.id}>
                {f.rotulo}
              </option>
            ))}
          </select>
        </Campo>

        <div className="flex gap-1.5">
          <Atalho rotulo="Hoje" onClick={() => aplicar({ de: diaDeHoje(), ate: diaDeHoje() })} />
          <Atalho rotulo="7 dias" onClick={() => aplicar({ de: diaAtras(6), ate: diaDeHoje() })} />
          <Atalho rotulo="30 dias" onClick={() => aplicar({ de: diaAtras(29), ate: diaDeHoje() })} />
          <Atalho
            rotulo="Limpar"
            onClick={() =>
              aplicar({
                de: diaAtras(6),
                ate: diaDeHoje(),
                vendedor: "",
                cliente: "",
                numero: "",
                valor: "",
                forma: "",
              })
            }
          />
        </div>
      </div>

      {/* Quanto cada um vendeu no que está filtrado — é o que responde "quanto
          o Marcelo vendeu essa semana" sem sair da tela do turno. */}
      {resumo.porVendedor.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/30 px-5 py-2 text-xs">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Por vendedor
          </span>
          {resumo.porVendedor.map((linha) => (
            <button
              key={linha.vendedorId ?? "sem"}
              type="button"
              // Clicar filtra por ele: a pergunta seguinte a "quanto vendeu" é
              // quase sempre "quais foram".
              onClick={() => aplicar({ vendedor: linha.vendedorId ?? "" })}
              disabled={!linha.vendedorId}
              className={cn(
                "rounded px-1.5 py-0.5",
                linha.vendedorId && "hover:bg-accent",
                campos.vendedor === linha.vendedorId && "bg-accent"
              )}
            >
              <span className="font-medium">{linha.nome}</span>{" "}
              <span className="font-mono tabular-nums">{moeda(linha.faturamento)}</span>{" "}
              <span className="text-muted-foreground">
                ({linha.vendas} {linha.vendas === 1 ? "venda" : "vendas"})
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="w-20 px-5 py-2.5 text-left font-semibold">
                    Venda
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                    Quando
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-left font-semibold">
                    Itens
                  </th>
                  <th scope="col" className="w-28 px-2 py-2.5 text-left font-semibold">
                    Vendedor
                  </th>
                  <th scope="col" className="w-24 px-2 py-2.5 text-left font-semibold">
                    Forma
                  </th>
                  <th scope="col" className="w-28 px-2 py-2.5 text-right font-semibold">
                    Total
                  </th>
                  <th scope="col" className="w-44 px-2 py-2.5 text-left font-semibold">
                    Pagamento
                  </th>
                  <th scope="col" className="w-28 px-5 py-2.5 text-left font-semibold">
                    Situação
                  </th>
                </tr>
              </thead>
              <tbody>
                {vendas.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-5 py-16 text-center">
                      <Receipt
                        className="mx-auto size-10 text-muted-foreground/40"
                        aria-hidden
                      />
                      <p className="mt-3 text-sm text-muted-foreground">
                        Nenhuma venda no filtro.
                      </p>
                      {/* Achar nada por causa da data é a frustração clássica de
                          tela com filtro: quem procura por valor ou cliente não
                          sabe de que dia a venda é. */}
                      {foraDoPeriodo > 0 ? (
                        <button
                          type="button"
                          onClick={() => aplicar({ de: PRIMEIRO_DIA, ate: diaDeHoje() })}
                          className="mt-1 text-xs text-amber-600 underline underline-offset-2 dark:text-amber-500"
                        >
                          {foraDoPeriodo} fora do período — procurar em tudo
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ) : (
                  vendas.map((venda, indice) => {
                    const selecionada = indice === indiceAtivo
                    const cancelada = Boolean(venda.canceladaEm)
                    return (
                      <tr
                        key={venda.id}
                        ref={selecionada ? linhaAtiva : undefined}
                        onClick={() => setIndiceAtivo(indice)}
                        aria-current={selecionada ? "true" : undefined}
                        className={cn(
                          "cursor-default border-b border-border transition-colors",
                          selecionada
                            ? "bg-accent shadow-[inset_3px_0_0_var(--primary)]"
                            : "hover:bg-muted/40",
                          cancelada && "opacity-60"
                        )}
                      >
                        <td className="px-5 py-2.5 font-mono font-semibold tabular-nums">
                          #{venda.numero}
                        </td>
                        <td className="px-2 py-2.5 font-mono text-xs text-muted-foreground tabular-nums">
                          {new Date(venda.criadaEm).toLocaleString("pt-BR", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </td>
                        <td className="px-2 py-2">
                          <ItensDaVenda itens={venda.itens} />
                        </td>
                        <td className="px-2 py-2.5 text-xs">
                          {venda.vendedorNome ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-xs">
                          {FORMAS_PAGAMENTO.find((f) => f.id === venda.forma)?.rotulo ??
                            venda.forma}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-2.5 text-right font-mono font-medium tabular-nums",
                            cancelada && "line-through"
                          )}
                        >
                          {moeda(venda.total)}
                        </td>
                        <td className="px-2 py-2.5">
                          {/* Distingue pagamento CONFIRMADO pelo banco de pagamento
                              apenas declarado no caixa. Sem isso, uma venda em Pix
                              verificada ficava igual a uma só marcada como Pix. */}
                          {venda.forma === "pix" ? (
                            venda.pixPagoEm ? (
                              <span className="flex items-center gap-1.5">
                                <Badge className="text-[10px]">pago</Badge>
                                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                                  {new Date(venda.pixPagoEm).toLocaleTimeString("pt-BR", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                                {/* O cliente costuma pedir depois — principalmente
                                    quem pagou por outra pessoa. */}
                                <BotaoComprovantePix vendaId={venda.id} />
                              </span>
                            ) : (
                              <span
                                className="text-xs text-muted-foreground"
                                title="Registrada como Pix sem confirmação do banco"
                              >
                                não confirmado
                              </span>
                            )
                          ) : venda.forma !== "prazo" ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <SituacaoCobrancas cobrancas={venda.cobrancas} />
                          )}
                        </td>
                        <td className="px-5 py-2.5">
                          {cancelada ? (
                            <Badge variant="destructive" className="text-[10px]">
                              cancelada
                            </Badge>
                          ) : (
                            <SeloDaNota nota={notas[venda.id]} />
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>

            {paginas > 1 ? (
              <div className="flex items-center gap-3 border-t border-border px-5 py-2 text-xs text-muted-foreground">
                <Pagina params={params} para={filtro.pagina - 1} ativa={filtro.pagina > 1}>
                  ‹ Anteriores
                </Pagina>
                <span className="font-mono tabular-nums">
                  página {filtro.pagina} de {paginas} · {total} no filtro
                </span>
                <Pagina params={params} para={filtro.pagina + 1} ativa={filtro.pagina < paginas}>
                  Próximas ›
                </Pagina>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <div className="flex items-center gap-2">
              {podeEmitirNota ? (
                <BotaoNota
                  nota={ativa ? notas[ativa.id] : undefined}
                  modelo={ativa ? modeloDaVenda(ativa) : "nfce"}
                  desabilitado={!ativa || Boolean(ativa?.canceladaEm) || cancelando}
                  onClick={emitirNotaFiscal}
                />
              ) : null}
              <Button
                type="button"
                tabIndex={-1}
                variant="outline"
                size="sm"
                // Espelha a guarda de verCobranca: não oferecer o que será recusado.
                disabled={
                  !ativa ||
                  ativa.forma !== "prazo" ||
                  cancelando ||
                  Boolean(ativa.canceladaEm && ativa.cobrancas.length === 0)
                }
                onClick={verCobranca}
                className="rounded-lg"
              >
                <Kbd>F8</Kbd>
                {!ativa || ativa.cobrancas.length === 0
                  ? "Emitir boleto"
                  : ativa.cobrancas.length > 1
                    ? `Ver ${ativa.cobrancas.length} boletos`
                    : "Ver boleto"}
              </Button>
              {/* Operador não vê o botão de cancelar: o que ele não pode fazer não
                  precisa ocupar espaço no balcão. O F9 explica o motivo. */}
              {podeCancelar ? (
                <Button
                  type="button"
                  tabIndex={-1}
                  variant="destructive"
                  size="sm"
                  disabled={!ativa || Boolean(ativa?.canceladaEm) || cancelando}
                  onClick={pedirCancelamento}
                  className="rounded-lg"
                >
                  <Kbd>F9</Kbd> Cancelar venda
                </Button>
              ) : null}
              <span className="ml-1 text-xs text-muted-foreground">
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> escolhe a venda ·{" "}
                {podeCancelar
                  ? "o cancelamento estorna o estoque"
                  : "cancelamento é do gerente"}{" "}
                {atualizadoEm ? (
                  <span className="ml-2 font-mono text-[11px] tabular-nums">
                    · atualizado {atualizadoEm}
                  </span>
                ) : null}
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
            ) : null}
          </div>
        </section>
      </div>

      {comprovante ? (
        <CobrancaDialogo
          vendaNumero={comprovante.vendaNumero}
          vendaId={comprovante.vendaId}
          cobrancas={comprovante.cobrancas}
          erro={comprovante.erro}
          emitindo={comprovante.emitindo}
          onFechar={() => setComprovante(null)}
        />
      ) : null}

      {vendaConfirmando ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar cancelamento"
          className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-8 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
            <h2 className="text-base font-semibold">
              Cancelar a venda #{vendaConfirmando.numero}?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {moeda(vendaConfirmando.total)} em{" "}
              {FORMAS_PAGAMENTO.find((f) => f.id === vendaConfirmando.forma)?.rotulo}.{" "}
              {vendaConfirmando.itens.length === 1
                ? "O item volta"
                : `Os ${vendaConfirmando.itens.length} itens voltam`}{" "}
              para o estoque. A venda não é apagada — fica marcada como cancelada.
              {vendaConfirmando.cobrancas.length > 0 ? (
                <>
                  {" "}
                  <b className="font-semibold text-foreground">
                    {vendaConfirmando.cobrancas.length === 1
                      ? "O boleto será cancelado no Inter"
                      : `Os ${vendaConfirmando.cobrancas.length} boletos serão cancelados no Inter`}
                  </b>{" "}
                  — se algum já estiver pago, o cancelamento é recusado.
                </>
              ) : null}
              {notas[vendaConfirmando.id]?.status === "autorizado" ? (
                <>
                  {" "}
                  <b className="font-semibold text-foreground">
                    A {notas[vendaConfirmando.id].modelo === "nfe" ? "NF-e" : "NFC-e"}{" "}
                    {notas[vendaConfirmando.id].numero} será cancelada na SEFAZ
                  </b>{" "}
                  — passado o prazo dela, o cancelamento é recusado e a venda
                  continua de pé.
                </>
              ) : null}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                tabIndex={-1}
                variant="outline"
                onClick={() => setConfirmando(null)}
                className="rounded-lg"
              >
                <Kbd>Esc</Kbd> Voltar
              </Button>
              <Button
                type="button"
                tabIndex={-1}
                variant="destructive"
                disabled={cancelando}
                onClick={confirmarCancelamento}
                className="rounded-lg"
              >
                {cancelando ? "Cancelando…" : "Confirmar"}
                {cancelando ? null : <Kbd>Enter</Kbd>}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

type NotaDaVenda = {
  modelo: string
  status: string
  numero: string | null
  caminhoDanfe: string | null
  erro: string | null
}

/**
 * O que aconteceu com a nota daquela venda, em duas palavras.
 *
 * "processando" é estado normal e passageiro — a SEFAZ responde em segundos —,
 * então ele não é vermelho: quem vê vermelho vai atrás de alguém, e não há o que
 * fazer enquanto a fila anda.
 */
function SeloDaNota({ nota }: { nota: NotaDaVenda | undefined }) {
  if (!nota) return <span className="text-xs text-muted-foreground">—</span>

  const rotulo = nota.modelo === "nfe" ? "NF-e" : "NFC-e"

  if (nota.status === "autorizado") {
    const texto = nota.numero ? `${rotulo} ${nota.numero}` : rotulo
    return nota.caminhoDanfe ? (
      <a
        href={nota.caminhoDanfe}
        target="_blank"
        rel="noopener"
        onClick={(evento) => evento.stopPropagation()}
        className="text-xs font-medium underline underline-offset-2"
      >
        {texto}
      </a>
    ) : (
      <span className="text-xs font-medium">{texto}</span>
    )
  }

  if (nota.status === "cancelado") {
    return (
      <Badge variant="outline" className="text-[10px]">
        {rotulo} cancelada
      </Badge>
    )
  }

  if (nota.status === "erro_autorizacao" || nota.status === "denegado") {
    return (
      <span className="text-xs font-medium text-destructive" title={nota.erro ?? undefined}>
        {rotulo} recusada
      </span>
    )
  }

  return <span className="text-xs text-muted-foreground">{rotulo} na fila…</span>
}

/**
 * Um botão só para os dois momentos: emitir, e depois abrir o que foi emitido.
 * Separá-los deixaria um botão morto na tela metade do tempo.
 */
function BotaoNota({
  nota,
  modelo,
  desabilitado,
  onClick,
}: {
  nota: NotaDaVenda | undefined
  modelo: string
  desabilitado: boolean
  onClick: () => void
}) {
  const autorizada = nota?.status === "autorizado"
  const pendente = nota?.status === "processando_autorizacao"
  const rotulo = (nota?.modelo ?? modelo) === "nfe" ? "NF-e" : "NFC-e"

  return (
    <Button
      type="button"
      tabIndex={-1}
      variant="outline"
      size="sm"
      disabled={desabilitado || pendente}
      onClick={onClick}
      title={
        autorizada
          ? "Abre o documento auxiliar da nota autorizada"
          : nota?.erro
            ? nota.erro
            : `Emite a ${rotulo} desta venda`
      }
      className="rounded-lg"
    >
      <FileText className="size-4" aria-hidden />
      {autorizada
        ? `Ver ${rotulo}`
        : pendente
          ? `${rotulo} na fila…`
          : nota?.status === "erro_autorizacao"
            ? `Reenviar ${rotulo}`
            : `Emitir ${rotulo}`}
    </Button>
  )
}

/**
 * Reimprime o comprovante do Pix recebido.
 *
 * Vai direto para a impressora, como o cupom: quem está no balcão não vai
 * procurar a aba, apertar Ctrl+P e fechá-la com o cliente esperando.
 */
function BotaoComprovantePix({ vendaId }: { vendaId: string }) {
  const [gerando, setGerando] = useState(false)

  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      tabIndex={-1}
      disabled={gerando}
      aria-label="Imprimir comprovante do Pix"
      title="Imprimir o comprovante do Pix recebido"
      className="text-muted-foreground"
      onClick={async (evento) => {
        // A linha inteira abre o detalhe da venda; o botão faz outra coisa.
        evento.stopPropagation()
        setGerando(true)
        await imprimirDocumento(`/vendas/${vendaId}/comprovante-pix`)
        setGerando(false)
      }}
    >
      {gerando ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Printer className="size-3.5" aria-hidden />
      )}
    </Button>
  )
}
