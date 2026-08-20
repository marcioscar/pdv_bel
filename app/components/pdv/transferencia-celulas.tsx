import { ArrowRight } from "lucide-react"

import { Badge } from "~/components/ui/badge"

/**
 * O cabeçalho de uma remessa: número, rota e quem despachou.
 *
 * Compartilhado entre a tela do turno (onde se despacha e confere) e a da
 * administração (onde se investiga o que sumiu). Duas cópias divergiriam na
 * ordem das informações, e quem trabalha nas duas telas leria a mesma remessa
 * de jeitos diferentes conforme onde estivesse.
 */
export function CabecalhoDaTransferencia({
  transferencia: t,
}: {
  transferencia: {
    numero: number
    origem: string
    destino: string
    enviadaPor: string
    criadaEm: Date | string
  }
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-mono text-sm font-semibold">#{t.numero}</span>
      <span className="flex items-center gap-1 font-mono text-xs">
        <Badge variant="outline" className="text-[10px]">{t.origem}</Badge>
        <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
        <Badge variant="outline" className="text-[10px]">{t.destino}</Badge>
      </span>
      <span className="text-xs text-muted-foreground">
        {t.enviadaPor} ·{" "}
        {new Date(t.criadaEm).toLocaleString("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        })}
      </span>
    </div>
  )
}
