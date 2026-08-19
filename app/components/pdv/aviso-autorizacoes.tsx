import { useEffect } from "react"
import { Link, useFetcher, useLocation } from "react-router"
import { Clock, ShieldAlert, ShieldCheck } from "lucide-react"

import { Button } from "~/components/ui/button"
import { ehGerente } from "~/lib/permissoes"
import { cn } from "~/lib/utils"

/**
 * O aviso de autorização que acompanha o usuário por todas as telas.
 *
 * Vive no topo, e não numa tela só, porque essa foi a exigência: o gerente
 * precisa saber que tem venda travada no balcão SEM ter aberto a tela certa. Uma
 * fila que só aparece quando alguém lembra de conferi-la deixa o cliente esperando
 * no balcão enquanto o gerente trabalha em outra coisa, achando que não há nada.
 *
 * Dois públicos, um componente: o gerente vê o que falta decidir, o vendedor vê
 * as vendas dele que estão esperando e as que já foram respondidas. Ninguém vê o
 * número do outro — mostrar ao operador uma fila sobre a qual ele não pode agir
 * é ruído.
 */

/** De quanto em quanto tempo pergunta ao servidor. */
const INTERVALO = 20_000

export function AvisoAutorizacoes({ papel }: { papel: string }) {
  const fetcher = useFetcher<{
    aDecidir: number
    aguardando: number
    respondidas: number
  }>()
  const { pathname } = useLocation()

  /**
   * Consulta uma rota minúscula em vez de revalidar a página.
   *
   * Revalidar recarregaria o catálogo inteiro do caixa a cada vinte segundos —
   * na tela que não pode piscar com cliente na frente. A rota devolve dois
   * números.
   */
  useEffect(() => {
    const perguntar = () => {
      if (fetcher.state === "idle") fetcher.load("/autorizacoes/contagem")
    }
    perguntar()
    const relogio = setInterval(perguntar, INTERVALO)
    return () => clearInterval(relogio)
    // `fetcher` muda de identidade a cada render; incluí-lo remontaria o
    // intervalo sem parar. O que importa é montar uma vez por tela.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  const aDecidir = fetcher.data?.aDecidir ?? 0
  const aguardando = fetcher.data?.aguardando ?? 0
  const respondidas = fetcher.data?.respondidas ?? 0

  // O gerente também vende: se ele tem pedido próprio respondido, os dois avisos
  // aparecem, e cada um leva para a sua tela.
  return (
    <>
      {ehGerente(papel) && aDecidir > 0 ? (
        <Button
          render={<Link to="/admin/autorizacoes" />}
          nativeButton={false}
          tabIndex={-1}
          size="sm"
          className={cn(
            "rounded-lg font-semibold",
            // Vermelho: é venda parada com cliente na frente, não um informativo.
            "bg-destructive text-white hover:bg-destructive/90"
          )}
          title="Vendas travadas esperando sua liberação"
        >
          <ShieldAlert className="size-4" aria-hidden />
          {aDecidir} {aDecidir === 1 ? "a liberar" : "a liberar"}
        </Button>
      ) : null}

      {respondidas > 0 ? (
        <Button
          render={<Link to="/autorizacoes" />}
          nativeButton={false}
          tabIndex={-1}
          size="sm"
          variant="secondary"
          className="rounded-lg font-semibold"
          title="Vendas suas que o gerente já respondeu — é aqui que você retoma"
        >
          <ShieldCheck className="size-4" aria-hidden />
          {respondidas} {respondidas === 1 ? "respondida" : "respondidas"}
        </Button>
      ) : null}

      {/* Discreto de propósito: é lembrete, não chamado para agir — o vendedor
          não pode fazer nada além de esperar. Mas precisa existir, senão a venda
          que ele guardou fica sem caminho de volta até alguém responder. */}
      {aguardando > 0 ? (
        <Button
          render={<Link to="/autorizacoes" />}
          nativeButton={false}
          tabIndex={-1}
          size="sm"
          variant="ghost"
          className="rounded-lg"
          title="Vendas suas guardadas, esperando o gerente"
        >
          <Clock className="size-4" aria-hidden />
          {aguardando} esperando
        </Button>
      ) : null}
    </>
  )
}
