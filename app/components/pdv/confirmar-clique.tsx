import { useEffect, useState } from "react"

import { Button } from "~/components/ui/button"

/**
 * Botão de ação sem volta: o primeiro clique só arma, o segundo executa.
 *
 * Para o que fica ao lado de outro botão numa lista — cancelar um pedido mora
 * a um centímetro de "Enviado", e um clique torto cancelava na hora. Um diálogo
 * inteiro seria peso demais para uma linha de lista; aqui o próprio botão muda
 * de texto e pede o segundo clique. Desarma sozinho em 4 s ou ao perder o
 * foco, para não ficar armado esperando um clique distraído.
 */
export function ConfirmarClique({
  rotulo,
  confirmacao,
  disabled,
  onConfirmar,
}: {
  rotulo: string
  confirmacao: string
  disabled?: boolean
  onConfirmar: () => void
}) {
  const [armado, setArmado] = useState(false)

  useEffect(() => {
    if (!armado) return
    const t = setTimeout(() => setArmado(false), 4000)
    return () => clearTimeout(t)
  }, [armado])

  return (
    <Button
      type="button"
      variant={armado ? "destructive" : "ghost"}
      size="xs"
      disabled={disabled}
      onBlur={() => setArmado(false)}
      onClick={() => {
        if (!armado) return setArmado(true)
        setArmado(false)
        onConfirmar()
      }}
      className={armado ? undefined : "text-destructive"}
    >
      {armado ? confirmacao : rotulo}
    </Button>
  )
}
