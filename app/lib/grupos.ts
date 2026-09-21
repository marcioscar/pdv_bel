/**
 * O grupo do produto — a parte que a tela também precisa.
 *
 * Mora fora do `.server` porque o `<select>` do formulário monta as opções a
 * partir de `TIPOS`, e importar o módulo do servidor no componente arrasta o
 * Prisma para o bundle do navegador. A regra de negócio que depende do banco
 * fica em `grupos.server.ts`.
 */

export const TIPOS = [
  { valor: "padrao", rotulo: "Padrão", ajuda: "Mercadoria de prateleira. Entra na curva ABC." },
  {
    valor: "encomenda",
    rotulo: "Encomenda",
    ajuda: "Feito sob medida para um cliente. Fica fora da ABC e do giro.",
  },
] as const

export type TipoDeGrupo = (typeof TIPOS)[number]["valor"]

export function ehTipoValido(valor: string): valor is TipoDeGrupo {
  return TIPOS.some((t) => t.valor === valor)
}

export function rotuloDoTipo(tipo: string) {
  return TIPOS.find((t) => t.valor === tipo)?.rotulo ?? tipo
}

export function ajudaDoTipo(tipo: string) {
  return TIPOS.find((t) => t.valor === tipo)?.ajuda
}
