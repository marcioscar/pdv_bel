import {
  type RouteConfig,
  index,
  layout,
  prefix,
  route,
} from "@react-router/dev/routes"

export default [
  // Turno: o que se usa com cliente na frente.
  index("routes/pdv.tsx"),
  route("estoque", "routes/estoque.tsx"),
  route("vendas", "routes/vendas.tsx"),
  route("transferencias", "routes/transferencias.tsx"),
  route("fechamento", "routes/fechamento.tsx"),
  route("fechamento/:fechamentoId/papel", "routes/fechamento.papel.tsx"),
  // O comprovante do dinheiro que sai da gaveta — viaja junto com ele.
  route("sangria/:movimentoId/comprovante", "routes/sangria.comprovante.tsx"),
  // O papel que viaja com a carga. Fora de qualquer layout: é folha para imprimir.
  route("transferencias/:transferenciaId/romaneio", "routes/transferencia.romaneio.tsx"),
  route("vendas/:vendaId/boleto.pdf", "routes/boleto.tsx"),
  route("pedidos-de-compra/:pedidoId/impressao", "routes/pedido-compra.impressao.tsx"),
  route("vendas/:vendaId/cupom", "routes/cupom.tsx"),
  // O cupom diz o que o cliente levou; este diz que o dinheiro entrou.
  route("vendas/:vendaId/comprovante-pix", "routes/comprovante.pix.tsx"),

  // Escritório: o layout de admin cobra a permissão declarada em lib/permissoes.
  ...prefix("admin", [
    layout("routes/admin.tsx", [
      index("routes/admin.inicio.tsx"),
      route("produtos", "routes/admin.produtos.tsx"),
      route("clientes", "routes/admin.clientes.tsx"),
      route("fornecedores", "routes/admin.fornecedores.tsx"),
      route("estoque", "routes/admin.estoque.tsx"),
      route("ficha", "routes/admin.ficha.tsx"),
      route("perdas", "routes/admin.perdas.tsx"),
      route("compras", "routes/admin.compras.tsx"),
      route("pedido-novo", "routes/admin.pedido-novo.tsx"),
      route("pedidos-de-compra", "routes/admin.pedidos-de-compra.tsx"),
      route("notas-de-entrada", "routes/admin.notas-de-entrada.tsx"),
      route("vendas", "routes/admin.vendas.tsx"),
      route("caixas", "routes/admin.caixas.tsx"),
      route("caixas/:fechamentoId", "routes/admin.caixa.tsx"),
      route("contas-a-receber", "routes/admin.contas-a-receber.tsx"),
      route("autorizacoes", "routes/admin.autorizacoes.tsx"),
      route("relatorios", "routes/admin.relatorios.tsx"),
      route("usuarios", "routes/admin.usuarios.tsx"),
      route("certificados", "routes/admin.certificados.tsx"),
    ]),

    // Fora do layout de propósito: é folha para imprimir, e dentro dele sairia
    // com a sidebar junto. A guarda de gerente é cobrada na própria rota.
    route("contas-a-receber/impressao", "routes/contas-a-receber.impressao.tsx"),
  ]),

  // Usuários morava aqui: quem tiver o link antigo continua chegando.
  route("usuarios", "routes/usuarios.tsx"),

  // A fila do próprio vendedor: onde ele retoma a venda que o gerente liberou.
  // Fica no turno, e não em /admin, porque quem a usa está no balcão.
  route("autorizacoes", "routes/autorizacoes.tsx"),
  // Recurso consultado de tempos em tempos pelo indicador do topo.
  // Um endereço só para tudo que o topo precisa saber: autorizações esperando,
  // cargas por conferir. Uma rota por assunto viraria uma consulta por assunto,
  // em toda tela, a cada vinte segundos.
  route("avisos/contagem", "routes/avisos.contagem.tsx"),

  route("entrar", "routes/entrar.tsx"),
  route("loja", "routes/loja.tsx"),
  route("sair", "routes/sair.tsx"),
  route("saude", "routes/saude.tsx"),
  route("cep/:cep", "routes/cep.tsx"),
  // Uma URL por conta do Inter (MATRIZ, NRT, SDS). A rota sem conta continua para
  // não quebrar o webhook já registrado.
  route("webhooks/inter/cobranca", "routes/webhook.cobranca.tsx", { id: "webhook-cobranca" }),
  route("webhooks/inter/cobranca/:conta", "routes/webhook.cobranca.tsx", {
    id: "webhook-cobranca-conta",
  }),
  route("welcome", "routes/home.tsx"),
] satisfies RouteConfig
