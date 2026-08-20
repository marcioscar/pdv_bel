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

/**
 * Relógio da barra superior; começa nulo para não divergir do SSR.
 *
 * Formato curto de propósito: "20/8 qui 15:52". O ano saiu porque numa barra de
 * loja ele nunca é a dúvida, e o dia da semana entrou porque essa É a dúvida —
 * quem passa o dia no balcão perde a conta com facilidade, e o prazo do boleto
 * e a sexta do fechamento dependem dela.
 */
export function useRelogio() {
  const [relogio, setRelogio] = useState<string | null>(null)

  useEffect(() => {
    const tick = () => {
      const agora = new Date()
      // "qui." vem com ponto do Intl; sem ele o texto fica mais limpo ao lado
      // dos números, que é o que a barra tem de sobra.
      const semana = new Intl.DateTimeFormat("pt-BR", { weekday: "short" })
        .format(agora)
        .replace(".", "")
      const hora = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" }).format(agora)

      setRelogio(`${agora.getDate()}/${agora.getMonth() + 1} ${semana} ${hora}`)
    }
    tick()
    const id = setInterval(tick, 20_000)
    return () => clearInterval(id)
  }, [])

  return relogio
}
