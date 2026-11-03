/**
 * Atualiza o cadastro de clientes com uma exportação nova do sistema antigo, no
 * formato curto (id_pessoa, razao_social, nm_fantasia, cnpj_cpf, logradouro,
 * bairro, cidade, telefone1, email).
 *
 *   node scripts/atualizar-clientes.mjs "dados/clientes 2.json"          # ensaio
 *   node scripts/atualizar-clientes.mjs "dados/clientes 2.json" --gravar # grava
 *
 * Pedido do Marcio (03/11/2026), no primeiro dia de produção. Este arquivo é
 * mais pobre que o de `importar-clientes.mjs`: não traz CEP, número,
 * complemento, inscrição estadual, contato nem loja. Daí as regras:
 *
 * - **Cliente novo entra** com o que o arquivo tem. Sem CEP não há UF pela
 *   faixa dos Correios; a cidade decide só o DF (Brasília e as regiões
 *   administrativas viram "BRASILIA", como no outro script). Fora do DF a UF
 *   fica vazia e o cliente aparece na lista para completar — boleto e nota
 *   precisam dela, e uma UF chutada pela cidade erraria sem avisar.
 * - **Cliente que já existe só ganha o que falta** (telefone, e-mail, nome
 *   fantasia). Nome e endereço do banco não são sobrescritos: o banco tem CEP e
 *   número que o arquivo não tem, e onde os nomes divergem o arquivo costuma
 *   estar pior (razão social cortada em 40 caracteres, erro de digitação). As
 *   divergências são listadas para conferir à mão.
 * - **Fornecedor não vira cliente.** Este arquivo é o cadastro de pessoas
 *   inteiro do sistema antigo, e mistura quem compra com quem vende para a
 *   rede: dos 109 documentos novos de 03/11, 66 eram de fornecedores. Quem
 *   está em `fornecedores` fica de fora — e só entre os novos: quem já é
 *   cliente continua cliente, porque há empresa que é as duas coisas.
 * - **Documento**, dígitos verificadores, zeros perdidos e repetidos: mesmas
 *   regras de `importar-clientes.mjs`.
 */
import { readFileSync } from "node:fs"
import { PrismaClient } from "@prisma/client"

for (const linha of readFileSync(".env", "utf8").split("\n")) {
  const i = linha.indexOf("=")
  if (i < 1 || linha.trim().startsWith("#")) continue
  const chave = linha.slice(0, i).trim()
  if (process.env[chave] === undefined) {
    process.env[chave] = linha.slice(i + 1).trim().replace(/^["']|["']$/g, "")
  }
}

const [arquivo, ...opcoes] = process.argv.slice(2)
if (!arquivo) {
  console.error('uso: node scripts/atualizar-clientes.mjs "<clientes.json>" [--gravar]')
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")

const soDigitos = (s) => (s ?? "").replace(/\D/g, "")
const limpo = (s) => (s ?? "").replace(/\s+/g, " ").trim()
const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "")

/** Os mesmos dígitos verificadores de app/lib/documento.ts. */
function validarCpf(c) {
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false
  for (const n of [9, 10]) {
    let soma = 0
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i)
    if (((soma * 10) % 11) % 10 !== Number(c[n])) return false
  }
  return true
}
function validarCnpj(c) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false
  const base = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  for (const n of [12, 13]) {
    const pesos = base.slice(base.length - n)
    let soma = 0
    for (let i = 0; i < n; i++) soma += Number(c[i]) * pesos[i]
    const resto = soma % 11
    if ((resto < 2 ? 0 : 11 - resto) !== Number(c[n])) return false
  }
  return true
}

/** Mesma regra de `importar-clientes.mjs`: o nome desempata CPF de CNPJ sem zeros. */
const PARECE_EMPRESA = /\b(BANCO|LTDA|S\.?\/?A|EIRELI|ME|EPP)\b/i

