import { Link } from "react-router"

import { Button } from "~/components/ui/button"

/**
 * A barra de filtro que abre toda tela de escritório — Vendas da rede e Contas a
 * receber, por enquanto.
 *
 * Ficam aqui pelo mesmo motivo das células de venda: são a mesma barra. Duas
 * cópias divergiriam na altura do campo e no espaçamento, e a diferença entre
 * uma tela e a vizinha passaria por decisão de projeto em vez de descuido.
 */

/** A altura e a borda que fazem `<input type="date">` e `<select>` nativos
 *  parecerem irmãos do `<Input>` do shadcn, que é o que sobra ao lado deles. */
export const ESTILO_CAMPO =
  "h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring"

export function Campo({
  rotulo,
  children,
}: {
  rotulo: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {rotulo}
      </span>
      {children}
    </label>
  )
}

/** Os períodos prontos ("Hoje", "7 dias"): um clique no lugar de duas datas. */
export function Atalho({ rotulo, onClick }: { rotulo: string; onClick: () => void }) {
  return (
    <Button type="button" size="sm" variant="outline" onClick={onClick} className="rounded-lg">
      {rotulo}
    </Button>
  )
}

export function Pagina({
  params,
  para,
  ativa,
  children,
}: {
  params: URLSearchParams
  para: number
  ativa: boolean
  children: React.ReactNode
}) {
  if (!ativa) {
    return <span className="text-muted-foreground/40">{children}</span>
  }
  // Preserva o filtro inteiro e troca só a página — montar a URL do zero perderia
  // o período e traria a página 2 de outra consulta.
  const proximos = new URLSearchParams(params)
  proximos.set("pagina", String(para))
  return (
    <Link to={{ search: `?${proximos}` }} className="underline">
      {children}
    </Link>
  )
}
