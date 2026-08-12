import { Link } from "react-router"
import { ArrowRight } from "lucide-react"

import type { Route } from "./+types/admin.inicio"
import { db } from "~/lib/db.server"
import { secoesAdminDoPapel } from "~/lib/permissoes"
import { exigirUsuario } from "~/lib/sessao.server"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Administração — BrasSaco" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  // Contagens só para a tela dizer o tamanho de cada coisa; nada aqui é secreto.
  const [produtos, clientes, usuarios, aReceber] = await Promise.all([
    db.produto.count(),
    db.cliente.count(),
    db.usuario.count({ where: { ativo: true } }),
    db.cobranca.count({ where: { situacao: "A_RECEBER", loja: eu.loja } }),
  ])

  return { eu, numeros: { produtos, clientes, usuarios, aReceber } }
}

export default function AdminInicio({ loaderData }: Route.ComponentProps) {
  const { eu, numeros } = loaderData

  const detalhe: Record<string, string> = {
    "/admin/produtos": `${numeros.produtos.toLocaleString("pt-BR")} no catálogo`,
    "/admin/clientes": `${numeros.clientes} ${numeros.clientes === 1 ? "cadastrado" : "cadastrados"}`,
    "/admin/estoque": "entrada de mercadoria e saldo contado",
    "/admin/relatorios": `${numeros.aReceber} ${numeros.aReceber === 1 ? "boleto" : "boletos"} a receber`,
    "/admin/usuarios": `${numeros.usuarios} ${numeros.usuarios === 1 ? "ativo" : "ativos"}`,
  }

  return (
    <div className="p-6">
      <h1 className="text-base font-semibold">Administração</h1>
      <p className="mt-1 text-xs text-muted-foreground">
        O que se resolve sentado. O balcão fica na barra de cima.
      </p>

      <div className="mt-5 grid max-w-3xl gap-3 sm:grid-cols-2">
        {secoesAdminDoPapel(eu.papel).map((secao) => (
          <Link
            key={secao.para}
            to={secao.para}
            className="group rounded-xl border border-border p-4 transition-colors hover:bg-muted/40"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{secao.rotulo}</span>
              <ArrowRight
                className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{secao.descricao}</p>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground tabular-nums">
              {detalhe[secao.para]}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
