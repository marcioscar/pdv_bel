import { db } from "~/lib/db.server"
import {
  ambienteFocus,
  cancelarNota,
  consultarNota,
  emitirNota,
  ErroFocus,
  urlDoArquivo,
  type ModeloNota,
  type RespostaFocus,
} from "~/lib/focus.server"
import {
  ehSimples,
  FRETE_SEM_TRANSPORTE,
  modalidadeFreteValida,
  modeloDaVenda,
  PIS_COFINS_SIMPLES,
  pagamentoNaNota,
  pendenciasDoEmitente,
  tributacaoDoItem,
} from "~/lib/fiscal"

/**
 * A emissão da nota a partir de uma venda já fechada.
 *
 * Depois da venda, e não durante: a venda existe, o dinheiro entrou e o estoque
 * saiu. Se a SEFAZ recusar ou demorar, é a nota que fica pendente — nunca a
 * venda, que já aconteceu no mundo.
 *
 * A frase do Simples nas informações adicionais não é enfeite: a LC 123 exige
 * que a nota do optante diga que não gera crédito, e a falta dela é apontamento
 * na fiscalização.
 */
const AVISO_SIMPLES =
  "Documento emitido por ME ou EPP optante pelo Simples Nacional. " +
  "Não gera direito a crédito fiscal de IPI."

const OBJECT_ID = /^[0-9a-fA-F]{24}$/

export type ResultadoEmissao =
  | { ok: true; notaId: string; modelo: ModeloNota; status: string }
  | { ok: false; erro: string }

function arredondar(valor: number) {
  return Math.round(valor * 100) / 100
}

/**
 * Reparte um valor do total entre os itens, proporcionalmente ao que cada um
 * pesa.
 *
 * Desconto e frete são do documento inteiro para quem vende, e de cada item para
 * a SEFAZ — que confere se a soma dos itens bate com o total, ao centavo.
 * Divergência de um centavo é rejeição: "Total do Frete difere do somatorio dos
 * itens" foi exatamente isso. Por isso a sobra da divisão vai no último item, em
 * vez de se perder no arredondamento.
 */
function ratearProporcional(subtotais: number[], valor: number): number[] {
  if (valor <= 0) return subtotais.map(() => 0)

  const soma = subtotais.reduce((total, parcela) => total + parcela, 0)
  if (soma <= 0) return subtotais.map(() => 0)

  const parcelas = subtotais.map((parcela) => arredondar((parcela / soma) * valor))
  const sobra = arredondar(valor - parcelas.reduce((t, v) => t + v, 0))
  parcelas[parcelas.length - 1] = arredondar(parcelas[parcelas.length - 1] + sobra)

  return parcelas
}

/** Referência da nota na Focus. Determinística: a mesma venda dá o mesmo ref. */
function refDaVenda(vendaId: string, modelo: ModeloNota) {
  return `${modelo}-${vendaId}`
}

/**
 * O que a resposta da Focus muda na nota gravada.
 *
 * Campo ausente vira `undefined`, e não `null`, porque o Prisma ignora
 * `undefined` e grava `null`. A diferença apareceu no cancelamento: a resposta
 * dele não repete número, chave nem protocolo, e a nota cancelada ficava sem o
 * número do documento que acabara de ser cancelado — justamente o dado que
 * alguém procura depois.
 *
 * `erro` é o contrário: quando a nota alcança um estado bom, a mensagem antiga
 * PRECISA ser apagada, senão a nota reenviada com sucesso continua exibindo a
 * rejeição da tentativa anterior.
 */
function daResposta(resposta: RespostaFocus) {
  const erros = Array.isArray(resposta.erros) ? resposta.erros : []
  const mensagemDeErro =
    erros
      .map((e) => [e.campo, e.mensagem].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" · ") || null

  const status =
    typeof resposta.status === "string" ? resposta.status : "processando_autorizacao"
  const deuCerto = status === "autorizado" || status === "cancelado"

  return {
    status,
    numero: resposta.numero ?? undefined,
    serie: resposta.serie ?? undefined,
    chave: resposta.chave_nfe ?? undefined,
    protocolo: resposta.numero_protocolo ?? undefined,
    caminhoDanfe: urlDoArquivo(resposta.caminho_danfe) ?? undefined,
    caminhoXml: urlDoArquivo(resposta.caminho_xml_nota_fiscal) ?? undefined,
    qrcodeUrl: resposta.qrcode_url ?? undefined,
    erro: mensagemDeErro ?? resposta.mensagem_sefaz ?? (deuCerto ? null : undefined),
  }
}

