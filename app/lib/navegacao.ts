import { useEffect } from "react"
import { useNavigate } from "react-router"

import { secoesDoPapel } from "~/lib/permissoes"

/**
 * Ctrl+F1 / Ctrl+F2 / Ctrl+F3 trocam de tela.
 *
 * São teclas de função de propósito: Ctrl+C e Ctrl+V são copiar e colar, e
 * Ctrl+1..4 / Ctrl+T são reservados pelo Chrome e pelo Edge — a página não
 * consegue interceptá-los. Ctrl+F<n> não colide com nada no navegador, e o
 * `key` de tecla de função é igual em todo sistema, sem composição de caractere.
 *
 * Os destinos vêm de `secoesDoPapel`, a mesma função que monta o menu: um atalho
 * não pode levar a uma tela que o menu esconde, senão a permissão vira decoração.
 */
export function useAtalhosDeSecao(papel: string, ativo = true) {
  const navegar = useNavigate()

  useEffect(() => {
    if (!ativo) return

    function aoTeclar(evento: KeyboardEvent) {
      if (!evento.ctrlKey || evento.shiftKey || evento.altKey || evento.metaKey) return

      const secao = secoesDoPapel(papel).find((s) => s.tecla === evento.key)
      if (!secao) return

      evento.preventDefault()
      navegar(secao.para)
    }

    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [ativo, navegar, papel])
}
