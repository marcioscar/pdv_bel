import type { ChartConfig } from "~/components/ui/chart"

/**
 * As cores dos gráficos, validadas — não escolhidas no olho.
 *
 * Os valores saíram do validador da referência de visualização, rodado nos dois
 * modos contra as superfícies reais. O que ele mede: separação para daltonismo
 * (ΔE ≥ 8 no par adjacente mais próximo), separação para visão normal (ΔE ≥ 15),
 * faixa de luminosidade, piso de croma e contraste contra a superfície.
 *
 * NÃO usamos as `--chart-1..5` que vêm com o shadcn: são um tom só de verde-água
 * em cinco claridades. Isso é escala SEQUENCIAL — serve para magnitude (mais
 * escuro = mais), não para identidade. Quatro lojas são quatro identidades, e
 * pintá-las com claridades do mesmo tom faz "QNE" e "NRT" virarem a mesma coisa
 * num monitor ruim ou para quem não distingue bem tom.
 *
 * A ORDEM dos slots é o mecanismo de segurança, não enfeite: foi essa ordem que
 * passou nos testes de separação. Trocar por gosto ("azul para a SDS porque é a
 * cor dela") desfaz a validação.
 */

/** Slots 1 a 4 da paleta categórica, na ordem validada — claro e escuro. */
const CATEGORICAS = [
  { light: "#2a78d6", dark: "#3987e5" }, // azul
  { light: "#eb6834", dark: "#d95926" }, // laranja
  { light: "#1baf7a", dark: "#199e70" }, // aqua
  { light: "#eda100", dark: "#c98500" }, // amarelo
] as const

/**
 * A faixa ABC: um tom só, do claro ao escuro — aqui é magnitude ordenada, e a
 * escala sequencial é a forma certa. O extremo claro é o passo 250 e não o 100
 * porque abaixo disso a cor some contra a superfície (1,29:1, reprovado).
 */
export const CORES_ABC = {
  A: { light: "#184f95", dark: "#86b6ef" },
  B: { light: "#2a78d6", dark: "#3987e5" },
  C: { light: "#86b6ef", dark: "#184f95" },
} as const

/**
 * A configuração do gráfico com uma cor por loja, pela POSIÇÃO na lista.
 *
 * Pela posição, e nunca pelo ranking: se a cor seguisse o tamanho, filtrar uma
 * loja repintaria as outras, e a mesma loja mudaria de cor entre dois meses.
 */
export function configDasLojas(lojas: readonly string[]): ChartConfig {
  return Object.fromEntries(
    lojas.map((loja, i) => [
      loja,
      { label: loja, theme: CATEGORICAS[i % CATEGORICAS.length] },
    ])
  )
}

/** Uma série só — o azul do slot 1. */
export const CONFIG_VALOR = {
  valor: { label: "Valor", theme: CATEGORICAS[0] },
} satisfies ChartConfig
