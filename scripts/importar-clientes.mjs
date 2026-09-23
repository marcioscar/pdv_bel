/**
 * Importa o cadastro de clientes do sistema antigo (exportação JSON).
 *
 *   node scripts/importar-clientes.mjs dados/clientes.json          # ensaio
 *   node scripts/importar-clientes.mjs dados/clientes.json --gravar # grava
 *
 * O que o arquivo não traz, e como se resolve:
 *
 * 1. **UF não vem.** Sai do CEP, pelas faixas dos Correios. É determinístico —
 *    a faixa 72800–72999 é Goiás (Luziânia, Valparaíso), não DF, e é aí que
 *    olhar só "começa com 7" erraria.
 *
 * 2. **DDD não vem separado.** Telefone com 10 ou 11 dígitos já traz o DDD. Com
 *    8 ou 9 só se sabe o DDD quando o CEP é do DF: lá é sempre 61. Fora dele o
 *    número entra sem DDD, que é melhor do que um DDD inventado.
 *
 * 3. **A cidade no DF vira "BRASILIA".** O arquivo tem "TAGUATINGA", "ASA SUL",
 *    "BRASILA", "BRASIIA" — a NF-e casa o município pelo nome, e no DF só existe
 *    um. A região administrativa não se perde: vai para o bairro quando ele
 *    está vazio.
 *
 * 4. **Documento sem zeros à esquerda.** "00000000191" é o CNPJ do Banco do
 *    Brasil que perdeu três zeros. Quem não fecha como CPF é testado como CNPJ
 *    completado com zeros; só entra o que fechar os dígitos verificadores.
 *
 * 5. **Sem documento válido, não entra.** `cpfCnpj` é único e obrigatório — é
 *    a chave do cliente e o que vai no boleto. "CONSUMIDOR FINAL", "devolucao
 *    qi" e afins são artefatos do sistema antigo, não clientes.
 *
 * 6. **Documento repetido: fica o cadastro mais novo.** Os antigos têm a razão
 *    social cortada em 40 caracteres; os recadastros são do mesmo CNPJ.
 *
 * 7. **Não mexe em quem já está no banco.** Os poucos que existem foram
 *    cadastrados na tela, com UF e DDD conferidos — são melhores que o arquivo.
 *    Rodar duas vezes não duplica nem sobrescreve.
 *
 * 8. **Nome fantasia só quando acrescenta.** Igual à razão social seria texto
 *    repetido na lista; o nome gravado continua sendo a razão social, que é o
 *    que vai no boleto e na nota.
 *
 * 9. **CEP com 7 dígitos.** Começando por 7 é CEP de Brasília com o último
 *    dígito cortado — não dá para adivinhar, entra como está e aparece na lista
 *    para corrigir. Os outros (Guarulhos, Diadema) perderam o zero da frente.
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
  console.error("uso: node scripts/importar-clientes.mjs <clientes.json> [--gravar]")
  process.exit(1)
}
const gravar = opcoes.includes("--gravar")
const detalhar = opcoes.includes("--detalhar")

const soDigitos = (s) => (s ?? "").replace(/\D/g, "")
const limpo = (s) => (s ?? "").replace(/\s+/g, " ").trim()

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

/**
 * Com os zeros perdidos, um mesmo número pode fechar como CPF e como CNPJ:
 * "00000000191" é CPF válido e é também o CNPJ do Banco do Brasil. No arquivo
 * são 47 casos, quase todos pessoas — só o nome desempata para empresa.
 */
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

/** Faixas de CEP dos Correios, pelos cinco primeiros dígitos. */
const FAIXAS = [
  [1000, 19999, "SP"], [20000, 28999, "RJ"], [29000, 29999, "ES"],
  [30000, 39999, "MG"], [40000, 48999, "BA"], [49000, 49999, "SE"],
  [50000, 56999, "PE"], [57000, 57999, "AL"], [58000, 58999, "PB"],
  [59000, 59999, "RN"], [60000, 63999, "CE"], [64000, 64999, "PI"],
  [65000, 65999, "MA"], [66000, 68899, "PA"], [68900, 68999, "AP"],
  [69000, 69299, "AM"], [69300, 69399, "RR"], [69400, 69899, "AM"],
  [69900, 69999, "AC"], [70000, 72799, "DF"], [72800, 72999, "GO"],
  [73000, 73699, "DF"], [73700, 76799, "GO"], [76800, 76999, "RO"],
  [77000, 77999, "TO"], [78000, 78899, "MT"], [79000, 79999, "MS"],
  [80000, 87999, "PR"], [88000, 89999, "SC"], [90000, 99999, "RS"],
]
function ufDoCep(cep) {
  if (cep.length < 5) return null
  const prefixo = Number(cep.slice(0, 5))
  return FAIXAS.find(([de, ate]) => prefixo >= de && prefixo <= ate)?.[2] ?? null
}

