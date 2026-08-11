import { useEffect, useState } from "react"
import { Check, Copy, Loader2, QrCode, RefreshCw } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { moeda } from "~/lib/moeda"
import { cn } from "~/lib/utils"

export type PixNoBalcao = {
  txid: string
  valor: number
  pixCopiaECola: string | null
  pixQrCode: string | null
  expiracaoSegundos: number
}

type Props = {
  cobranca: PixNoBalcao | null
  criando: boolean
  erro: string | null
  /** Preenchido quando o pagamento é confirmado e a venda é gravada. */
  concluida: { numero: number; pagoEm: string | null } | null
  motivoPendente: string | null
  /** Força uma consulta agora. Não confirma nada: o servidor continua decidindo. */
  onConferir: () => void
  conferindo: boolean
  onCancelar: () => void
  onConcluir: () => void
}

export function PixDialogo({
  cobranca,
  criando,
  erro,
  concluida,
  motivoPendente,
  onConferir,
  conferindo,
  onCancelar,
  onConcluir,
}: Props) {
  const [copiado, setCopiado] = useState(false)
  const [restante, setRestante] = useState<number | null>(null)

  // Conta o tempo de vida da cobrança: passado disso, o cliente precisa de outra.
  useEffect(() => {
    if (!cobranca || concluida) return setRestante(null)

    setRestante(cobranca.expiracaoSegundos)
    const id = setInterval(() => {
      setRestante((atual) => (atual === null || atual <= 0 ? 0 : atual - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [cobranca, concluida])

  const minutos = restante === null ? null : Math.floor(restante / 60)
  const segundos = restante === null ? null : restante % 60

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pagamento por Pix"
      className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-background/80 p-8 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <QrCode className="size-4" aria-hidden />
            Pagamento por Pix
          </h2>
          <span className="text-xs text-muted-foreground">
            {concluida ? (
              <>
                <Kbd>Enter</Kbd> conclui
              </>
            ) : (
              <>
                <Kbd>Esc</Kbd> cancela
              </>
            )}
          </span>
        </div>

        <Separator className="my-4" />

        {criando ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Gerando a cobrança no Inter…</p>
          </div>
        ) : erro ? (
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-destructive">{erro}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Nenhuma venda foi gravada. Tente de novo ou escolha outra forma de
              pagamento.
            </p>
          </div>
        ) : concluida ? (
          <div className="py-10 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10">
              <Check className="size-7 text-primary" aria-hidden />
            </div>
            <p className="mt-4 text-base font-semibold">Pagamento confirmado</p>
            <p className="mt-1 font-mono text-sm text-muted-foreground tabular-nums">
              Venda #{concluida.numero}
              {concluida.pagoEm
                ? ` · ${new Date(concluida.pagoEm).toLocaleTimeString("pt-BR")}`
                : ""}
            </p>
            <Button onClick={onConcluir} className="mt-6 rounded-lg">
              Concluir
              <Kbd className="bg-primary-foreground/20 text-primary-foreground">Enter</Kbd>
            </Button>
          </div>
        ) : cobranca ? (
          <>
            <div className="text-center">
              <div className="font-mono text-3xl font-bold tabular-nums">
                {moeda(cobranca.valor)}
              </div>
              {cobranca.pixQrCode ? (
                <img
                  src={cobranca.pixQrCode}
                  alt="QR Code para pagamento por Pix"
                  // Fundo branco sempre: QR escuro em tema escuro não é lido.
                  className="mx-auto mt-3 w-full max-w-[280px] rounded-lg border border-border bg-white p-3"
                />
              ) : null}
            </div>

            {cobranca.pixCopiaECola ? (
              <div className="mt-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Copia e cola
                </div>
                {/* Mostrado como texto, não só no botão: o cliente às vezes pede o
                    código, e não se dita um QR Code. */}
                <div className="max-h-16 overflow-y-auto rounded-lg border border-border bg-muted/40 px-2 py-1.5">
                  <code
                    data-slot="pix-copia-e-cola"
                    className="break-all font-mono text-[10px] leading-relaxed text-muted-foreground"
                  >
                    {cobranca.pixCopiaECola}
                  </code>
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-center gap-2">
              {cobranca.pixCopiaECola ? (
                <Button
                  type="button"
                  tabIndex={-1}
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(cobranca.pixCopiaECola!)
                      setCopiado(true)
                      setTimeout(() => setCopiado(false), 2000)
                    } catch {
                      setCopiado(false)
                    }
                  }}
                >
                  {copiado ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copiado ? "Copiado" : "Copiar copia e cola"}
                </Button>
              ) : null}
              {restante !== null ? (
                <Badge
                  variant={restante > 60 ? "secondary" : "destructive"}
                  className="font-mono tabular-nums"
                >
                  {minutos}:{String(segundos).padStart(2, "0")}
                </Badge>
              ) : null}
            </div>

            <div className="mt-5 flex items-center justify-center gap-2 rounded-lg bg-muted/40 py-3">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              <span className="text-sm text-muted-foreground" role="status">
                {restante === 0
                  ? "Cobrança expirada — cancele e gere outra"
                  : "Aguardando o pagamento do cliente…"}
              </span>
            </div>

            {motivoPendente ? (
              <p className={cn("mt-3 text-center text-xs text-muted-foreground")}>
                {motivoPendente}
              </p>
            ) : null}

            <p className="mt-4 text-center text-[11px] text-muted-foreground">
              A venda só é gravada depois de o pagamento ser confirmado pelo banco.
            </p>
          </>
        ) : null}

        {!concluida && !criando ? (
          <>
            <Separator className="my-4" />
            <div className="flex justify-between">
              {/* Rede de segurança se a consulta automática travar. Não confirma
                  pagamento: só pergunta ao banco agora, e o servidor decide. */}
              <Button
                type="button"
                tabIndex={-1}
                variant="ghost"
                disabled={conferindo || !cobranca}
                onClick={onConferir}
                className="rounded-lg"
              >
                {conferindo ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Conferir agora
              </Button>
              <Button
                type="button"
                tabIndex={-1}
                variant="outline"
                onClick={onCancelar}
                className="rounded-lg"
              >
                <Kbd>Esc</Kbd> Cancelar
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
