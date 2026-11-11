import type { Route } from "./+types/avisos.contagem"
import { contagemDeAutorizacoes } from "~/lib/autorizacao.server"
import { certificadoDaConta } from "~/lib/inter.server"
import { darCienteDePix, pixRecebidosSemCiente } from "~/lib/pix-entrega.server"
import { listarLojas } from "~/lib/lojas.server"
import { ehGerente } from "~/lib/permissoes"
import { certificadoSefazDaLoja } from "~/lib/sefaz.server"
import { exigirUsuario } from "~/lib/sessao.server"
import { cargasAConferir, faltasEmAberto } from "~/lib/transferencias.server"

/**
 * Tudo que o indicador do topo precisa saber, num endereço só.
 *
 * Rota separada e minúscula de propósito: fazer o topo revalidar a página
 * inteira a cada meio minuto recarregaria o catálogo do caixa e a lista de
 * vendas junto — e o caixa é justamente a tela que não pode piscar com cliente
 * na frente. Pelo mesmo motivo os assuntos vêm juntos: uma rota por assunto
 * seria uma consulta por assunto, em toda tela, a cada vinte segundos.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const eu = await exigirUsuario(request)

  const gerente = ehGerente(eu.papel)

  const [autorizacoes, cargas, faltas, certificados, pixRecebidos] = await Promise.all([
    contagemDeAutorizacoes(eu),
    // Só a loja em que ele está operando: carga que chega em NRT não é problema
    // de quem está no balcão de QI, mesmo que ele tenha acesso às duas.
    cargasAConferir(eu.loja),
    // A falta, ao contrário, é da rede: quem decide olha o conjunto, e uma
    // remessa entre duas lojas onde ele não está continua sendo dele para
    // resolver.
    gerente ? faltasEmAberto(eu.lojasPermitidas) : Promise.resolve(0),
    // Certificado vencido para de funcionar num dia qualquer, calado — o
    // operador de caixa não pode renovar nada, só o gerente.
    gerente ? certificadosARenovar() : Promise.resolve([]),
    // Pix da entrega que o cliente pagou. Quem está no balcão vê o da própria
    // loja (é ele quem tem o entregador e o cliente na linha); o gerente vê os
    // das lojas que alcança.
    pixRecebidosSemCiente(lojasDoAviso(eu, gerente)),
  ])

  return {
    // O operador não decide nada: mandar o número da fila para ele seria
    // mostrar um alerta sobre o qual não pode agir.
    aDecidir: gerente ? autorizacoes.aDecidir : 0,
    aguardando: autorizacoes.aguardando,
    respondidas: autorizacoes.respondidas,
    cargas,
    faltas,
    certificados,
    pixRecebidos,
  }
}

function lojasDoAviso(eu: { loja: string; lojasPermitidas: string[] }, gerente: boolean) {
  return gerente ? eu.lojasPermitidas : [eu.loja]
}

/** "Ciente" de um ou mais Pix recebidos — tira do aviso do topo. */
export async function action({ request }: Route.ActionArgs) {
  const eu = await exigirUsuario(request)
  const form = await request.formData()
  const ids = form.getAll("id").map(String)
  await darCienteDePix(ids, lojasDoAviso(eu, ehGerente(eu.papel)))
  return { ok: true as const }
}

/**
 * Todo certificado (Inter e SEFAZ) a menos de 30 dias de vencer, por loja.
 *
 * Lê arquivo local e confere data — nenhuma chamada de rede, então rodar isto
 * a cada 20s junto do resto do indicador do topo não custa nada.
 */
async function certificadosARenovar() {
  const lojas = await listarLojas()
  const avisos: { rotulo: string; diasParaVencer: number }[] = []

  const contasVistas = new Set<string>()
  for (const loja of lojas) {
    if (!contasVistas.has(loja.conta)) {
      contasVistas.add(loja.conta)
      const cert = certificadoDaConta(loja.conta)
      if (cert?.renovar) avisos.push({ rotulo: `Inter ${loja.conta}`, diasParaVencer: cert.diasParaVencer })
    }

    const certSefaz = certificadoSefazDaLoja(loja.codigo)
    if (certSefaz?.renovar) avisos.push({ rotulo: `SEFAZ ${loja.codigo}`, diasParaVencer: certSefaz.diasParaVencer })
  }

  return avisos
}
