import { Form, Link, useLocation } from "react-router"
import { LogOut, Moon, Sun } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { rotuloDoPapel, secoesDoPapel } from "~/lib/permissoes"
import { cn } from "~/lib/utils"

type Props = {
  caixa?: string
  operador: string
  /** Decide quais seções aparecem — mesma fonte que as guardas do servidor. */
  papel: string
  relogio: string | null
  escuro: boolean
  onAlternarTema: () => void
  children?: React.ReactNode
}

export function Topo({
  caixa,
  operador,
  papel,
  relogio,
  escuro,
  onAlternarTema,
  children,
}: Props) {
  const { pathname } = useLocation()

  return (
    <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
      <div className="flex items-center gap-4">
        {/* O azul da marca é puro (#0000FF) e desaparece no fundo escuro; a placa
            branca mantém a logo legível nos dois temas. */}
        <span className="rounded-md bg-white px-2 py-1">
          <img
            src="/logo_bel.svg"
            alt="BrasSaco Embalagens"
            className="h-6 w-auto"
            width={349}
            height={86}
          />
        </span>

        <nav className="flex items-center gap-1">
          {secoesDoPapel(papel).map((secao) => {
            // Prefixo, não igualdade: /admin/produtos precisa acender "Administração".
            const ativa =
              pathname === secao.para ||
              (secao.para !== "/" && pathname.startsWith(`${secao.para}/`))
            return (
              <Button
                key={secao.para}
                render={<Link to={secao.para} />}
                // O elemento renderizado é um <a>, não um <button>.
                nativeButton={false}
                tabIndex={-1}
                variant={ativa ? "secondary" : "ghost"}
                size="sm"
                className={cn("rounded-lg", ativa && "font-semibold")}
              >
                {secao.rotulo}
                {secao.tecla ? (
                  <Kbd className="text-[9px]">Ctrl {secao.tecla}</Kbd>
                ) : null}
              </Button>
            )
          })}
        </nav>

        {caixa ? (
          <Badge variant="secondary" className="font-mono">
            Caixa {caixa}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-4 font-mono text-xs text-muted-foreground">
        {children}
        {/* O papel substitui o rótulo fixo "Operador": quem está no caixa precisa
            saber com que poder está logado, e um selo extra ao lado seria redundante. */}
        <span>
          {rotuloDoPapel(papel)}{" "}
          <b className="font-semibold text-foreground">{operador}</b>
        </span>
        <span>{relogio ?? "--/-- --:--"}</span>
        <Button
          type="button"
          tabIndex={-1}
          variant="ghost"
          size="icon-sm"
          onClick={onAlternarTema}
          aria-label="Alternar tema"
        >
          {escuro ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>

        {/* POST: um GET permitiria deslogar o operador com um link ou imagem. */}
        <Form method="post" action="/sair">
          <Button
            type="submit"
            tabIndex={-1}
            variant="ghost"
            size="icon-sm"
            aria-label="Encerrar sessão"
            title="Encerrar sessão"
          >
            <LogOut className="size-4" />
          </Button>
        </Form>
      </div>
    </header>
  )
}
