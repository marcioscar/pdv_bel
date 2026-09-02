import { useEffect, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { Loader2, Search } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Input } from "~/components/ui/input"
import {
  formatarCep,
  formatarCpfCnpj,
  limparCep,
  limparDocumento,
  mascararCep,
  mascararCpfCnpj,
  mascararTelefone,
  tipoPessoaDe,
  UFS,
  validarCep,
  validarCnpj,
  validarCpfCnpj,
} from "~/lib/documento"
import type { EnderecoDoCep } from "~/routes/cep"
import type { DadosDoCnpj } from "~/routes/cnpj"

/**
 * O cadastro de cliente, um só, usado pela tela de Cadastros e pelo F6 do caixa.
 *
 * Já foram dois formulários: o do balcão pedia menos campos e não consultava a
 * Receita, então o mesmo cliente saía diferente conforme a tela em que foi
 * cadastrado — e quem cadastrava no caixa nunca via a inscrição estadual, que
 * depois faltava. Um componente só resolve isso na origem.
 *
 * O que muda entre as duas telas é o invólucro e os botões, não os campos: por
 * isso o rodapé vem de fora, recebendo a função de salvar.
 */

/** O que o formulário precisa saber de um cliente para editá-lo. */
export type ClienteEditavel = {
  id: string
  nome: string
  cpfCnpj: string
  cep: string
  endereco: string
  numero: string | null
  complemento: string | null
  bairro: string
  cidade: string
  uf: string
  email: string | null
  ddd: string | null
  telefone: string | null
  inscricaoEstadual: string | null
  contatoNome: string | null
  contatoTelefone: string | null
  contatoEmail: string | null
}

type Formulario = {
  id: string
  nome: string
  cpfCnpj: string
  cep: string
  endereco: string
  numero: string
  complemento: string
  bairro: string
  cidade: string
  uf: string
  email: string
  ddd: string
  telefone: string
  inscricaoEstadual: string
  contatoNome: string
  contatoTelefone: string
  contatoEmail: string
}

const VAZIO: Formulario = {
  id: "",
  nome: "",
  cpfCnpj: "",
  cep: "",
  endereco: "",
  numero: "",
  complemento: "",
  bairro: "",
  cidade: "",
  uf: "MG",
  email: "",
  ddd: "",
  telefone: "",
  inscricaoEstadual: "",
  contatoNome: "",
  contatoTelefone: "",
  contatoEmail: "",
}

function doCliente(c: ClienteEditavel): Formulario {
  return {
    id: c.id,
    nome: c.nome,
    cpfCnpj: formatarCpfCnpj(c.cpfCnpj),
    cep: formatarCep(c.cep),
    endereco: c.endereco,
    numero: c.numero ?? "",
    complemento: c.complemento ?? "",
    bairro: c.bairro,
    cidade: c.cidade,
    uf: c.uf,
    email: c.email ?? "",
    ddd: c.ddd ?? "",
    telefone: mascararTelefone(c.telefone ?? ""),
    inscricaoEstadual: c.inscricaoEstadual ?? "",
    contatoNome: c.contatoNome ?? "",
    contatoTelefone: c.contatoTelefone ?? "",
    contatoEmail: c.contatoEmail ?? "",
  }
}

