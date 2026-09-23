/**
 * Deixar o menu em paz: o campo de comando não deve puxar o foco de volta
 * enquanto alguém usa um menu da barra de cima.
 *
 * O caixa e a tela de entradas devolvem o foco ao campo de comando assim que ele
 * o perde: é o que deixa a próxima tecla cair sempre na barra, mesmo depois de
 * um clique num botão de atalho. Só que abrir um menu da barra de cima TAMBÉM
 * tira o foco do campo — e, puxado de volta, o menu fechava no mesmo instante:
 * abria e sumia, sem dar para escolher nada.
 *
 * Perguntar onde está o foco não basta. No Mac o navegador não dá foco a um
 * botão clicado, então na hora em que o campo decide (o quadro seguinte ao
 * blur) o foco não está em lugar nenhum e o menu ainda nem abriu. O que se sabe
 * com certeza é ONDE o mouse apertou: se foi num menu — no botão que o abre ou
 * dentro dele —, o campo espera. E enquanto um menu estiver aberto, também.
 */

const DO_MENU = '[aria-haspopup="menu"], [role="menu"]'

/** Quanto tempo um aperto num menu segura o foco longe do campo. */
const JANELA_MS = 800

let ultimoApertoEmMenu = 0

if (typeof document !== "undefined") {
  // Captura, e no documento: chega antes de qualquer tela tratar o clique, e
  // vale para toda tela sem que cada uma precise lembrar de registrar.
  document.addEventListener(
    "pointerdown",
    (evento) => {
      const alvo = evento.target
      if (alvo instanceof Element && alvo.closest(DO_MENU)) ultimoApertoEmMenu = Date.now()
    },
    true
  )
}

export function focoEmMenu() {
  if (typeof document === "undefined") return false
  if (document.querySelector('[role="menu"]')) return true
  if (document.activeElement?.closest(DO_MENU)) return true
  return Date.now() - ultimoApertoEmMenu < JANELA_MS
}
