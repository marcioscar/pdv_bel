import { useEffect, useState } from "react"
import { useFetcher } from "react-router"

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
import { Label } from "~/components/ui/label"
import { formatarCpfCnpj } from "~/lib/documento"
import { interpretarValor, moeda } from "~/lib/moeda"
import type { LinhaDeDespesa, ParcelaDaNota } from "~/lib/despesas.server"

/**
 * Gera as contas a pagar (`despesas`) a partir dos vencimentos de um documento
 * de entrada — a coleção não é deste projeto, é do sistema de contas a pagar
 * que a rede já usa; aqui só nasce o título, com a mesma cara que os já
 * existentes.
 *
 * Serve os dois documentos que trazem mercadoria: a NF-e do fornecedor, que já
 * declara as duplicatas, e a AF, que não declara nada — nela o gerente digita
 * as parcelas do papel. Um bloco só para os dois porque o que se faz é o mesmo;
 * duas cópias divergiriam na primeira mudança de categoria ou de rótulo.
 *
 * Sem duplicata (à vista, sem boleto formal) começa com uma linha só, pelo
 * valor total, para não obrigar a montar do zero. "Acrescentar linha" cobre o
 * que às vezes vem por fora do que o documento lista.
 */

export type DocumentoParaDespesas = {
  tipo: "nota" | "af"
  id: string
  /** O número que nomeia as parcelas ("4471 1/3") — da nota ou da AF. */
  numero: string
  valorTotal: number | null
  despesasGeradasEm: string | Date | null
  despesasGeradasPor: string | null
}

/**
 * O cadastro rápido de fornecedor, oferecido só quando o documento veio com um
 * emitente que não bate com cadastro nenhum — o caso da NF-e. A AF não passa
 * por aqui: o fornecedor dela foi escolhido do próprio cadastro.
 */
export type CadastroRapidoDeFornecedor = {
  emitenteCnpj: string
  emitenteNome: string
  endereco: { cidade: string | null; bairro: string | null } | null
  codigoSugerido: string | null
}

export type CategoriaDeDespesa = { id: string; etiqueta: string; conta: string }

/** O que a action da rota devolve para este bloco — a rota reexporta no seu union. */
export type RespostaDespesas =
  | { intencao: "gerarDespesas"; ok: true; quantidade: number }
  | { intencao: "gerarDespesas"; ok: false; erro: string }
  | { intencao: "cadastrarFornecedor"; ok: true; nome: string }
  | { intencao: "cadastrarFornecedor"; ok: false; erro: string }

type LinhaEditavel = {
  conta: string
  tipo: string
  descricao: string
  valorTexto: string
  data: string
}

