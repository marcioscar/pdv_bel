import { useState } from "react"
import { Barcode, Check, Copy, FileText, Loader2 } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Kbd } from "~/components/ui/kbd"
import { Separator } from "~/components/ui/separator"
import { moeda } from "~/lib/moeda"
import { cn } from "~/lib/utils"

export type CobrancaExibida = {
  codigoSolicitacao: string
  situacao: string
  parcela: number
  parcelas: number
  valor: number
  vencimento: string
  linhaDigitavel: string | null
  codigoBarras: string | null
  nossoNumero: string | null
  txid: string | null
  pixCopiaECola: string | null
  pixQrCode: string | null
}

type Props = {
  vendaNumero: number
  vendaId: string
  cobrancas: CobrancaExibida[]
  erro: string | null
  emitindo: boolean
  onFechar: () => void
}

/** Agrupa a linha digitável de 47 dígitos como no boleto impresso. */
function agruparLinha(linha: string) {
  const d = linha.replace(/\D/g, "")
  if (d.length !== 47) return linha
  return `${d.slice(0, 5)}.${d.slice(5, 10)} ${d.slice(10, 15)}.${d.slice(15, 21)} ${d.slice(21, 26)}.${d.slice(26, 32)} ${d.slice(32, 33)} ${d.slice(33)}`
}

function BotaoCopiar({
  texto,
  rotulo,
  copiado: rotuloCopiado = "Copiado",
}: {
  texto: string
  rotulo: string
  copiado?: string
}) {
  const [copiado, setCopiado] = useState(false)

  return (
    <Button
      type="button"
      tabIndex={-1}
      variant="outline"
      size="sm"
      className="rounded-lg"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texto)
          setCopiado(true)
          setTimeout(() => setCopiado(false), 2000)
        } catch {
          setCopiado(false)
        }
      }}
    >
      {copiado ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copiado ? rotuloCopiado : rotulo}
    </Button>
  )
}

function BotaoPdf({
  vendaId,
  parcela,
  rotulo,
}: {
  vendaId: string
  parcela: number
  rotulo: string
}) {
  return (
    <Button
      type="button"
      tabIndex={-1}
      variant="outline"
      size="sm"
      className="rounded-lg"
      nativeButton={false}
      render={
        <a
          href={`/vendas/${vendaId}/boleto.pdf?parcela=${parcela}`}
          target="_blank"
          rel="noreferrer"
        />
      }
    >
      <FileText className="size-4" />
      {rotulo}
    </Button>
  )
}

function EtiquetaSituacao({ situacao }: { situacao: string }) {
  return (
    <Badge
      variant={
        situacao === "RECEBIDO"
          ? "default"
          : situacao === "CANCELADO" || situacao === "EXPIRADO"
            ? "destructive"
            : "secondary"
      }
      className="font-mono text-[10px]"
    >
      {situacao}
    </Badge>
  )
}

/** Uma parcela do parcelamento: valor, data, linha digitável e os botões. */
function LinhaParcela({
  cobranca,
  vendaId,
}: {
  cobranca: CobrancaExibida
  vendaId: string
}) {
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm font-semibold tabular-nums">
          {cobranca.parcela}ª de {cobranca.parcelas}
        </span>
        <span className="font-mono text-base font-bold tabular-nums">
          {moeda(cobranca.valor)}
        </span>
        <span className="text-xs text-muted-foreground">
          vence {new Date(cobranca.vencimento).toLocaleDateString("pt-BR")}
        </span>
        <span className="ml-auto">
          <EtiquetaSituacao situacao={cobranca.situacao} />
        </span>
      </div>

      {cobranca.linhaDigitavel ? (
        <>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-1.5">
            <span className="whitespace-nowrap font-mono text-xs tabular-nums">
              {agruparLinha(cobranca.linhaDigitavel)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <BotaoCopiar texto={cobranca.linhaDigitavel} rotulo="Copiar linha" />
            <BotaoPdf vendaId={vendaId} parcela={cobranca.parcela} rotulo="PDF" />
            {cobranca.pixCopiaECola ? (
              <BotaoCopiar texto={cobranca.pixCopiaECola} rotulo="Copiar Pix" />
            ) : null}
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Ainda em processamento no Inter — a linha digitável aparece na tela de
          Vendas quando ficar pronta.
        </p>
      )}
    </li>
  )
}

