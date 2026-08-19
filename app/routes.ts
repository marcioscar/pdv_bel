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
  route("vendas/:vendaId/boleto.pdf", "routes/boleto.tsx"),
  route("vendas/:vendaId/cupom", "routes/cupom.tsx"),

  // Escritório: o layout de admin cobra a permissão declarada em lib/permissoes.
  ...prefix("admin", [
    layout("routes/admin.tsx", [
      index("routes/admin.inicio.tsx"),
      route("produtos", "routes/admin.produtos.tsx"),
      route("clientes", "routes/admin.clientes.tsx"),
      route("estoque", "routes/admin.estoque.tsx"),
      route("vendas", "routes/admin.vendas.tsx"),
      route("relatorios", "routes/admin.relatorios.tsx"),
      route("usuarios", "routes/admin.usuarios.tsx"),
    ]),
  ]),

  // Usuários morava aqui: quem tiver o link antigo continua chegando.
  route("usuarios", "routes/usuarios.tsx"),

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
