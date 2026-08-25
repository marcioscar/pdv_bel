import { useEffect, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react"

import type { Route } from "./+types/admin.certificados"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  lerCertEKey,
  lerPfx,
  listarCertificados,
  salvarCertificado,
  type CertificadoLido,
  type SlotCertificado,
  type TipoCertificado,
} from "~/lib/certificados.server"
import { exigirGerente } from "~/lib/sessao.server"
import { cn } from "~/lib/utils"

export function meta(_: Route.MetaArgs) {
  return [{ title: "Certificados — BrasSaco" }]
}

/**
 * Todo certificado que o sistema usa para autenticar em outro lugar — Inter
 * (boleto, Pix) e SEFAZ (busca de NF-e) — num lugar só, com validade e um
 * jeito de renovar sem precisar de terminal.
 *
 * Certificado nunca fica em banco (o mesmo motivo do comentário em
 * `ContaInter`): isto grava em arquivo local, exatamente onde
 * `inter.server.ts`/`sefaz.server.ts` já esperam encontrar.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await exigirGerente(request, "gerenciarCertificados")
  const slots = await listarCertificados()
  return { slots }
}

export type RespostaCertificado =
  | { ok: true; blocoEasypanel: string; tipo: TipoCertificado; chave: string }
  | { ok: false; erro: string }

export async function action({ request }: Route.ActionArgs): Promise<RespostaCertificado> {
  await exigirGerente(request, "gerenciarCertificados")
  const form = await request.formData()
  const tipo = String(form.get("tipo") ?? "")
  const chave = String(form.get("chave") ?? "")

  if (!chave || (tipo !== "inter" && tipo !== "sefaz")) {
    return { ok: false, erro: "Dados inválidos" }
  }

  let lido: CertificadoLido
  if (tipo === "sefaz") {
    const arquivo = form.get("arquivoPfx")
    const senha = String(form.get("senha") ?? "")
    if (!(arquivo instanceof File) || arquivo.size === 0) {
      return { ok: false, erro: "Escolha o arquivo .pfx" }
    }
    lido = lerPfx(Buffer.from(await arquivo.arrayBuffer()), senha)
  } else {
    const arquivoCert = form.get("arquivoCert")
    const arquivoKey = form.get("arquivoKey")
    if (!(arquivoCert instanceof File) || arquivoCert.size === 0 || !(arquivoKey instanceof File) || arquivoKey.size === 0) {
      return { ok: false, erro: "Escolha os dois arquivos: certificado e chave" }
    }
    lido = lerCertEKey(Buffer.from(await arquivoCert.arrayBuffer()), Buffer.from(await arquivoKey.arrayBuffer()))
  }

  if (!lido.ok) return lido

  const salvo = await salvarCertificado(tipo, chave, lido)
  if (!salvo.ok) return salvo
  return { ok: true, blocoEasypanel: salvo.blocoEasypanel, tipo, chave }
}

function situacaoDoSlot(slot: SlotCertificado) {
  if (!slot.configurado || !slot.certificado) return "ausente" as const
  if (slot.certificado.diasParaVencer < 0) return "vencido" as const
  if (slot.certificado.renovar) return "vencendo" as const
  return "ok" as const
}

const CORES_SITUACAO = {
  ok: "text-muted-foreground",
  vencendo: "text-amber-600 dark:text-amber-500",
  vencido: "text-destructive",
  ausente: "text-muted-foreground",
} as const

export default function AdminCertificados({ loaderData }: Route.ComponentProps) {
  const { slots } = loaderData
  const [abrirRenovacao, setAbrirRenovacao] = useState<string | null>(null)

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Certificados</h1>
        <span className="text-xs text-muted-foreground">
          Inter e SEFAZ, por loja — validade e renovação
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {slots.map((slot) => {
          const id = `${slot.tipo}-${slot.chave}`
          const situacao = situacaoDoSlot(slot)
          return (
            <div key={id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-40 shrink-0 text-sm font-medium">{slot.rotulo}</span>
                <span className="text-xs text-muted-foreground">
                  {slot.lojas.length > 1 ? `lojas ${slot.lojas.join(", ")}` : null}
                </span>

                <div className="flex-1" />

                {situacao === "ausente" ? (
                  <Badge variant="secondary">não configurado</Badge>
                ) : (
                  <>
                    <span className={cn("text-xs", CORES_SITUACAO[situacao])}>
                      {slot.certificado?.titular ?? "—"}
                    </span>
                    <Badge
                      variant={situacao === "vencido" ? "destructive" : situacao === "vencendo" ? "secondary" : "outline"}
                    >
                      {situacao === "vencido"
                        ? "vencido"
                        : situacao === "vencendo"
                          ? `vence em ${slot.certificado?.diasParaVencer}d`
                          : `vence em ${slot.certificado?.venceEm}`}
                    </Badge>
                    {slot.certificado?.chaveCombina === false ? (
                      <span title="A chave privada não bate com este certificado">
                        <ShieldAlert className="size-4 text-destructive" aria-hidden />
                      </span>
                    ) : null}
                  </>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAbrirRenovacao((atual) => (atual === id ? null : id))}
                >
                  {situacao === "ausente" ? "Configurar" : "Renovar"}
                </Button>
              </div>

              {abrirRenovacao === id ? (
                <FormularioRenovacao
                  slot={slot}
                  onFechar={() => setAbrirRenovacao(null)}
                />
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="mt-6 max-w-2xl space-y-2 text-xs text-muted-foreground">
        <p>
          <strong className="text-foreground">SEFAZ (e-CNPJ A1):</strong> renove com a
          Autoridade Certificadora que emitiu (ou peça ao contador) — é um certificado da
          Receita Federal, sem relação com o Inter. Chega como um único arquivo{" "}
          <code className="rounded bg-muted px-1">.pfx</code> protegido por senha.
        </p>
        <p>
          <strong className="text-foreground">Inter:</strong> gerado na Central de APIs do
          portal do Inter, na integração desta conta. Baixa como dois arquivos separados,
          certificado e chave, sem senha.
        </p>
      </div>
    </div>
  )
}

function FormularioRenovacao({ slot, onFechar }: { slot: SlotCertificado; onFechar: () => void }) {
  const fetcher = useFetcher<RespostaCertificado>()
  const enviando = fetcher.state !== "idle"
  const resultado = fetcher.data
  const formRef = useRef<HTMLFormElement>(null)
  const [copiado, setCopiado] = useState(false)

  // Sucesso limpa o formulário — o arquivo escolhido não faz mais sentido
  // continuar ali depois de já ter sido gravado.
  useEffect(() => {
    if (resultado?.ok) formRef.current?.reset()
  }, [resultado])

  function copiar() {
    if (!resultado?.ok) return
    navigator.clipboard.writeText(resultado.blocoEasypanel).then(() => {
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    })
  }

  return (
    <div className="mt-3 border-t pt-3">
      <fetcher.Form ref={formRef} method="post" encType="multipart/form-data" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="tipo" value={slot.tipo} />
        <input type="hidden" name="chave" value={slot.chave} />

        {slot.tipo === "sefaz" ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Arquivo .pfx</span>
              <input type="file" name="arquivoPfx" accept=".pfx,.p12" required className="text-xs" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Senha do certificado</span>
              <Input type="password" name="senha" required className="w-48" />
            </label>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Certificado (.crt)</span>
              <input type="file" name="arquivoCert" accept=".crt,.pem" required className="text-xs" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Chave (.key)</span>
              <input type="file" name="arquivoKey" accept=".key,.pem" required className="text-xs" />
            </label>
          </>
        )}

        <Button type="submit" disabled={enviando}>
          {enviando ? "Enviando…" : "Salvar"}
        </Button>
        <Button type="button" variant="ghost" onClick={onFechar}>
          Cancelar
        </Button>
      </fetcher.Form>

      {resultado && !resultado.ok ? (
        <p className="mt-2 text-xs text-destructive">{resultado.erro}</p>
      ) : null}

      {resultado?.ok ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Certificado gravado nesta máquina e já em uso. Para valer em produção, cole
            isto nas variáveis de ambiente do easypanel e reinicie o serviço:
          </p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-2 pr-10 text-[11px]">
              {resultado.blocoEasypanel}
            </pre>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="absolute top-1 right-1"
              onClick={copiar}
              title="Copiar"
            >
              {copiado ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
