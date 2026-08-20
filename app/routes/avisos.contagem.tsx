import type { Route } from "./+types/avisos.contagem"
import { contagemDeAutorizacoes } from "~/lib/autorizacao.server"
import { cargasAConferir, faltasEmAberto } from "~/lib/transferencias.server"
import { ehGerente } from "~/lib/permissoes"
import { exigirUsuario } from "~/lib/sessao.server"

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

  const [autorizacoes, cargas, faltas] = await Promise.all([
    contagemDeAutorizacoes(eu),
    // Só a loja em que ele está operando: carga que chega em NRT não é problema
    // de quem está no balcão de QI, mesmo que ele tenha acesso às duas.
    cargasAConferir(eu.loja),
    // A falta, ao contrário, é da rede: quem decide olha o conjunto, e uma
    // remessa entre duas lojas onde ele não está continua sendo dele para
    // resolver.
    gerente ? faltasEmAberto(eu.lojasPermitidas) : Promise.resolve(0),
  ])

  return {
    // O operador não decide nada: mandar o número da fila para ele seria
    // mostrar um alerta sobre o qual não pode agir.
    aDecidir: gerente ? autorizacoes.aDecidir : 0,
    aguardando: autorizacoes.aguardando,
    respondidas: autorizacoes.respondidas,
    cargas,
    faltas,
  }
}
