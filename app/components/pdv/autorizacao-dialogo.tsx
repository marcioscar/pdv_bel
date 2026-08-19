import { useEffect, useRef, useState } from "react"
import { Loader2, ShieldAlert, Send, KeyRound } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Kbd } from "~/components/ui/kbd"
import { avisoDoMotivo, DESCONTO_MAXIMO_PERCENTUAL } from "~/lib/autorizacao"
import { moeda } from "~/lib/moeda"

export type Bloqueio = {
  motivos: string[]
  divida: { valor: number; parcelas: number; diasAtraso: number }
  descontoPercentual: number
}

type Props = {
  bloqueio: Bloqueio
  cliente: { nome: string } | null
  total: number
  enviando: boolean
  erro: string | null
  /** Manda o pedido para a fila e libera o caixa para o próximo cliente. */
  onPedir: () => void
  /** O gerente presente digita a senha e a venda fecha na hora. */
  onLiberarNoCaixa: (email: string, senha: string) => void
  onFechar: () => void
}

/**
 * A venda travada, e as duas saídas.
 *
 * O tom aqui é deliberado: isto não é um erro do vendedor, é uma regra da casa
 * batendo. A tela diz o que travou, mostra o tamanho da dívida — que é o que o
 * cliente vai perguntar — e oferece os dois caminhos lado a lado, sem esconder
 * nenhum atrás de um menu. Com cliente na frente, um caminho escondido é um
 * caminho que não existe.
 */
export function AutorizacaoDialogo({
  bloqueio,
  cliente,
  total,
  enviando,
  erro,
  onPedir,
  onLiberarNoCaixa,
  onFechar,
}: Props) {
  const [comSenha, setComSenha] = useState(false)
  const [email, setEmail] = useState("")
  const [senha, setSenha] = useState("")
  const primeiro = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (comSenha) primeiro.current?.focus()
  }, [comSenha])

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape" && !enviando) {
        evento.preventDefault()
        onFechar()
      }
    }
    window.addEventListener("keydown", aoTeclar)
    return () => window.removeEventListener("keydown", aoTeclar)
  }, [enviando, onFechar])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-autorizacao"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="size-5 text-destructive" aria-hidden />
          <h2 id="titulo-autorizacao" className="text-base font-semibold">
            Esta venda precisa do gerente
          </h2>
        </div>

        <ul className="mt-3 space-y-1.5">
          {bloqueio.motivos.map((motivo) => (
            <li
              key={motivo}
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {avisoDoMotivo(motivo)}
            </li>
          ))}
        </ul>

        {/* O número que o cliente vai contestar no balcão. Sem ele, o vendedor
            diz "o sistema não deixa", que é a pior frase possível de se ouvir. */}
        {bloqueio.divida.parcelas > 0 ? (
          <p className="mt-3 rounded-lg border border-border px-3 py-2 text-sm">
            {cliente ? <strong>{cliente.nome}</strong> : "O cliente"} deve{" "}
            <strong className="font-mono">{moeda(bloqueio.divida.valor)}</strong> em{" "}
            {bloqueio.divida.parcelas}{" "}
            {bloqueio.divida.parcelas === 1 ? "parcela vencida" : "parcelas vencidas"}
            {bloqueio.divida.diasAtraso > 0
              ? ` — a mais velha há ${bloqueio.divida.diasAtraso} ${bloqueio.divida.diasAtraso === 1 ? "dia" : "dias"}`
              : ""}
            .
          </p>
        ) : null}

        {bloqueio.motivos.includes("desconto") ? (
          <p className="mt-2 text-xs text-muted-foreground">
            O desconto pedido é de{" "}
            <Badge variant="outline" className="font-mono text-[10px]">
              {bloqueio.descontoPercentual.toFixed(1)}%
            </Badge>{" "}
            e o teto do vendedor é {DESCONTO_MAXIMO_PERCENTUAL}%. Total da venda:{" "}
            <span className="font-mono">{moeda(total)}</span>.
          </p>
        ) : null}

        {erro ? (
          <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {erro}
          </p>
        ) : null}

        {comSenha ? (
          <form
            className="mt-4 space-y-2"
            onSubmit={(evento) => {
              evento.preventDefault()
              onLiberarNoCaixa(email, senha)
            }}
          >
            <p className="text-xs text-muted-foreground">
              O gerente digita aqui. A venda continua no nome de quem está logado — a
              senha libera, não troca o operador.
            </p>
            <Input
              ref={primeiro}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="E-mail do gerente"
              autoComplete="off"
              className="h-10 rounded-lg"
            />
            <Input
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              placeholder="Senha"
              autoComplete="off"
              className="h-10 rounded-lg"
            />
            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                className="rounded-lg"
                disabled={enviando}
                onClick={() => setComSenha(false)}
              >
                Voltar
              </Button>
              <Button type="submit" className="flex-1 rounded-lg" disabled={enviando}>
                {enviando ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <KeyRound className="size-4" aria-hidden />
                )}
                Liberar e fechar a venda
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4 space-y-2">
            <Button
              type="button"
              className="w-full rounded-lg"
              disabled={enviando}
              onClick={onPedir}
            >
              {enviando ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              Pedir ao gerente e atender o próximo
            </Button>
            <p className="px-1 text-xs text-muted-foreground">
              O carrinho fica guardado. Quando o gerente responder, o aviso aparece no
              topo e você retoma esta venda de onde parou.
            </p>

            <Button
              type="button"
              variant="outline"
              className="w-full rounded-lg"
              disabled={enviando}
              onClick={() => setComSenha(true)}
            >
              <KeyRound className="size-4" aria-hidden />
              O gerente está aqui — liberar com a senha
            </Button>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
            <Kbd>Esc</Kbd> volta para a venda
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-lg"
            disabled={enviando}
            onClick={onFechar}
          >
            Voltar
          </Button>
        </div>
      </div>
    </div>
  )
}
