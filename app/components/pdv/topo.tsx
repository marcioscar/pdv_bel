import { Form, Link, useLocation } from "react-router"
import { ChevronDown, LogOut, Moon, SlidersHorizontal, Store, Sun } from "lucide-react"

import { AvisosDoTopo } from "~/components/pdv/avisos-topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { Kbd } from "~/components/ui/kbd"
import { ehGerente, menusDoTopo, secoesDoPapel } from "~/lib/permissoes"
import { cn } from "~/lib/utils"

type Props = {
  operador: string
  /** Decide quais seções aparecem — mesma fonte que as guardas do servidor. */
  papel: string
  /** Loja do turno. Fica em destaque: operar na loja errada não pode ser sutil. */
  loja: string
  /** Quantas lojas o usuário alcança — com uma só, não há o que trocar. */
  lojasPermitidas?: number
  relogio: string | null
  escuro: boolean
  onAlternarTema: () => void
  children?: React.ReactNode
}

export function Topo({
  operador,
  papel,
  loja,
  lojasPermitidas = 1,
  relogio,
  escuro,
  onAlternarTema,
  children,
}: Props) {
  const { pathname } = useLocation()
  // Trocar a loja do turno é do gerente: move venda, estoque e caixa de lugar.
  const podeTrocar = lojasPermitidas > 1 && ehGerente(papel)

  // Prefixo, não igualdade: /vendas/123/cupom continua sendo Vendas.
  const estaEm = (para: string) =>
    pathname === para || (para !== "/" && pathname.startsWith(`${para}/`))
  const caixa = secoesDoPapel(papel).find((secao) => secao.para === "/")
  const menus = menusDoTopo(papel)

  return (
    <header className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-2 sm:px-5 sm:py-2.5">
      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        {/* O azul da marca é puro (#0000FF) e desaparece no fundo escuro; a placa
            branca mantém a logo legível nos dois temas. */}
        <span className="hidden rounded-md bg-white px-2 py-1 sm:inline-block">
          <img
            src="/logo_bel.svg"
            alt="BrasSaco Embalagens"
            className="h-6 w-auto"
            width={349}
            height={86}
          />
        </span>

        {/*
          O Caixa sozinho, um clique: é a tela de quem tem cliente na frente. O
          resto em três menus, com os grupos da administração como submenus —
          quatro botões cabem em qualquer monitor, e a barra plana de seis itens
          rolava para o lado num de 1366, rolagem que o mouse não faz. Os atalhos
          Ctrl+F continuam valendo e aparecem ao lado de cada item.
        */}
        <nav className="flex min-w-0 items-center gap-1">
          {caixa ? (
            <Button
              render={<Link to={caixa.para} />}
              // O elemento renderizado é um <a>, não um <button>.
              nativeButton={false}
              tabIndex={-1}
              variant={estaEm(caixa.para) ? "secondary" : "ghost"}
              size="sm"
              title={caixa.tecla ? `Ctrl ${caixa.tecla}` : undefined}
              className={cn("rounded-lg", estaEm(caixa.para) && "font-semibold")}
            >
              {caixa.rotulo}
              {caixa.tecla ? (
                <Kbd className="hidden text-[9px] xl:inline-flex">Ctrl {caixa.tecla}</Kbd>
              ) : null}
            </Button>
          ) : null}

          {menus.map((menu) => {
            const ativo =
              menu.secoes.some((secao) => estaEm(secao.para)) ||
              menu.grupos.some((grupo) => grupo.secoes.some((secao) => estaEm(secao.para)))
            return (
              <DropdownMenu key={menu.id}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      tabIndex={-1}
                      variant={ativo ? "secondary" : "ghost"}
                      size="sm"
                      className={cn("rounded-lg", ativo && "font-semibold")}
                    />
                  }
                >
                  {menu.id === "adm" ? (
                    <SlidersHorizontal className="size-3.5" aria-hidden />
                  ) : null}
                  {menu.rotulo}
                  <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  {menu.secoes.map((secao) => (
                    <DropdownMenuItem
                      key={secao.para}
                      render={<Link to={secao.para} />}
                      className={cn(estaEm(secao.para) && "font-semibold")}
                    >
                      {secao.para === "/admin" ? "Painel" : secao.rotulo}
                      {secao.tecla ? (
                        <DropdownMenuShortcut>Ctrl {secao.tecla}</DropdownMenuShortcut>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                  {menu.secoes.length > 0 && menu.grupos.length > 0 ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {menu.grupos.map((grupo) => (
                    <DropdownMenuSub key={grupo.id}>
                      <DropdownMenuSubTrigger
                        className={cn(
                          grupo.secoes.some((secao) => estaEm(secao.para)) && "font-semibold"
                        )}
                      >
                        {grupo.rotulo}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-56">
                        {grupo.secoes.map((secao) => (
                          <DropdownMenuItem
                            key={secao.para}
                            render={<Link to={secao.para} />}
                            className={cn(estaEm(secao.para) && "font-semibold")}
                          >
                            {secao.rotulo}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          })}
        </nav>

        {/* A loja é a única informação de contexto no topo. O selo "Caixa 01" saiu:
            é um caixa por loja, então o número não distinguia nada e competia com a
            loja pela atenção — que é justamente o que não pode passar batido. */}
        {/* Âmbar, não azul nem vermelho: azul é ação comum e passa batido, vermelho
            significa erro. Aqui o recado é "confira antes de vender" — a venda vai
            para a loja escrita aqui, e reparar nisso depois custa estorno. */}
        {/* Só quem pode trocar recebe um link; para o operador o selo continua
            mostrando a loja, mas não promete uma tela que responderia 403. */}
        <Button
          render={
            podeTrocar ? (
              <Link to={`/loja?destino=${encodeURIComponent(pathname)}`} />
            ) : (
              <span />
            )
          }
          nativeButton={false}
          tabIndex={-1}
          variant="secondary"
          size="sm"
          className={cn(
            "rounded-lg border font-mono text-sm font-bold",
            "border-amber-400 bg-amber-100 text-amber-950 hover:bg-amber-200",
            "dark:border-amber-500/50 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30"
          )}
          title={podeTrocar ? "Trocar de loja" : "Loja em que você está operando"}
        >
          <Store className="size-4" aria-hidden />
          {loja}
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground sm:gap-4">
        {/* Dentro do Topo, e não passado por cada tela: o aviso de venda travada
            precisa alcançar o gerente onde quer que ele esteja no sistema, e uma
            tela nova que esquecesse de incluí-lo seria um ponto cego. Aqui ela
            nasce coberta, como a guarda de /admin. */}
        <AvisosDoTopo papel={papel} />
        {children}
        {/* Só o nome. O cargo saiu daqui: quem está logado já sabe com que
            poder está, e o que a barra não mostra vira espaço para o que muda —
            a loja e os avisos. O papel continua decidindo o que aparece no menu,
            que é onde ele tem efeito prático. */}
        <span className="hidden lg:inline">
          <b className="font-semibold text-foreground">{operador}</b>
        </span>
        {/* O relógio só existe depois da hidratação (o servidor não sabe a hora
            do cliente); o vazio no lugar evita o pisca de um texto falso. Cabe
            mais cedo agora que é curto — lg em vez de xl. */}
        <span className="hidden lg:inline">{relogio ?? ""}</span>
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