/** O que o vendedor pode acrescentar à NF-e na hora de emitir. */
export type ExtrasDaNota = {
  /** Modalidade da tabela da SEFAZ. Vazio vale como "sem transporte". */
  freteModalidade?: string
  /** Só quando o frete é cobrado NA NOTA: soma no total dela. */
  freteValor?: number
  observacao?: string
}

export async function emitirDaVenda(
  vendaId: string,
  { emitidaPor, extras }: { emitidaPor: string; extras?: ExtrasDaNota }
): Promise<ResultadoEmissao> {
  if (!OBJECT_ID.test(vendaId)) return { ok: false, erro: "Venda inválida" }

  const venda = await db.venda.findUnique({ where: { id: vendaId } })
  if (!venda) return { ok: false, erro: "Venda não encontrada" }
  if (venda.canceladaEm) return { ok: false, erro: "Venda cancelada não gera nota" }

  const loja = await db.loja.findUnique({ where: { codigo: venda.loja } })
  if (!loja) return { ok: false, erro: `Loja ${venda.loja} não cadastrada` }
  if (!loja.emiteNotaFiscal) {
    return { ok: false, erro: `${loja.nome} ainda não emite nota — ligue em Cadastros › Fiscal` }
  }

  const faltando = pendenciasDoEmitente(loja)
  if (faltando.length > 0) {
    return { ok: false, erro: `Cadastro fiscal de ${loja.codigo} incompleto: falta ${faltando.join(", ")}` }
  }

  const modelo = modeloDaVenda(venda)
  const ref = refDaVenda(vendaId, modelo)

  /*
   * A trava contra nota dupla é dupla também: aqui, para não gastar a chamada, e
   * na própria Focus, pelo `ref` — que devolve a nota existente em vez de emitir
   * outra caso este primeiro filtro escape numa corrida.
   */
  const jaEmitida = await db.notaFiscalEmitida.findUnique({ where: { ref } })
  if (jaEmitida && jaEmitida.status !== "erro_autorizacao") {
    return { ok: false, erro: `Esta venda já tem ${modelo.toUpperCase()} ${jaEmitida.status}` }
  }

  const cliente = venda.clienteId
    ? await db.cliente.findUnique({ where: { id: venda.clienteId } })
    : null

  if (modelo === "nfe" && !cliente) {
    return { ok: false, erro: "NF-e precisa do cliente: vincule um cadastro à venda" }
  }

  // Os dados fiscais são do PRODUTO, e o item da venda guarda só o retrato
  // comercial. Sem o NCM não há nota — e é por item, não pela venda inteira.
  const produtos = await db.produto.findMany({
    where: { id: { in: venda.itens.map((item) => item.produtoId) } },
  })
  const porId = new Map(produtos.map((p) => [p.id, p]))

  const semNcm = venda.itens.filter((item) => !porId.get(item.produtoId)?.ncm)
  if (semNcm.length > 0) {
    return {
      ok: false,
      erro: `Sem NCM: ${semNcm.map((i) => i.codigo).join(", ")} — a SEFAZ recusa a nota inteira`,
    }
  }

  const ufDestino = cliente?.uf || loja.uf || "DF"
  const interestadual = ufDestino !== (loja.uf ?? "DF")
  /*
   * Frete e observação só existem na NF-e. Na NFC-e o cliente leva a mercadoria
   * na mão, e o campo de observação da nota de consumidor não é lugar de recado
   * — a bobina já sai apertada.
   */
  const frete =
    modelo === "nfe" && extras?.freteModalidade && modalidadeFreteValida(extras.freteModalidade)
      ? extras.freteModalidade
      : FRETE_SEM_TRANSPORTE
  const valorFrete = modelo === "nfe" ? arredondar(extras?.freteValor ?? 0) : 0
  const observacao = modelo === "nfe" ? (extras?.observacao ?? "").trim() : ""

  /*
   * A frase do Simples é exigida por lei e não pode ser substituída pelo recado
   * do vendedor: as duas coisas convivem no mesmo campo, uma depois da outra.
   */
  const informacoes = [ehSimples(loja.regimeTributario) ? AVISO_SIMPLES : "", observacao]
    .filter(Boolean)
    .join(" ")

  const subtotais = venda.itens.map((item) => item.subtotal)
  const descontos = ratearProporcional(subtotais, venda.desconto)
  // O frete é repartido pelos itens pelo mesmo motivo do desconto: a SEFAZ soma
  // os itens e confere com o total do documento.
  const fretes = ratearProporcional(subtotais, valorFrete)

  const items = venda.itens.map((item, i) => {
    const produto = porId.get(item.produtoId)!
    const tributacao = tributacaoDoItem(produto, loja, { interestadual })

    return {
      numero_item: i + 1,
      codigo_produto: item.codigo,
      descricao: item.descricao,
      codigo_ncm: produto.ncm,
      cfop: tributacao.cfop,
      unidade_comercial: item.unidade,
      unidade_tributavel: item.unidade,
      quantidade_comercial: item.quantidade,
      quantidade_tributavel: item.quantidade,
      valor_unitario_comercial: item.preco,
      valor_unitario_tributavel: item.preco,
      valor_bruto: arredondar(item.subtotal),
      valor_desconto: descontos[i] || undefined,
      valor_frete: fretes[i] || undefined,
      icms_origem: tributacao.origem,
      icms_situacao_tributaria: tributacao.csosn,
      codigo_cest: tributacao.cest ?? undefined,
      // Zerados, mas presentes: no Simples não há destaque, e a nota precisa
      // dizer isso item a item.
      pis_situacao_tributaria: PIS_COFINS_SIMPLES,
      pis_base_calculo: 0,
      pis_aliquota_porcentual: 0,
      pis_valor: 0,
      cofins_situacao_tributaria: PIS_COFINS_SIMPLES,
      cofins_base_calculo: 0,
      cofins_aliquota_porcentual: 0,
      cofins_valor: 0,
      inclui_no_total: 1,
    }
  })

  const valorProdutos = arredondar(
    venda.itens.reduce((total, item) => total + item.subtotal, 0)
  )

  const comum = {
    /*
     * Agora, e não a hora da venda: a nota é emitida no momento em que é
     * transmitida, e a SEFAZ compara com o relógio dela. Emitir hoje uma venda
     * de semana passada com a data de lá volta como "data de emissão atrasada".
     */
    data_emissao: dataComFuso(new Date()),
    natureza_operacao: modelo === "nfce" ? "VENDA AO CONSUMIDOR" : "VENDA DE MERCADORIA",
    tipo_documento: 1, // saída
    finalidade_emissao: 1, // normal
    presenca_comprador: "1", // operação presencial
    modalidade_frete: frete,
    local_destino: interestadual ? "2" : "1",
    cnpj_emitente: loja.cnpj,
    nome_emitente: loja.razaoSocial,
    inscricao_estadual_emitente: loja.inscricaoEstadual,
    serie: (modelo === "nfce" ? loja.serieNfce : loja.serieNfe) ?? undefined,
    valor_produtos: valorProdutos,
    valor_desconto: venda.desconto || undefined,
    valor_frete: valorFrete || undefined,
    // O frete cobrado entra no total da nota: por isso a nota pode valer mais
    // que a venda, e é isso que a tela avisa antes de emitir.
    valor_total: arredondar(venda.total + valorFrete),
    informacoes_adicionais_contribuinte: informacoes || undefined,
    items,
  }

  const documentoCliente = (cliente?.cpfCnpj ?? "").replace(/\D/g, "")

  const payload =
    modelo === "nfce"
      ? {
          ...comum,
          // Na NFC-e o consumidor é opcional: sem CPF, sai a nota "sem
          // identificação do destinatário", que é o caso da maioria do balcão.
          ...(documentoCliente.length === 11
            ? { cpf_destinatario: documentoCliente, nome_destinatario: cliente!.nome }
            : {}),
          formas_pagamento: [
            { forma_pagamento: pagamentoNaNota(venda.forma), valor_pagamento: arredondar(venda.total) },
          ],
        }
      : {
          ...comum,
          nome_destinatario: cliente!.nome,
          ...(documentoCliente.length === 14
            ? { cnpj_destinatario: documentoCliente }
            : { cpf_destinatario: documentoCliente }),
          /*
           * 1 contribuinte com IE, 2 isento, 9 não contribuinte. É o campo que a
           * inscrição estadual do cadastro alimenta — e mandar 1 sem IE, ou IE
           * sem o indicador, derruba a nota.
           */
          indicador_inscricao_estadual_destinatario: indicadorDeIe(cliente!.inscricaoEstadual),
          ...(cliente!.inscricaoEstadual && cliente!.inscricaoEstadual !== "ISENTO"
            ? { inscricao_estadual_destinatario: cliente!.inscricaoEstadual }
            : {}),
          logradouro_destinatario: cliente!.endereco,
          numero_destinatario: cliente!.numero || "S/N",
          complemento_destinatario: cliente!.complemento || undefined,
          bairro_destinatario: cliente!.bairro,
          municipio_destinatario: cliente!.cidade,
          uf_destinatario: cliente!.uf,
          cep_destinatario: cliente!.cep,
          telefone_destinatario:
            cliente!.ddd && cliente!.telefone ? `${cliente!.ddd}${cliente!.telefone}` : undefined,
          email_destinatario: cliente!.email || undefined,
          consumidor_final: documentoCliente.length === 14 ? 0 : 1,
        }

  const ambiente = ambienteFocus()

  // A nota nasce antes da resposta: se a chamada cair no meio, fica o registro
  // de que houve tentativa — e o `ref` impede que a próxima vire nota dupla.
  const nota = await db.notaFiscalEmitida.upsert({
    where: { ref },
    create: {
      ref,
      modelo,
      ambiente,
      loja: venda.loja,
      vendaId,
      destinatarioNome: cliente?.nome ?? null,
      destinatarioCpfCnpj: documentoCliente || null,
      valorTotal: arredondar(venda.total + valorFrete),
      observacao: observacao || null,
      freteModalidade: modelo === "nfe" ? frete : null,
      freteValor: valorFrete || null,
      emitidaPor,
    },
    update: {
      status: "processando_autorizacao",
      erro: null,
      ambiente,
      emitidaPor,
      valorTotal: arredondar(venda.total + valorFrete),
      observacao: observacao || null,
      freteModalidade: modelo === "nfe" ? frete : null,
      freteValor: valorFrete || null,
    },
  })

  try {
    const resposta = await emitirNota(modelo, ref, payload)
    const dados = daResposta(resposta)

    await db.notaFiscalEmitida.update({ where: { id: nota.id }, data: dados })
    return { ok: true, notaId: nota.id, modelo, status: dados.status }
  } catch (erro) {
    const mensagem =
      erro instanceof ErroFocus ? erro.message : "Falha ao falar com a Focus NFe"

    await db.notaFiscalEmitida.update({
      where: { id: nota.id },
      data: { status: "erro_autorizacao", erro: mensagem },
    })

    return { ok: false, erro: mensagem }
  }
}