function documento(bruto, nome) {
  const d = soDigitos(bruto)
  if (!d || /^0+$/.test(d)) return null
  if (d.length < 14 && PARECE_EMPRESA.test(nome) && validarCnpj(d.padStart(14, "0"))) {
    return { cpfCnpj: d.padStart(14, "0"), tipoPessoa: "JURIDICA" }
  }
  if (d.length <= 11 && validarCpf(d.padStart(11, "0"))) {
    return { cpfCnpj: d.padStart(11, "0"), tipoPessoa: "FISICA" }
  }
  if (d.length <= 14 && validarCnpj(d.padStart(14, "0"))) {
    return { cpfCnpj: d.padStart(14, "0"), tipoPessoa: "JURIDICA" }
  }
  return null
}

/** Brasília e as regiões administrativas que aparecem como "cidade" no arquivo. */
const DO_DF = new Set([
  "BRASILIA", "BRASILA", "BRASIIA", "DF", "DISTRITO FEDERAL", "ASA SUL", "ASA NORTE",
  "TAGUATINGA", "CEILANDIA", "SAMAMBAIA", "GAMA", "GUARA", "GUARA I", "GUARA II",
  "SOBRADINHO", "PLANALTINA", "BRAZLANDIA", "RECANTO DAS EMAS", "RIACHO FUNDO",
  "RIACHO FUNDO I", "RIACHO FUNDO II", "SANTA MARIA", "SAO SEBASTIAO", "PARANOA",
  "NUCLEO BANDEIRANTE", "CANDANGOLANDIA", "CRUZEIRO", "LAGO SUL", "LAGO NORTE",
  "SUDOESTE", "OCTOGONAL", "AGUAS CLARAS", "VICENTE PIRES", "ESTRUTURAL", "ITAPOA",
  "VARJAO", "JARDIM BOTANICO", "PARK WAY", "SIA", "SCIA", "FERCAL", "SOL NASCENTE",
  "POR DO SOL", "ARNIQUEIRA", "ARNIQUEIRAS", "NOROESTE",
])

function telefone(bruto, uf) {
  const d = soDigitos(bruto).replace(/^0+/, "")
  if (d.length === 10 || d.length === 11) return { ddd: d.slice(0, 2), telefone: d.slice(2) }
  if (d.length === 8 || d.length === 9) return { ddd: uf === "DF" ? "61" : null, telefone: d }
  return { ddd: null, telefone: null }
}

const brutos = JSON.parse(readFileSync(arquivo, "utf8").replace(/^﻿/, ""))

const semDocumento = []
const porDocumento = new Map()
let repetidos = 0

for (const r of brutos) {
  const nome = limpo(r.razao_social) || limpo(r.nm_fantasia)
  const doc = documento(r.cnpj_cpf, nome)
  if (!doc) {
    semDocumento.push({ id: r.id_pessoa, nome, bruto: r.cnpj_cpf })
    continue
  }

  let cidade = semAcento(limpo(r.cidade)).toUpperCase()
  let bairro = limpo(r.bairro)
  const df = DO_DF.has(cidade)
  if (df) {
    if (!bairro && !/^BRAS/.test(cidade)) bairro = cidade
    cidade = "BRASILIA"
  }
  const uf = df ? "DF" : ""

  const email = limpo(r.email).toLowerCase()
  const fantasia = limpo(r.nm_fantasia)
  const registro = {
    nome,
    nomeFantasia: fantasia && fantasia.toUpperCase() !== nome.toUpperCase() ? fantasia : null,
    ...doc,
    endereco: limpo(r.logradouro),
    bairro,
    cidade,
    uf,
    cep: "",
    email: email.includes("@") ? email : null,
    ...telefone(r.telefone1, uf),
    _id: Number(r.id_pessoa),
  }

  const anterior = porDocumento.get(doc.cpfCnpj)
  if (anterior) {
    repetidos++
    if (anterior._id > registro._id) continue
  }
  porDocumento.set(doc.cpfCnpj, registro)
}

const db = new PrismaClient()
const banco = new Map((await db.cliente.findMany()).map((c) => [c.cpfCnpj, c]))
const fornecedores = new Set(
  (await db.fornecedor.findMany({ select: { documento: true } })).map((f) => f.documento).filter(Boolean)
)

