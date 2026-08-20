import { Form, Link, useLocation } from "react-router"
import { LogOut, Moon, SlidersHorizontal, Store, Sun } from "lucide-react"

import { AvisosDoTopo } from "~/components/pdv/avisos-topo"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { rotuloDoPapel, secoesDoPapel } from "~/lib/permissoes"
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

        {/* Rola em vez de estourar: com cinco itens e um celular estreito, o que
            não cabe fica alcançável pelo dedo em vez de sumir fora da tela. */}
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-1 [&::-webkit-scrollbar]:hidden">
          {secoesDoPapel(papel).map((secao) => {
            // A administração é a única com ícone: ela não é uma seção de turno, e
            // o ícone marca essa diferença sem precisar de separador.
            const Icone = secao.para === "/admin" ? SlidersHorizontal : null
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
                {Icone ? <Icone className="size-3.5" aria-hidden /> : null}
                {secao.rotulo}
                {/* Tecla de função em celular é ruído: não há teclado. */}
                {secao.tecla ? (
                  <Kbd className="hidden text-[9px] lg:inline-flex">Ctrl {secao.tecla}</Kbd>
                ) : null}
              </Button>
            )
          })}
        </nav>

        {/* A loja é a única informação de contexto no topo. O selo "Caixa 01" saiu:
            é um caixa por loja, então o número não distinguia nada e competia com a
            loja pela atenção — que é justamente o que não pode passar batido. */}
        {/* Âmbar, não azul nem vermelho: azul é ação comum e passa batido, vermelho
            significa erro. Aqui o recado é "confira antes de vender" — a venda vai
            para a loja escrita aqui, e reparar nisso depois custa estorno. */}
        <Button
          render={<Link to={`/loja?destino=${encodeURIComponent(pathname)}`} />}
          nativeButton={false}
          tabIndex={-1}
          variant="secondary"
          size="sm"
          className={cn(
            "rounded-lg border font-mono text-sm font-bold",
            "border-amber-400 bg-amber-100 text-amber-950 hover:bg-amber-200",
            "dark:border-amber-500/50 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30"
          )}
          title={lojasPermitidas > 1 ? "Trocar de loja" : "Loja em que você está operando"}
        >
          <Store className="size-4" aria-hidden />
          {loja}
          {lojasPermitidas > 1 ? (
            <span className="text-[9px] font-normal opacity-70">trocar</span>
          ) : null}
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground sm:gap-4">
        {/* Dentro do Topo, e não passado por cada tela: o aviso de venda travada
            precisa alcançar o gerente onde quer que ele esteja no sistema, e uma
            tela nova que esquecesse de incluí-lo seria um ponto cego. Aqui ela
            nasce coberta, como a guarda de /admin. */}
        <AvisosDoTopo papel={papel} />
        {children}
        {/* O papel substitui o rótulo fixo "Operador": quem está no caixa precisa
            saber com que poder está logado, e um selo extra ao lado seria redundante. */}
        <span className="hidden lg:inline">
          {rotuloDoPapel(papel)}{" "}
          <b className="font-semibold text-foreground">{operador}</b>
        </span>
        <span className="hidden xl:inline">{relogio ?? "--/-- --:--"}</span>
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