/** 1 contribuinte com IE, 2 isento, 9 não contribuinte (o consumidor comum). */
function indicadorDeIe(inscricao: string | null) {
  if (!inscricao) return 9
  if (inscricao === "ISENTO") return 2
  return 1
}

/**
 * A SEFAZ compara a data de emissão com o relógio dela e recusa nota "do
 * futuro". Brasília é UTC-3 fixo; sem o fuso explícito, um horário em UTC chega
 * três horas adiantado.
 */
function dataComFuso(data: Date) {
  const deslocada = new Date(data.getTime() - 3 * 60 * 60 * 1000)
  return deslocada.toISOString().replace(/\.\d{3}Z$/, "-03:00")
}

/** Busca na Focus o desfecho de uma nota que ficou pendente. */
export async function atualizarStatusDaNota(notaId: string) {
  const nota = await db.notaFiscalEmitida.findUnique({ where: { id: notaId } })
  if (!nota) return

  try {
    const resposta = await consultarNota(nota.modelo as ModeloNota, nota.ref)
    await db.notaFiscalEmitida.update({ where: { id: notaId }, data: daResposta(resposta) })
  } catch (erro) {
    // Focus fora do ar não é motivo para marcar a nota como recusada: o status
    // antigo continua valendo, e a próxima consulta tenta de novo.
    console.error("[nota-fiscal] falha ao consultar", nota.ref, erro)
  }
}