export function CobrancaDialogo({
  vendaNumero,
  vendaId,
  cobrancas,
  erro,
  emitindo,
  onFechar,
}: Props) {
  const parcelada = cobrancas.length > 1
  const unica = cobrancas.length === 1 ? cobrancas[0] : null
  const totalCobrado = cobrancas.reduce((acc, c) => acc + c.valor, 0)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Cobrança da venda ${vendaNumero}`}
      className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-background/80 p-8 backdrop-blur-sm"
    >
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="flex items-baseline gap-2 text-base font-semibold">
            Venda #{vendaNumero} ·{" "}
            {parcelada ? `${cobrancas.length} boletos` : "cobrança"}
            {unica ? <EtiquetaSituacao situacao={unica.situacao} /> : null}
          </h2>
          <span className="text-xs text-muted-foreground">
            <Kbd>Esc</Kbd> ou <Kbd>Enter</Kbd> fecha
          </span>
        </div>

        <Separator className="my-4" />

        {emitindo ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              Emitindo no Banco Inter…
            </p>
            <p className="text-xs text-muted-foreground">
              A emissão é assíncrona e leva alguns segundos por boleto.
            </p>
          </div>
        ) : erro ? (
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-destructive">{erro}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              A venda #{vendaNumero} está gravada. A cobrança pode ser emitida
              de novo pela tela de Vendas.
            </p>
          </div>
        ) : parcelada ? (
          <>
            <div className="mb-3 font-mono text-sm text-muted-foreground tabular-nums">
              {moeda(totalCobrado)} em {cobrancas.length} parcelas
            </div>
            <ul className="space-y-2">
              {cobrancas.map((cobranca) => (
                <LinhaParcela
                  key={cobranca.codigoSolicitacao}
                  cobranca={cobranca}
                  vendaId={vendaId}
                />
              ))}
            </ul>
          </>
        ) : unica ? (
          <div className="grid grid-cols-5 gap-6">
            <div className="col-span-3 space-y-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Valor · vencimento
                </div>
                <div className="mt-0.5 font-mono text-2xl font-bold tabular-nums">
                  {moeda(unica.valor)}
                  <span className="ml-2 text-sm font-medium text-muted-foreground">
                    vence {new Date(unica.vencimento).toLocaleDateString("pt-BR")}
                  </span>
                </div>
              </div>

              {unica.linhaDigitavel ? (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Barcode className="size-3.5" aria-hidden />
                    Linha digitável
                  </div>
                  {/* Uma linha só: o operador lê em voz alta ou digita. */}
                  <div className="overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <span className="whitespace-nowrap font-mono text-xs tabular-nums">
                      {agruparLinha(unica.linhaDigitavel)}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <BotaoCopiar texto={unica.linhaDigitavel} rotulo="Copiar linha" />
                    <BotaoPdf
                      vendaId={vendaId}
                      parcela={unica.parcela}
                      rotulo="Abrir boleto (PDF)"
                    />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  O boleto ainda está sendo processado no Inter. A linha digitável
                  aparece na tela de Vendas assim que ficar pronta.
                </p>
              )}

              {unica.nossoNumero ? (
                <div className="font-mono text-[11px] text-muted-foreground">
                  nosso número {unica.nossoNumero}
                </div>
              ) : null}
            </div>

            <div className="col-span-2">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Pix do boleto
              </div>
              {unica.pixQrCode ? (
                <>
                  <img
                    src={unica.pixQrCode}
                    alt="QR Code Pix da cobrança"
                    className={cn(
                      // Fundo branco sempre: QR escuro sobre fundo escuro não lê.
                      "w-full rounded-lg border border-border bg-white p-2"
                    )}
                  />
                  {unica.pixCopiaECola ? (
                    <div className="mt-2">
                      <BotaoCopiar
                        texto={unica.pixCopiaECola}
                        rotulo="Copiar Pix copia e cola"
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Sem QR Pix nesta cobrança.
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nenhuma cobrança emitida para esta venda.
          </p>
        )}

        <Separator className="my-4" />

        <div className="flex justify-end">
          <Button type="button" tabIndex={-1} onClick={onFechar} className="rounded-lg">
            Concluir
            <Kbd className="bg-primary-foreground/20 text-primary-foreground">Enter</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