function cep(bruto) {
  const d = soDigitos(bruto)
  if (d.length === 7 && !d.startsWith("7")) return d.padStart(8, "0")
  return d
}

function telefone(bruto, uf) {
  const d = soDigitos(bruto).replace(/^0+/, "")
  if (d.length === 10 || d.length === 11) return { ddd: d.slice(0, 2), telefone: d.slice(2) }
  if (d.length === 8 || d.length === 9) return { ddd: uf === "DF" ? "61" : null, telefone: d }
  return { ddd: null, telefone: null }
}

/** "Deusa( 9 9557-9989 )" → nome e telefone; "61 99978-4314" → só telefone. */
function contato(bruto) {
  const nome = limpo((bruto ?? "").replace(/[^A-Za-zÀ-ÿ ]/g, " "))
  const digitos = soDigitos(bruto)
  return {
    contatoNome: nome.length >= 2 ? nome : null,
    contatoTelefone: digitos.length >= 8 ? limpo(bruto.replace(/[A-Za-zÀ-ÿ()]/g, " ")) : null,
  }
}

function inscricaoEstadual(bruto) {
  const v = limpo(bruto).toUpperCase()
  if (!v) return null
  if (/^ISENT[AO]$/.test(v)) return "ISENTO"
  const d = soDigitos(v)
  return /^\d{8,14}$/.test(d) && !/^0+$/.test(d) ? d : undefined // undefined = descartada
}

/** O sistema antigo põe ", Número S/N" no fim do complemento. */
function numeroEComplemento(numeroBruto, complementoBruto) {
  let numero = limpo(numeroBruto)
  if (/^0*$/.test(numero)) numero = ""
  let complemento = limpo(complementoBruto)
  const m = complemento.match(/,?\s*N[úu]mero\s*(\S*)\s*$/i)
  if (m) {
    complemento = limpo(complemento.slice(0, m.index))
    const n = m[1].replace(/[.,]$/, "")
    if (!numero && n && !/^S\/?N$/i.test(n)) numero = n
  }
  complemento = complemento.replace(/^[,\s]+|[,\s]+$/g, "")
  return { numero: numero || null, complemento: complemento || null }
}

const LOJA_DO_EMITENTE = { 9557: "QI", 9558: "QNE", 9559: "NRT", 9560: "SDS" }

const brutos = JSON.parse(readFileSync(arquivo, "utf8"))

const semDocumento = []
const cepIncompleto = []
const semUf = []
const ieDescartada = []
const porDocumento = new Map()
let substituidos = 0

for (const r of brutos) {
  const nome = limpo(r.tx_razao_social) || limpo(r.tx_nm_fantasia)
  const doc = documento(r.tx_cnpj_cpf, nome)
  if (!doc) {
    semDocumento.push({ id: r.nu_id_pessoa, nome, bruto: r.tx_cnpj_cpf })
    continue
  }

  const c = cep(r.cep)
  const uf = ufDoCep(c)
  if (!uf) semUf.push({ id: r.nu_id_pessoa, nome, cep: r.cep })
  if (c.length !== 8) cepIncompleto.push({ id: r.nu_id_pessoa, nome, cep: c })

  let cidade = limpo(r.cidade).toUpperCase()
  let bairro = limpo(r.bairro)
  if (uf === "DF") {
    const regiao = cidade
    cidade = "BRASILIA"
    if (!bairro && !/^BRAS[IÍ]?[LI]?[IÍ]?A$/.test(regiao)) bairro = regiao
  }

  const ie = inscricaoEstadual(r.tx_insc_estadual)
  if (ie === undefined) ieDescartada.push({ id: r.nu_id_pessoa, nome, bruto: r.tx_insc_estadual })

  const email = limpo(r.tx_email).toLowerCase()

  const fantasia = limpo(r.tx_nm_fantasia)
  const registro = {
    nome,
    // Mesma regra da tela: fantasia igual à razão social não se guarda.
    nomeFantasia: fantasia && fantasia.toUpperCase() !== nome.toUpperCase() ? fantasia : null,
    ...doc,
    endereco: limpo(r.logradouro),
    bairro,
    cidade,
    uf: uf ?? "",
    cep: c,
    ...numeroEComplemento(r.numero, r.complemento),
    email: email.includes("@") ? email : null,
    ...telefone(r.tx_telefone_pessoa, uf),
    inscricaoEstadual: ie ?? null,
    ...contato(r.tx_contato),
    contatoEmail: null,
    lojaCadastro: LOJA_DO_EMITENTE[parseInt(r.id_empresa_emitente)] ?? null,
    // Só para o relatório — não é gravado.
    _id: Number(r.nu_id_pessoa),
  }

  const anterior = porDocumento.get(doc.cpfCnpj)
  if (anterior) {
    substituidos++
    if (anterior._id > registro._id) continue
  }
  porDocumento.set(doc.cpfCnpj, registro)
}

