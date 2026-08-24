/**
 * Manda uma página do próprio sistema para a impressora, sem abrir aba.
 *
 * O documento é baixado como blob e posto num iframe oculto, cujo `print()` abre
 * a caixa de impressão. Abrir numa aba obrigaria o operador a achá-la, apertar
 * Ctrl+P e fechá-la — três passos com cliente esperando.
 *
 * Quatro detalhes que fazem isso funcionar, todos aprendidos medindo em Chrome:
 *
 * - o iframe NÃO pode ser removido logo depois: remover cancela a impressão que
 *   ainda está na tela. Ele sai um minuto depois, junto com o blob.
 * - o foco precisa VOLTAR. Focar o iframe é necessário para o `print()` sair, mas
 *   o foco fica lá dentro, e o teclado do operador morre: o Enter deixa de fechar
 *   o diálogo. Como `print()` bloqueia até a caixa fechar, devolver na linha
 *   seguinte funciona.
 * - em Chromium headless o `onload` do iframe nunca dispara para PDF, então teste
 *   automatizado desse caminho precisa de navegador de verdade.
 * - se o `print()` falhar, abre numa aba — um passo extra é melhor que nada.
 *
 * Para não aparecer a caixa de impressão a cada venda, o Chrome do caixa deve ser
 * aberto com `--kiosk-printing`: aí ele imprime direto na impressora padrão. O
 * README tem o atalho pronto por sistema, e as duas pegadinhas — a impressora
 * padrão precisa ser a térmica, e nenhuma janela do Chrome pode estar aberta
 * antes, senão a flag é ignorada.
 */
export async function imprimirDocumento(url: string): Promise<string | null> {
  let endereco: string

  try {
    const resposta = await fetch(url)
    if (!resposta.ok) {
      // O servidor manda o motivo no corpo; mostrar "erro 503" esconderia a solução.
      const motivo = (await resposta.text().catch(() => "")).trim()
      return motivo || `Não foi possível gerar o documento (${resposta.status})`
    }
    endereco = URL.createObjectURL(await resposta.blob())
  } catch {
    return "Falha ao gerar o documento para impressão"
  }

  const quadro = document.createElement("iframe")
  quadro.setAttribute("aria-hidden", "true")
  quadro.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden"
  quadro.src = endereco

  const limpar = () => {
    setTimeout(() => {
      quadro.remove()
      URL.revokeObjectURL(endereco)
    }, 60_000)
  }

  quadro.onload = () => {
    const focoAnterior = document.activeElement as HTMLElement | null
    try {
      quadro.contentWindow?.focus()
      quadro.contentWindow?.print()
    } catch {
      window.open(endereco, "_blank", "noreferrer")
    } finally {
      window.focus()
      focoAnterior?.focus?.()
    }
    limpar()
  }
  quadro.onerror = () => {
    window.open(endereco, "_blank", "noreferrer")
    limpar()
  }

  document.body.appendChild(quadro)
  return null
}