export function FormularioCliente({
  cliente,
  gravando,
  erro,
  aoSalvar,
  primeiroCampo,
  rodape,
}: {
  cliente?: ClienteEditavel | null
  gravando: boolean
  /** O erro que veio da gravação. As críticas da própria tela ficam aqui dentro. */
  erro: string | null
  aoSalvar: (dados: Record<string, string>) => void
  primeiroCampo?: React.Ref<HTMLInputElement>
  /** Os botões, que mudam conforme a tela. Recebe a função de salvar. */
  rodape: (salvar: () => void) => React.ReactNode
}) {
  const [form, setForm] = useState<Formulario>(cliente ? doCliente(cliente) : VAZIO)
  const [nota, setNota] = useState<string | null>(null)

  const cepBuscado = useRef<string | null>(cliente ? limparCep(cliente.cep) : null)
  const cnpjBuscado = useRef<string | null>(
    cliente ? limparDocumento(cliente.cpfCnpj) : null
  )

  const buscaCep = useFetcher<EnderecoDoCep | { erro: string }>()
  const buscaCnpj = useFetcher<DadosDoCnpj | { erro: string }>()
  const buscandoCep = buscaCep.state !== "idle"
  const buscandoCnpj = buscaCnpj.state !== "idle"

  const documento = limparDocumento(form.cpfCnpj)
  const documentoInvalido =
    (documento.length === 11 || documento.length === 14) && !validarCpfCnpj(documento)
  const tipo = tipoPessoaDe(documento)

  function alterar(campos: Partial<Formulario>) {
    setForm((atual) => ({ ...atual, ...campos }))
  }

  // Assim que o CEP fica completo, busca — sem apertar nada.
  useEffect(() => {
    const limpo = limparCep(form.cep)
    if (!validarCep(limpo) || cepBuscado.current === limpo) return
    cepBuscado.current = limpo
    buscaCep.load(`/cep/${limpo}`)
  }, [form.cep, buscaCep])

  // E o mesmo com o CNPJ: quatorze dígitos válidos, a Receita responde o resto do
  // cadastro. CPF não tem consulta pública — ali só vale a validação do dígito.
  useEffect(() => {
    if (!validarCnpj(documento) || !/^\d{14}$/.test(documento)) return
    if (cnpjBuscado.current === documento) return
    cnpjBuscado.current = documento
    buscaCnpj.load(`/cnpj/${documento}`)
  }, [documento, buscaCnpj])

  useEffect(() => {
    if (buscaCep.state !== "idle" || !buscaCep.data) return
    if ("erro" in buscaCep.data) {
      setNota(buscaCep.data.erro)
      return
    }
    const achado = buscaCep.data
    setNota(null)
    // Substitui os quatro campos: preservar o que estava deixaria o bairro do CEP
    // anterior numa cidade nova — endereço misturado, que iria para o boleto.
    setForm((atual) => ({
      ...atual,
      endereco: achado.endereco,
      bairro: achado.bairro,
      cidade: achado.cidade,
      uf: achado.uf,
    }))
  }, [buscaCep.state, buscaCep.data])

  useEffect(() => {
    if (buscaCnpj.state !== "idle" || !buscaCnpj.data) return
    if ("erro" in buscaCnpj.data) {
      setNota(buscaCnpj.data.erro)
      return
    }
    const achado = buscaCnpj.data
    setNota(
      achado.situacao && achado.situacao !== "ATIVA"
        ? `Atenção: situação cadastral ${achado.situacao} na Receita`
        : null
    )
    // O CEP veio junto: marca como já buscado para a consulta de CEP não disparar
    // e sobrescrever o logradouro da Receita pelo genérico do CEP.
    if (achado.cep) cepBuscado.current = achado.cep

    setForm((atual) => ({
      ...atual,
      nome: achado.nome || atual.nome,
      cep: achado.cep ? mascararCep(achado.cep) : atual.cep,
      endereco: achado.endereco || atual.endereco,
      numero: achado.numero || atual.numero,
      complemento: achado.complemento || atual.complemento,
      bairro: achado.bairro || atual.bairro,
      cidade: achado.cidade || atual.cidade,
      uf: achado.uf || atual.uf,
      ddd: achado.ddd || atual.ddd,
      telefone: achado.telefone ? mascararTelefone(achado.telefone) : atual.telefone,
      email: achado.email || atual.email,
    }))
  }, [buscaCnpj.state, buscaCnpj.data])

  function salvar() {
    if (gravando) return
    // Grava sem máscara: o banco guarda dígito, a máscara é só da tela.
    aoSalvar({
      ...form,
      cpfCnpj: documento,
      cep: limparCep(form.cep),
      ddd: form.ddd.replace(/\D/g, ""),
      telefone: form.telefone.replace(/\D/g, ""),
    })
  }

  return (
    <form
      onSubmit={(evento) => {
        evento.preventDefault()
        salvar()
      }}
      className="grid grid-cols-12 gap-3"
    >
      <div className="col-span-4">
        <label className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          CPF / CNPJ
          {buscandoCnpj ? (
            <span className="flex items-center gap-1 normal-case">
              <Loader2 className="size-3 animate-spin" aria-hidden /> consultando Receita
            </span>
          ) : tipo ? (
            <Badge variant="outline" className="text-[9px] normal-case">
              {tipo === "JURIDICA" ? "PJ" : "PF"}
            </Badge>
          ) : null}
        </label>
        <Input
          ref={primeiroCampo}
          value={form.cpfCnpj}
          onChange={(e) => alterar({ cpfCnpj: mascararCpfCnpj(e.target.value) })}
          placeholder="000.000.000-00"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={documentoInvalido || undefined}
          className="h-9 rounded-lg font-mono tabular-nums"
        />
        {documentoInvalido ? (
          <p className="mt-1 text-[11px] font-medium text-destructive">
            Dígito verificador não confere
          </p>
        ) : null}
      </div>
      <Campo
        rotulo="Inscr. estadual"
        valor={form.inscricaoEstadual}
        onChange={(v) => alterar({ inscricaoEstadual: v.toUpperCase() })}
        placeholder="ISENTO"
        className="col-span-3"
      />
      <Campo
        rotulo="Nome / Razão social"
        valor={form.nome}
        onChange={(v) => alterar({ nome: v })}
        className="col-span-5"
      />

      <div className="col-span-3">
        <label className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          CEP
          {buscandoCep ? (
            <span className="flex items-center gap-1 normal-case">
              <Search className="size-3 animate-pulse" aria-hidden /> buscando
            </span>
          ) : null}
        </label>
        <Input
          value={form.cep}
          onChange={(e) => alterar({ cep: mascararCep(e.target.value) })}
          placeholder="30110-000"
          inputMode="numeric"
          autoComplete="off"
          className="h-9 rounded-lg font-mono tabular-nums"
        />
      </div>
      <Campo
        rotulo="Endereço"
        valor={form.endereco}
        onChange={(v) => alterar({ endereco: v })}
        className="col-span-7"
      />
      <Campo
        rotulo="Nº"
        valor={form.numero}
        onChange={(v) => alterar({ numero: v })}
        className="col-span-2"
      />

      <Campo
        rotulo="Complemento"
        valor={form.complemento}
        onChange={(v) => alterar({ complemento: v })}
        className="col-span-3"
      />
      <Campo
        rotulo="Bairro"
        valor={form.bairro}
        onChange={(v) => alterar({ bairro: v })}
        className="col-span-4"
      />
      <Campo
        rotulo="Cidade"
        valor={form.cidade}
        onChange={(v) => alterar({ cidade: v })}
        className="col-span-3"
      />
      <div className="col-span-2">
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          UF
        </label>
        <select
          value={form.uf}
          onChange={(e) => alterar({ uf: e.target.value })}
          className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          {UFS.map((uf) => (
            <option key={uf} value={uf}>
              {uf}
            </option>
          ))}
        </select>
      </div>

      <Campo
        rotulo="DDD"
        valor={form.ddd}
        onChange={(v) => alterar({ ddd: v.replace(/\D/g, "").slice(0, 2) })}
        className="col-span-2"
      />
      <Campo
        rotulo="Telefone"
        valor={form.telefone}
        onChange={(v) => alterar({ telefone: mascararTelefone(v) })}
        className="col-span-3"
      />
      <Campo
        rotulo="E-mail"
        valor={form.email}
        onChange={(v) => alterar({ email: v })}
        className="col-span-7"
      />

      {/* O bloco de cima é o que vai no boleto; este é para o vendedor ligar.
          Sem a separação, "telefone" e "e-mail" apareceriam duas vezes na
          mesma grade sem nada dizendo qual é qual. */}
      <div className="col-span-12 mt-1 border-t border-border pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Contato na empresa
      </div>
      <Campo
        rotulo="Nome do contato"
        valor={form.contatoNome}
        onChange={(v) => alterar({ contatoNome: v })}
        className="col-span-4"
      />
      <Campo
        rotulo="Telefone do contato"
        valor={form.contatoTelefone}
        onChange={(v) => alterar({ contatoTelefone: v })}
        placeholder="(61) 99100-1916"
        className="col-span-3"
      />
      <Campo
        rotulo="E-mail do contato"
        valor={form.contatoEmail}
        onChange={(v) => alterar({ contatoEmail: v })}
        className="col-span-5"
      />

      <div className="col-span-12">
        {erro ? (
          <p className="text-sm font-medium text-destructive" role="alert">
            {erro}
          </p>
        ) : nota ? (
          <p className="text-sm text-muted-foreground" role="status">
            {nota}
          </p>
        ) : null}
      </div>

      <div className="col-span-12">{rodape(salvar)}</div>

      {/* O submit de verdade: deixa o Enter em qualquer campo cadastrar. */}
      <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
    </form>
  )
}

function Campo({
  rotulo,
  valor,
  onChange,
  placeholder,
  className,
}: {
  rotulo: string
  valor: string
  onChange: (valor: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </label>
      <Input
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="h-9 rounded-lg"
      />
    </div>
  )
}