const registros = [...porDocumento.values()]
const conta = (f) => registros.filter(f).length

console.log(`arquivo: ${arquivo}`)
console.log()
console.log(`  registros no arquivo ........ ${brutos.length}`)
console.log(`  sem documento válido ........ ${semDocumento.length}  (não entram)`)
console.log(`  documento repetido .......... ${substituidos}  (fica o mais novo)`)
console.log(`  clientes a importar ......... ${registros.length}`)
console.log(`    pessoa jurídica ........... ${conta((r) => r.tipoPessoa === "JURIDICA")}`)
console.log(`    pessoa física ............. ${conta((r) => r.tipoPessoa === "FISICA")}`)
console.log(`    UF do DF .................. ${conta((r) => r.uf === "DF")}`)
console.log(`    UF de outro estado ........ ${conta((r) => r.uf && r.uf !== "DF")}`)
console.log(`    sem UF (CEP inválido) ..... ${conta((r) => !r.uf)}`)
console.log(`    CEP incompleto ............ ${conta((r) => r.cep.length !== 8)}`)
console.log(`    com telefone .............. ${conta((r) => r.telefone)}`)
console.log(`      telefone sem DDD ........ ${conta((r) => r.telefone && !r.ddd)}`)
console.log(`    com e-mail ................ ${conta((r) => r.email)}`)
console.log(`    com inscrição estadual .... ${conta((r) => r.inscricaoEstadual)}`)
console.log(`    IE descartada (formato) ... ${ieDescartada.length}`)
console.log(`    com número no endereço .... ${conta((r) => r.numero)}`)
console.log(`    com loja de origem ........ ${conta((r) => r.lojaCadastro)}`)
console.log(`    com nome fantasia próprio . ${conta((r) => r.nomeFantasia)}`)

if (detalhar) {
  console.log("\nsem documento válido:")
  for (const d of semDocumento) console.log(`  ${d.id}  [${d.bruto}]  ${d.nome}`)
  console.log("\nCEP incompleto:")
  for (const d of cepIncompleto) console.log(`  ${d.id}  ${d.cep}  ${d.nome}`)
  console.log("\nIE descartada:")
  for (const d of ieDescartada.slice(0, 30)) console.log(`  ${d.id}  [${d.bruto}]  ${d.nome}`)
}

if (!gravar) {
  console.log()
  console.log("ENSAIO — nada gravado. Use --gravar para aplicar, --detalhar para as listas.")
  process.exit(0)
}

const db = new PrismaClient()

const existentes = new Set(
  (await db.cliente.findMany({ select: { cpfCnpj: true } })).map((c) => c.cpfCnpj)
)
const novos = registros
  .filter((r) => !existentes.has(r.cpfCnpj))
  .map(({ _id, ...dados }) => dados)

// Em lotes: seis mil creates um a um levariam minutos contra o banco remoto.
let criados = 0
for (let i = 0; i < novos.length; i += 500) {
  const { count } = await db.cliente.createMany({ data: novos.slice(i, i + 500) })
  criados += count
}

console.log()
console.log(`GRAVADO: ${criados} criados, ${registros.length - novos.length} já existiam (intocados).`)
await db.$disconnect()