/** As notas ainda sem desfecho, para a tela perguntar por elas ao abrir. */
export function notasPendentes(loja: string, limite = 10) {
  return db.notaFiscalEmitida.findMany({
    where: { loja, status: "processando_autorizacao" },
    select: { id: true },
    take: limite,
  })
}

/**
 * Desfaz a nota da venda que está sendo cancelada.
 *
 * A ordem importa e é a mesma do boleto: a nota é cancelada na SEFAZ ANTES de a
 * venda ser desfeita aqui. Na ordem inversa, uma falha deixaria uma nota viva
 * numa venda que não existe mais — e isso não aparece em tela nenhuma, só na
 * apuração do contador, semanas depois.
 *
 * Venda sem nota é o caso comum e não é erro: devolve `cancelada: false` e o
 * cancelamento segue.
 *
 * Quando a SEFAZ recusa o cancelamento, a venda NÃO é desfeita. Quase sempre é
 * prazo vencido (a NFC-e tem minutos; a NF-e, 24 horas), e nesse ponto a nota é
 * um fato fiscal: o caminho é uma nota de devolução, com o contador, não um
 * botão de cancelar que apaga a venda e deixa o documento de pé.
 */
export async function desfazerNotaDaVenda(
  vendaId: string,
  justificativa: string
): Promise<{ ok: true; cancelada: boolean } | { ok: false; erro: string }> {
  const nota = await db.notaFiscalEmitida.findFirst({
    where: { vendaId, status: { in: ["autorizado", "processando_autorizacao"] } },
    orderBy: { criadaEm: "desc" },
  })
  if (!nota) return { ok: true, cancelada: false }

  /*
   * Nota na fila não pode ser cancelada — nem existe ainda para a SEFAZ. Vale
   * perguntar uma vez, porque o desfecho costuma chegar em segundos e o gerente
   * pode estar cancelando logo depois de fechar.
   */
  if (nota.status === "processando_autorizacao") {
    await atualizarStatusDaNota(nota.id)
    const agora = await db.notaFiscalEmitida.findUnique({ where: { id: nota.id } })

    if (agora?.status === "processando_autorizacao") {
      return {
        ok: false,
        erro: "A nota ainda está sendo autorizada pela SEFAZ — tente cancelar em instantes",
      }
    }
    if (agora?.status !== "autorizado") return { ok: true, cancelada: false }
  }

  // A SEFAZ exige 15 caracteres; menos que isso volta como rejeição, depois da
  // viagem.
  const motivo = justificativa.trim().padEnd(15, ".")

  try {
    const resposta = await cancelarNota(nota.modelo as ModeloNota, nota.ref, motivo)
    await db.notaFiscalEmitida.update({
      where: { id: nota.id },
      data: { ...daResposta(resposta), status: "cancelado" },
    })
    return { ok: true, cancelada: true }
  } catch (erro) {
    const detalhe = erro instanceof ErroFocus ? erro.message : "Falha ao falar com a Focus NFe"
    return {
      ok: false,
      erro: `A nota ${nota.numero ? `${nota.numero} ` : ""}não pôde ser cancelada: ${detalhe}`,
    }
  }
}
