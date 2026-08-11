import { useCallback, useEffect, useState } from "react"

const CHAVE = "pdv-tema"

/**
 * A classe `dark` é aplicada pelo script inline em root.tsx antes da primeira
 * pintura; aqui só espelhamos o estado para o ícone do botão e alternamos.
 */
export function useTema() {
  const [escuro, setEscuro] = useState(false)

  useEffect(() => {
    setEscuro(document.documentElement.classList.contains("dark"))
  }, [])

  const alternar = useCallback(() => {
    const ligado = document.documentElement.classList.toggle("dark")
    localStorage.setItem(CHAVE, ligado ? "dark" : "light")
    setEscuro(ligado)
  }, [])

  return { escuro, alternar }
}

/** Relógio da barra superior; começa nulo para não divergir do SSR. */
export function useRelogio() {
  const [relogio, setRelogio] = useState<string | null>(null)

  useEffect(() => {
    const tick = () =>
      setRelogio(
        new Intl.DateTimeFormat("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date())
      )
    tick()
    const id = setInterval(tick, 20_000)
    return () => clearInterval(id)
  }, [])

  return relogio
}
