import { useEffect } from "react"
import { useNavigate } from "react-router"

const DESTINOS: Record<string, string> = {
  F1: "/",
  F2: "/estoque",
  F3: "/vendas",
}

/**
 * Ctrl+F1 / Ctrl+F2 / Ctrl+F3 trocam de tela.
 *
 * São teclas de função de propósito: Ctrl+C e Ctrl+V são copiar e colar, e
 * Ctrl+1..4 / Ctrl+T são reservados pelo Chrome e pelo Edge — a página não
 * consegue interceptá-los. Ctrl+F<n> não colide com nada no navegador, e o
 * `key` de tecla de função é igual em todo sistema, sem composição de caractere.
 */
export function useAtalhosDeSecao(ativo = true) {
  const navegar = useNavigate()

  useEffect(() => {
    if (!ativo) return

    function aoTeclar(evento: KeyboardEvent) {
      if (!evento.ctrlKey || evento.shiftKey || evento.altKey || evento.metaKey) return

      const destino = DESTINOS[evento.key]
      if (!destino) return

      evento.preventDefault()
      navegar(destino)
    }

    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [ativo, navegar])
}