const novos = []
let saoFornecedores = 0
const completar = []
const nomesDiferentes = []
const enderecosDiferentes = []

for (const r of porDocumento.values()) {
  const atual = banco.get(r.cpfCnpj)
  if (!atual) {
    if (fornecedores.has(r.cpfCnpj)) saoFornecedores++
    else novos.push(r)
    continue
  }

  const falta = {}
  if (!atual.telefone && r.telefone) {
    falta.telefone = r.telefone
    if (!atual.ddd && r.ddd) falta.ddd = r.ddd
  }
  if (!atual.email && r.email) falta.email = r.email
  if (!atual.nomeFantasia && r.nomeFantasia && r.nomeFantasia.toUpperCase() !== atual.nome.toUpperCase()) {
    falta.nomeFantasia = r.nomeFantasia
  }
  if (Object.keys(falta).length) completar.push({ id: atual.id, nome: atual.nome, falta })

  if (r.nome && r.nome.toUpperCase() !== atual.nome.toUpperCase()) {
    nomesDiferentes.push({ banco: atual.nome, arquivo: r.nome })
  }
  if (r.endereco && semAcento(r.endereco).toUpperCase() !== semAcento(atual.endereco).toUpperCase()) {
    enderecosDiferentes.push({ nome: atual.nome, banco: atual.endereco, arquivo: r.endereco })
  }
}

const soNoBanco = [...banco.keys()].filter((d) => !porDocumento.has(d)).length

console.log(`arquivo: ${arquivo}`)
console.log()
console.log(`  registros no arquivo ........ ${brutos.length}`)
console.log(`  sem documento válido ........ ${semDocumento.length}  (não entram)`)
console.log(`  documento repetido .......... ${repetidos}  (fica o mais novo)`)
console.log(`  clientes no arquivo ......... ${porDocumento.size}`)
console.log(`  clientes no banco ........... ${banco.size}  (${soNoBanco} não estão no arquivo — ficam)`)
console.log(`  fornecedores fora do banco .. ${saoFornecedores}  (não viram cliente)`)
console.log()
console.log(`  NOVOS ....................... ${novos.length}`)
console.log(`    do DF ..................... ${novos.filter((r) => r.uf === "DF").length}`)
console.log(`    sem UF (fora do DF) ....... ${novos.filter((r) => !r.uf).length}  (completar antes de boleto/nota)`)
console.log(`  JÁ EXISTENTES a completar ... ${completar.length}`)
console.log(`    telefone .................. ${completar.filter((c) => c.falta.telefone).length}`)
console.log(`    e-mail .................... ${completar.filter((c) => c.falta.email).length}`)
console.log(`    nome fantasia ............. ${completar.filter((c) => c.falta.nomeFantasia).length}`)

console.log("\nnovos:")
for (const r of novos) {
  console.log(`  ${r.cpfCnpj.padEnd(14)} ${(r.uf || "??").padEnd(2)} ${r.nome}  · ${r.cidade}`)
}
console.log("\nnome diferente (fica o do banco):")
for (const d of nomesDiferentes) console.log(`  banco: ${d.banco}\n     arquivo: ${d.arquivo}`)
console.log("\nendereço diferente (fica o do banco):")
for (const d of enderecosDiferentes) console.log(`  ${d.nome}\n     banco: ${d.banco}\n     arquivo: ${d.arquivo}`)

if (!gravar) {
  console.log("\nENSAIO — nada gravado. Use --gravar para aplicar.")
  await db.$disconnect()
  process.exit(0)
}

const dados = novos.map(({ _id, ...r }) => r)
let criados = 0
for (let i = 0; i < dados.length; i += 500) {
  criados += (await db.cliente.createMany({ data: dados.slice(i, i + 500) })).count
}
for (const c of completar) await db.cliente.update({ where: { id: c.id }, data: c.falta })

console.log(`\nGRAVADO: ${criados} criados, ${completar.length} completados. Nome e endereço de quem já existia não mudaram.`)
await db.$disconnect()
