import { type RouteConfig, index, route } from "@react-router/dev/routes"

export default [
  index("routes/pdv.tsx"),
  route("entrar", "routes/entrar.tsx"),
  route("sair", "routes/sair.tsx"),
  route("usuarios", "routes/usuarios.tsx"),
  route("estoque", "routes/estoque.tsx"),
  route("vendas", "routes/vendas.tsx"),
  route("vendas/:vendaId/boleto.pdf", "routes/boleto.tsx"),
  route("saude", "routes/saude.tsx"),
  route("cep/:cep", "routes/cep.tsx"),
  route("webhooks/inter/cobranca", "routes/webhook.cobranca.tsx"),
  route("welcome", "routes/home.tsx"),
] satisfies RouteConfig
