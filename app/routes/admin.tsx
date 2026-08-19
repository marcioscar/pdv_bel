import { useEffect, useState } from "react"
import { Link, Outlet, useLocation } from "react-router"
import { ChevronRight, Package, Receipt, Users, Wallet, type LucideIcon } from "lucide-react"

import type { Route } from "./+types/admin"
import { Topo } from "~/components/pdv/topo"
import { useAtalhosDeSecao } from "~/lib/navegacao"
import {
  ehGerente,
  grupoDaSecao,
  gruposAdminDoPapel,
  secaoAdminDoCaminho,
} from "~/lib/permissoes"
import { exigirUsuario } from "~/lib/sessao.server"
import { useRelogio, useTema } from "~/lib/tema"
import { cn } from "~/lib/utils"

/** Um ícone por GRUPO, não por tela: o submenu já é lido pelo texto indentado. */
const ICONES: Record<string, LucideIcon> = {
  produtos: Package,
  vendas: Receipt,
  financeiro: Wallet,
  cadastros: Users,
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

  const grupos = gruposAdminDoPapel(eu.papel)

  /**
   * Abre o grupo da tela em que se está, e deixa os outros como o usuário os
   * deixou. Fechar tudo a cada navegação esconderia a tela vizinha justamente na
   * hora em que ela é a mais provável — quem está em Catálogo vai para Entradas.
   */
  const grupoAtivo = grupoDaSecao(pathname)
  const [abertos, setAbertos] = useState<string[]>(grupoAtivo ? [grupoAtivo] : [])

  useEffect(() => {
    if (grupoAtivo) setAbertos((atuais) => (atuais.includes(grupoAtivo) ? atuais : [...atuais, grupoAtivo]))
  }, [grupoAtivo])

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-card text-foreground">
      <Topo
        operador={eu.nome}
        papel={eu.papel}
        loja={eu.loja}
        lojasPermitidas={eu.lojasPermitidas.length}
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
          {grupos.map((grupo) => {
            const Icone = ICONES[grupo.id] ?? Package
            const aberto = abertos.includes(grupo.id)
            const contemAtiva = grupo.secoes.some((secao) => secao.para === pathname)

            return (
              <div key={grupo.id}>
                <button
                  type="button"
                  aria-expanded={aberto}
                  onClick={() =>
                    setAbertos((atuais) =>
                      aberto
                        ? atuais.filter((id) => id !== grupo.id)
                        : [...atuais, grupo.id]
                    )
                  }
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                    // Grupo fechado com a tela ativa dentro precisa se distinguir:
                    // senão, some da tela qualquer pista de onde se está.
                    contemAtiva && !aberto
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground hover:bg-card hover:text-foreground"
                  )}
                >
                  <Icone className="size-4 shrink-0" aria-hidden />
                  <span className="flex-1 truncate text-left">{grupo.rotulo}</span>
                  <ChevronRight
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      aberto && "rotate-90"
                    )}
                    aria-hidden
                  />
                </button>

                {aberto ? (
                  <div className="mt-0.5 flex flex-col gap-0.5 pl-3">
                    {grupo.secoes.map((secao) => {
                      const ativa = pathname === secao.para
                      return (
                        <Link
                          key={secao.para}
                          to={secao.para}
                          aria-current={ativa ? "page" : undefined}
                          title={secao.descricao}
                          className={cn(
                            "rounded-lg px-3 py-1.5 text-sm transition-colors",
                            ativa
                              ? "bg-card font-semibold shadow-[inset_3px_0_0_var(--primary)]"
                              : "text-muted-foreground hover:bg-card hover:text-foreground"
                          )}
                        >
                          <span className="block truncate">{secao.rotulo}</span>
                        </Link>
                      )
                    })}
                  </div>
                ) : null}
              </div>
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
