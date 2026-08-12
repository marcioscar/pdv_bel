import { Link, Outlet, useLocation } from "react-router"
import {
  BarChart3,
  Boxes,
  Package,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react"

import type { Route } from "./+types/admin"
import { Topo } from "~/components/pdv/topo"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import {
  ehGerente,
  secaoAdminDoCaminho,
  secoesAdminDoPapel,
} from "~/lib/permissoes"
import { exigirUsuario } from "~/lib/sessao.server"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

const ICONES: Record<string, LucideIcon> = {
  "/admin/produtos": Package,
  "/admin/clientes": Users,
  "/admin/estoque": Boxes,
  "/admin/relatorios": BarChart3,
  "/admin/usuarios": UserCog,
}

/**
 * Layout da administração.
 *
 * A permissão é cobrada aqui, uma vez, a partir da declaração em
 * `SECOES_ADMIN` — a mesma lista que monta a sidebar. Com a guarda espalhada
 * pelas rotas filhas, a tela que alguém criasse amanhã sem lembrar do
 * `exigirGerente` nasceria aberta; assim ela nasce coberta.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)
  const secao = secaoAdminDoCaminho(new URL(request.url).pathname)

  if (secao?.somenteGerente && !ehGerente(eu.papel)) {
    throw new Response(`Só gerente acessa ${secao.rotulo}`, { status: 403 })
  }

  return { eu }
}

export default function Admin({ loaderData }: Route.ComponentProps) {
  const { eu } = loaderData
  const { pathname } = useLocation()
  const { escuro, alternar } = useTema()
  const relogio = useRelogio()
  useAtalhosDeSecao(eu.papel)

  const secoes = secoesAdminDoPapel(eu.papel)

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        relogio={relogio}
        escuro={escuro}
        onAlternarTema={alternar}
      />

      <div className="flex min-h-0 flex-1">
        {/* A sidebar vive só aqui. No caixa ela roubaria a coluna de descrição do
            produto, que é o que o operador lê com o cliente esperando. */}
        <nav
          aria-label="Administração"
          className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-muted/30 p-3"
        >
          {secoes.map((secao) => {
            const Icone = ICONES[secao.para] ?? Package
            const ativa = pathname === secao.para
            return (
              <Link
                key={secao.para}
                to={secao.para}
                aria-current={ativa ? "page" : undefined}
                title={secao.descricao}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  ativa
                    ? "bg-card font-semibold shadow-[inset_3px_0_0_var(--primary)]"
                    : "text-muted-foreground hover:bg-card hover:text-foreground"
                )}
              >
                <Icone className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{secao.rotulo}</span>
              </Link>
            )
          })}

          <p className="mt-auto px-3 text-[11px] leading-relaxed text-muted-foreground">
            O caixa e as vendas ficam na barra de cima, com{" "}
            <span className="font-mono">Ctrl F1</span> a{" "}
            <span className="font-mono">Ctrl F3</span>.
          </p>
        </nav>

        <section className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </section>
      </div>
    </main>
  )
}
