/**
 * Como cada tipo de movimento se apresenta na ficha.
 *
 * Módulo puro: a ficha roda no cliente e o servidor grava os tipos. Uma tabela
 * só, para o nome que aparece na tela não divergir do que foi gravado — e para
 * um tipo novo não passar despercebido com uma linha em branco.
 */
export const TIPOS_DE_MOVIMENTO: Record<string, { rotulo: string; ajuda: string }> = {
  venda: { rotulo: "Venda", ajuda: "Saída pelo caixa" },
  entrada: { rotulo: "Entrada", ajuda: "Mercadoria recebida do fornecedor" },
  ajuste: { rotulo: "Inventário", ajuda: "Diferença lançada até o saldo contado" },
  estorno: { rotulo: "Estorno", ajuda: "Devolução de uma saída — venda cancelada ou carga que voltou" },
  transferencia_saida: { rotulo: "Transf. saída", ajuda: "Despachada para outra loja" },
  transferencia_entrada: { rotulo: "Transf. entrada", ajuda: "Conferida na chegada" },
}

export function rotuloDoTipo(tipo: string) {
  return TIPOS_DE_MOVIMENTO[tipo]?.rotulo ?? tipo
}

export function ajudaDoTipo(tipo: string) {
  return TIPOS_DE_MOVIMENTO[tipo]?.ajuda ?? ""
}
