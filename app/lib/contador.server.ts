import { zipSync } from "fflate"

import { db } from "~/lib/db.server"
import { emailValido, enviarEmail } from "~/lib/email.server"
import { urlDoArquivo } from "~/lib/focus.server"
import { escapar } from "~/lib/html"
import { arredondar, moeda } from "~/lib/moeda"

/**
 * O fechamento fiscal do mês para o contador: os XMLs das notas de saída de uma
 * loja (cada loja é um CNPJ), num ZIP, e os totais.
 *
 * O formato copia o do sistema antigo, que o escritório já recebe: um XML por
 * nota, com o protocolo de autorização, chamado `{chave}-nfe.xml` (NFC-e:
 * `{chave}-nfce.xml`). Junto vai um `resumo.csv`.
 *
 * Entram só notas que a SEFAZ autorizou, em PRODUÇÃO: recusada, com erro,
 * processando ou de homologação nunca vai. A cancelada foi autorizada e depois
 * cancelada — vai marcada e fora do total, quando `comCanceladas`, porque o
 * número que pulou precisa de explicação na escrituração.
 */

const MES = /^\d{4}-(0[1-9]|1[0-2])$/

export function mesValido(mes: string) {
  return MES.test(mes)
}

/** O mês anterior ao de hoje, em Brasília — o que normalmente se manda. */
export function mesAnterior() {
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })
  const [ano, mes] = hoje.split("-").map(Number)
  const d = new Date(Date.UTC(ano, mes - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** O mês inteiro no fuso de Brasília (UTC-3 fixo). */
function intervaloDoMes(mes: string) {
  const [ano, m] = mes.split("-").map(Number)
  const inicio = new Date(Date.UTC(ano, m - 1, 1, 3))
  const fim = new Date(Date.UTC(ano, m, 1, 3))
  return { inicio, fim }
}

export async function notasDoMes(loja: string, mes: string, comCanceladas: boolean) {
  const { inicio, fim } = intervaloDoMes(mes)
  return db.notaFiscalEmitida.findMany({
    where: {
      loja,
      ambiente: "producao",
      status: { in: comCanceladas ? ["autorizado", "cancelado"] : ["autorizado"] },
      criadaEm: { gte: inicio, lt: fim },
    },
    orderBy: [{ modelo: "asc" }, { criadaEm: "asc" }],
  })
}

type Nota = Awaited<ReturnType<typeof notasDoMes>>[number]

export type ResumoDoMes = {
  porModelo: {
    modelo: string
    autorizadas: number
    totalAutorizadas: number
    canceladas: number
  }[]
  quantidade: number
  total: number
}

export function resumir(notas: Nota[]): ResumoDoMes {
  const porModelo = new Map<string, ResumoDoMes["porModelo"][number]>()
  for (const n of notas) {
    const linha = porModelo.get(n.modelo) ?? {
      modelo: n.modelo,
      autorizadas: 0,
      totalAutorizadas: 0,
      canceladas: 0,
    }
    if (n.status === "autorizado") {
      linha.autorizadas++
      linha.totalAutorizadas = arredondar(linha.totalAutorizadas + n.valorTotal)
    } else {
      linha.canceladas++
    }
    porModelo.set(n.modelo, linha)
  }
  const lista = [...porModelo.values()].sort((a, b) => b.modelo.localeCompare(a.modelo))
  return {
    porModelo: lista,
    quantidade: notas.length,
    total: arredondar(lista.reduce((s, l) => s + l.totalAutorizadas, 0)),
  }
}

const rotulo = (modelo: string) => (modelo === "nfe" ? "NF-e" : "NFC-e")

/** Busca os XMLs na Focus, poucos de cada vez para não martelar a API. */
async function baixarXmls(notas: Nota[]) {
  const arquivos: Record<string, Uint8Array> = {}
  const faltando: string[] = []
  const fila = [...notas]
  const trabalhar = async () => {
    for (let n = fila.shift(); n; n = fila.shift()) {
      const nome = `${n.chave ?? n.ref}-${n.modelo}.xml`
      const endereco = urlDoArquivo(n.caminhoXml)
      if (!endereco) {
        faltando.push(`${rotulo(n.modelo)} ${n.numero ?? n.ref}`)
        continue
      }
      try {
        const r = await fetch(endereco, { signal: AbortSignal.timeout(20000) })
        if (!r.ok) throw new Error(String(r.status))
        arquivos[nome] = new Uint8Array(await r.arrayBuffer())
      } catch {
        faltando.push(`${rotulo(n.modelo)} ${n.numero ?? n.ref}`)
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, trabalhar))
  return { arquivos, faltando }
}

function csv(notas: Nota[], resumo: ResumoDoMes) {
  const linhas = [
    "modelo;numero;serie;data;chave;situacao;valor;destinatario",
    ...notas.map((n) =>
      [
        rotulo(n.modelo),
        n.numero ?? "",
        n.serie ?? "",
        n.criadaEm.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
        n.chave ?? "",
        n.status === "autorizado" ? "autorizada" : "cancelada",
        n.valorTotal.toFixed(2).replace(".", ","),
        (n.destinatarioNome ?? "").replace(/;/g, ","),
      ].join(";")
    ),
    "",
    ...resumo.porModelo.map(
      (m) =>
        `${rotulo(m.modelo)};autorizadas ${m.autorizadas};canceladas ${m.canceladas};;;total;${m.totalAutorizadas.toFixed(2).replace(".", ",")}`
    ),
    `TOTAL;;;;;;${resumo.total.toFixed(2).replace(".", ",")}`,
  ]
  // BOM: o Excel abre com acento certo.
  return new TextEncoder().encode("﻿" + linhas.join("\r\n"))
}

export async function montarZip(loja: string, mes: string, comCanceladas: boolean) {
  const notas = await notasDoMes(loja, mes, comCanceladas)
  const resumo = resumir(notas)
  const { arquivos, faltando } = await baixarXmls(notas)
  arquivos["resumo.csv"] = csv(notas, resumo)
  return {
    zip: zipSync(arquivos, { level: 6 }),
    nome: `xml-${loja}-${mes}.zip`,
    resumo,
    faltando,
  }
}

export async function enviarAoContador(entrada: {
  loja: string
  mes: string
  para: string
  comCanceladas: boolean
  quem: string
}): Promise<{ ok: true; mensagem: string } | { ok: false; erro: string }> {
  const para = entrada.para.trim()
  if (!emailValido(para)) return { ok: false, erro: "E-mail da contadora inválido" }
  if (!mesValido(entrada.mes)) return { ok: false, erro: "Mês inválido" }

  const loja = await db.loja.findUnique({ where: { codigo: entrada.loja } })
  if (!loja) return { ok: false, erro: "Loja não encontrada" }

  const { zip, nome, resumo, faltando } = await montarZip(entrada.loja, entrada.mes, entrada.comCanceladas)
  if (resumo.quantidade === 0) return { ok: false, erro: "Nenhuma nota neste mês para esta loja" }
  // Mandar ZIP faltando XML é mandar o fechamento errado sem ninguém saber.
  if (faltando.length > 0) {
    return {
      ok: false,
      erro: `Não deu para baixar o XML de ${faltando.length} nota(s) na Focus (${faltando.slice(0, 5).join(", ")}${faltando.length > 5 ? "…" : ""}). Tente de novo em instantes.`,
    }
  }

  const [ano, m] = entrada.mes.split("-")
  const empresa = loja.razaoSocial ?? loja.nome
  const cnpj = loja.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
  const linhas = [
    "Olá,",
    "",
    `Seguem os XMLs das notas de saída de ${m}/${ano} — ${empresa} (CNPJ ${cnpj}).`,
    "",
    ...resumo.porModelo.map(
      (x) =>
        `${rotulo(x.modelo)}: ${x.autorizadas} autorizada(s), total ${moeda(x.totalAutorizadas)}` +
        (x.canceladas ? `; ${x.canceladas} cancelada(s), fora do total` : "")
    ),
    `Total das autorizadas: ${moeda(resumo.total)}`,
    "",
    "No ZIP vai um XML por nota e o resumo.csv com a lista.",
    "",
    empresa,
  ]

  const r = await enviarEmail({
    para,
    assunto: `XML das notas ${m}/${ano} — ${empresa}`,
    texto: linhas.join("\n"),
    html: linhas.map((l) => (l ? `<p>${escapar(l)}</p>` : "")).join(""),
    anexos: [{ nome, conteudo: Buffer.from(zip), tipo: "application/zip" }],
  })
  if (!r.ok) return r

  await db.envioAoContador.create({
    data: {
      loja: entrada.loja,
      mes: entrada.mes,
      para,
      enviadoPor: entrada.quem,
      quantidade: resumo.quantidade,
      total: resumo.total,
      comCanceladas: entrada.comCanceladas,
    },
  })
  return { ok: true, mensagem: `Enviado para ${para}: ${resumo.quantidade} nota(s), ${moeda(resumo.total)}` }
}

/** Os envios mais recentes, e o e-mail do último — o que vem preenchido. */
export async function enviosRecentes(lojas: string[]) {
  return db.envioAoContador.findMany({
    where: { loja: { in: lojas } },
    orderBy: { enviadoEm: "desc" },
    take: 24,
  })
}
