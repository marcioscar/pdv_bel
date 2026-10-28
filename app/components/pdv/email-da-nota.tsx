import { useState } from "react"
import { useFetcher } from "react-router"
import { Mail } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { cn } from "~/lib/utils"

/** O que o botão precisa saber da nota — as duas telas mandam mais que isso. */
export type NotaParaEmail = {
  id: string
  emailDoCliente: string | null
  emailEnviadoEm: string | null
  emailEnviadoPara: string | null
  emailEnviadoPor: string | null
  emailErro: string | null
}

/** O que a ação devolve; outras ações da mesma rota chegam sem `para`/`erro`. */
type RespostaDoEmail = { ok: boolean; tipo?: string; para?: string; erro?: string }

/**
 * Manda o DANFE e o XML ao cliente pela caixa da empresa. O endereço vem do
 * cadastro e pode ser trocado na hora — o cliente às vezes pede para mandar
 * para o contador. Diz quando e para quem foi o último envio.
 *
 * Posta `acao=emailNota` na rota em que está: a tela do turno e a de notas
 * emitidas respondem a mesma ação, cada uma com a sua guarda.
 */
export function EmailDaNota({
  nota,
  alinhar = "esquerda",
}: {
  nota: NotaParaEmail
  /** De que lado o balão se abre — "direita" para a última coluna de uma tabela. */
  alinhar?: "esquerda" | "direita"
}) {
  const fetcher = useFetcher<RespostaDoEmail>()
  const [aberto, setAberto] = useState(false)
  const [para, setPara] = useState(nota.emailEnviadoPara ?? nota.emailDoCliente ?? "")
  const enviando = fetcher.state !== "idle"
  const resposta =
    fetcher.data && "tipo" in fetcher.data && fetcher.data.tipo === "emailNota" ? fetcher.data : null

  const ultimo = nota.emailEnviadoEm
    ? `enviada para ${nota.emailEnviadoPara} em ${new Date(nota.emailEnviadoEm).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })}${nota.emailEnviadoPor === "automático" ? " (automático)" : ""}`
    : null

  return (
    <div className="relative">
      <Button
        type="button"
        tabIndex={-1}
        variant="outline"
        size="sm"
        className="rounded-lg"
        onClick={() => setAberto((a) => !a)}
        title={ultimo ?? (nota.emailErro ? `Último envio falhou: ${nota.emailErro}` : undefined)}
      >
        <Mail className="size-4" />
        {nota.emailEnviadoEm ? "Reenviar por e-mail" : "Enviar por e-mail"}
      </Button>
      {aberto ? (
        <div
          className={cn(
            "absolute bottom-full z-20 mb-2 w-80 rounded-xl border border-border bg-card p-3 text-left shadow-lg",
            alinhar === "direita" ? "right-0" : "left-0"
          )}
        >
          <fetcher.Form method="post" className="grid gap-2">
            <input type="hidden" name="acao" value="emailNota" />
            <input type="hidden" name="notaId" value={nota.id} />
            <label className="grid gap-1 text-xs text-muted-foreground">
              Para
              <Input
                name="para"
                type="email"
                value={para}
                onChange={(e) => setPara(e.target.value)}
                placeholder="email@cliente.com.br"
                autoFocus
                required
              />
            </label>
            <p className="text-[11px] text-muted-foreground">
              Vai o DANFE e o XML da nota, de brassaco@brassaco.com.br.
            </p>
            {ultimo ? <p className="text-[11px] text-muted-foreground">Último: {ultimo}</p> : null}
            {resposta?.ok ? (
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Enviada para {resposta.para}
              </p>
            ) : resposta && !resposta.ok ? (
              <p className="text-xs text-destructive">{resposta.erro}</p>
            ) : nota.emailErro && !nota.emailEnviadoEm ? (
              <p className="text-xs text-destructive">Último envio falhou: {nota.emailErro}</p>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={enviando || !para.trim()}>
                {enviando ? "Enviando…" : "Enviar"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAberto(false)}>
                Fechar
              </Button>
            </div>
          </fetcher.Form>
        </div>
      ) : null}
    </div>
  )
}