function hojeComoDia() {
  const hoje = new Date()
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`
}

export function GerarDespesas({
  documento,
  duplicatas,
  fornecedor,
  categorias,
  cadastroRapido,
}: {
  documento: DocumentoParaDespesas
  duplicatas: ParcelaDaNota[] | null
  /** O nome que vai no campo `fornecedor` da despesa, e se ele tem cadastro. */
  fornecedor: { nome: string; temCadastro: boolean }
  categorias: CategoriaDeDespesa[]
  cadastroRapido: CadastroRapidoDeFornecedor | null
}) {
  const fetcher = useFetcher<RespostaDespesas>()
  const cadastroFetcher = useFetcher<RespostaDespesas>()
  const gerando = fetcher.state !== "idle"

  const [cadastroAberto, setCadastroAberto] = useState(false)
  // Cadastrado agora mesmo, nesta tela: sobrepõe o que veio do loader sem
  // precisar recarregar a página para o aviso âmbar sumir.
  const [nomeCadastradoAgora, setNomeCadastradoAgora] = useState<string | null>(null)

  useEffect(() => {
    const resposta = cadastroFetcher.data
    if (resposta?.intencao !== "cadastrarFornecedor" || !resposta.ok) return
    setNomeCadastradoAgora(resposta.nome)
    setCadastroAberto(false)
  }, [cadastroFetcher.data])

  const temCadastro = nomeCadastradoAgora != null || fornecedor.temCadastro
  const nomeDoFornecedor = nomeCadastradoAgora ?? fornecedor.nome
  // "revenda" quando a categoria ainda não foi carregada — mesmo valor que a
  // coleção `contas` já usa para compra de mercadoria para revender.
  const categoriaPadrao = categorias.find((c) => c.conta === "revenda")?.conta ?? "revenda"

  const [linhas, setLinhas] = useState<LinhaEditavel[]>(() => {
    const parcelas = duplicatas ?? []

    if (parcelas.length === 0) {
      return [
        {
          conta: categoriaPadrao,
          tipo: "variavel",
          descricao: nomeDoFornecedor,
          valorTexto:
            documento.valorTotal != null ? String(documento.valorTotal).replace(".", ",") : "",
          data: hojeComoDia(),
        },
      ]
    }

    return parcelas.map((p, i) => ({
      conta: categoriaPadrao,
      tipo: "variavel",
      descricao: `${documento.numero} ${i + 1}/${parcelas.length}`.trim(),
      valorTexto: String(p.valor).replace(".", ","),
      data: p.vencimento ?? "",
    }))
  })

  function atualizar(i: number, campo: keyof LinhaEditavel, valor: string) {
    setLinhas((atual) => atual.map((linha, idx) => (idx === i ? { ...linha, [campo]: valor } : linha)))
  }

  function adicionar() {
    setLinhas((atual) => [
      ...atual,
      {
        conta: categoriaPadrao,
        tipo: "variavel",
        descricao: nomeDoFornecedor,
        valorTexto: "",
        data: hojeComoDia(),
      },
    ])
  }

  function remover(i: number) {
    setLinhas((atual) => atual.filter((_, idx) => idx !== i))
  }

  function gerar() {
    const payload: LinhaDeDespesa[] = linhas.map((l) => ({
      conta: l.conta.trim() || categoriaPadrao,
      tipo: l.tipo.trim() || "variavel",
      descricao: l.descricao.trim(),
      valor: interpretarValor(l.valorTexto) ?? 0,
      data: l.data,
      // Só se preenche depois de pagar, no outro sistema — nasce sempre em
      // branco daqui, e nem aparece como campo nesta tela.
      contaCorrente: null,
    }))
    fetcher.submit(
      {
        intencao: "gerarDespesas",
        documentoTipo: documento.tipo,
        documentoId: documento.id,
        linhas: JSON.stringify(payload),
      },
      { method: "post" }
    )
  }

  const totalLancado = linhas.reduce((soma, l) => soma + (interpretarValor(l.valorTexto) ?? 0), 0)
  const diferenca = documento.valorTotal != null ? totalLancado - documento.valorTotal : null

  if (documento.despesasGeradasEm) {
    return (
      <div className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3 text-xs">
        Contas a pagar geradas em {new Date(documento.despesasGeradasEm).toLocaleString("pt-BR")}
        {documento.despesasGeradasPor ? ` por ${documento.despesasGeradasPor}` : ""}.
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Contas a pagar</h3>
        <Button type="button" size="xs" variant="ghost" onClick={adicionar}>
          + Acrescentar linha
        </Button>
      </div>

      {cadastroRapido && !temCadastro ? (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-amber-600/30 bg-amber-600/5 p-2">
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Este fornecedor não tem cadastro — usando o nome da própria nota (
            {nomeDoFornecedor}), não o nome fantasia.
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="shrink-0"
            onClick={() => setCadastroAberto(true)}
          >
            Cadastrar fornecedor
          </Button>
        </div>
      ) : null}

      {cadastroRapido ? (
        <CadastroDeFornecedor
          open={cadastroAberto}
          onOpenChange={setCadastroAberto}
          cadastro={cadastroRapido}
          fetcher={cadastroFetcher}
        />
      ) : null}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="w-36 py-1 pr-2">Vencimento</th>
              <th className="w-28 py-1 pr-2 text-right">Valor</th>
              <th className="py-1 pr-2">Descrição</th>
              <th className="w-40 py-1 pr-2">Conta</th>
              <th className="w-28 py-1 pr-2">Tipo</th>
              <th className="w-8 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((linha, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1 pr-2">
                  <input
                    type="date"
                    value={linha.data}
                    onChange={(e) => atualizar(i, "data", e.target.value)}
                    className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={linha.valorTexto}
                    onChange={(e) => atualizar(i, "valorTexto", e.target.value)}
                    className="h-7 w-full text-right font-mono text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={linha.descricao}
                    onChange={(e) => atualizar(i, "descricao", e.target.value)}
                    className="h-7 w-full min-w-40 text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={linha.conta}
                    onChange={(e) => atualizar(i, "conta", e.target.value)}
                    className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
                  >
                    {categorias.map((c) => (
                      <option key={c.id} value={c.conta}>
                        {c.etiqueta}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={linha.tipo}
                    onChange={(e) => atualizar(i, "tipo", e.target.value)}
                    className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
                  >
                    <option value="variavel">variável</option>
                    <option value="fixa">fixa</option>
                  </select>
                </td>
                <td className="py-1">
                  <Button type="button" size="xs" variant="ghost" onClick={() => remover(i)}>
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Total lançado: {moeda(totalLancado)}
          {diferenca != null && Math.abs(diferenca) > 0.01 ? (
            <span className="ml-1 text-amber-600 dark:text-amber-500">
              ({diferenca > 0 ? "+" : ""}
              {moeda(diferenca)} vs. valor do documento)
            </span>
          ) : null}
        </span>

        <Button
          type="button"
          size="sm"
          disabled={gerando || linhas.length === 0}
          onClick={gerar}
          className="ml-auto"
        >
          {gerando ? "Gerando…" : "Gerar contas a pagar"}
        </Button>
      </div>

      {fetcher.data?.intencao === "gerarDespesas" && !fetcher.data.ok ? (
        <p className="mt-1 text-xs text-destructive">{fetcher.data.erro}</p>
      ) : null}
    </div>
  )
}

/**
 * Cadastro rápido do fornecedor, num dialog aberto direto de "Contas a
 * pagar" quando o CNPJ da nota não bate com nenhum cadastro — mesma ideia do
 * cadastro rápido de produto na conciliação: pré-preenche com o que a NF-e
 * já traz (razão social, CNPJ, cidade e bairro do emitente) e deixa tudo
 * editável, porque "código" e "nome fantasia" são coisa que só quem cadastra
 * sabe escolher.
 */
function CadastroDeFornecedor({
  open,
  onOpenChange,
  cadastro,
  fetcher,
}: {
  open: boolean
  onOpenChange: (aberto: boolean) => void
  cadastro: CadastroRapidoDeFornecedor
  fetcher: ReturnType<typeof useFetcher<RespostaDespesas>>
}) {
  const [codigo, setCodigo] = useState(cadastro.codigoSugerido ?? "")
  const [razaoSocial, setRazaoSocial] = useState(cadastro.emitenteNome)
  const [nomeFantasia, setNomeFantasia] = useState("")
  const [cidade, setCidade] = useState(cadastro.endereco?.cidade ?? "")
  const [bairro, setBairro] = useState(cadastro.endereco?.bairro ?? "")

  const cadastrando = fetcher.state !== "idle"
  const resposta = fetcher.data
  const erro = resposta?.intencao === "cadastrarFornecedor" && !resposta.ok ? resposta.erro : null

  function cadastrar() {
    fetcher.submit(
      {
        intencao: "cadastrarFornecedor",
        codigo,
        razaoSocial,
        nomeFantasia,
        documento: cadastro.emitenteCnpj,
        cidade,
        bairro,
      },
      { method: "post" }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cadastrar fornecedor</DialogTitle>
          <DialogDescription>
            Pré-preenchido com o que a nota fiscal já traz, e o código com o próximo livre —
            confira e complete o que faltar.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-codigo">Código</Label>
              <Input
                id="fornecedor-codigo"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-fantasia">Nome fantasia</Label>
              {/* O foco começa aqui, e não no código: aquele já vem preenchido,
                  este é o que sempre precisa ser digitado. */}
              <Input
                id="fornecedor-fantasia"
                autoFocus
                value={nomeFantasia}
                onChange={(e) => setNomeFantasia(e.target.value)}
                placeholder="Como se conhece no dia a dia"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fornecedor-razao">Razão social</Label>
            <Input id="fornecedor-razao" value={razaoSocial} onChange={(e) => setRazaoSocial(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>CNPJ</Label>
            <p className="text-sm text-muted-foreground">{formatarCpfCnpj(cadastro.emitenteCnpj)}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-cidade">Cidade</Label>
              <Input id="fornecedor-cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fornecedor-bairro">Bairro</Label>
              <Input id="fornecedor-bairro" value={bairro} onChange={(e) => setBairro(e.target.value)} />
            </div>
          </div>

          {erro ? <p className="text-sm text-destructive">{erro}</p> : null}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
          <Button type="button" disabled={cadastrando} onClick={cadastrar}>
            {cadastrando ? "Cadastrando…" : "Cadastrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
