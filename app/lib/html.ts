/**
 * Escapa texto que vai entrar num HTML montado à mão.
 *
 * Os documentos que a gente imprime — cupom, folha de conferência — são
 * template literal, não JSX, então nada escapa sozinho. Um cliente cadastrado
 * como `Bar & Cia <matriz>` quebraria a página, e um cadastrado com uma tag
 * dentro do nome faria pior. Uma função só, para as duas telas não terem
 * versões diferentes do que é seguro.
 */
export function escapar(texto: string) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
