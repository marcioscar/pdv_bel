import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"

export type Atalho = {
  tecla: string
  rotulo: string
  acao: () => void
  destrutivo?: boolean
  desabilitado?: boolean
}

export function BarraAtalhos({ atalhos }: { atalhos: Atalho[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-border px-5 py-3">
      {atalhos.map((atalho) => (
        <Button
          key={atalho.tecla}
          type="button"
          tabIndex={-1}
          variant={atalho.destrutivo ? "destructive" : "outline"}
          size="sm"
          disabled={atalho.desabilitado}
          onClick={atalho.acao}
          className="rounded-lg"
        >
          <Kbd>{atalho.tecla}</Kbd>
          {atalho.rotulo}
        </Button>
      ))}
    </div>
  )
}
