import type { Route } from "./+types/cliente.documento"
import { db } from "~/lib/db.server"
import { limparDocumento, validarCpfCnpj } from "~/lib/documento"
import { exigirUsuario } from "~/lib/sessao.server"

/**
 * Quem já tem este CPF/CNPJ no cadastro — ou ninguém.
 *
 * Rota de dados para o formulário de cliente perguntar ENQUANTO se digita. A
 * gravação já recusa o duplicado, mas só depois de o caixa preencher endereço,
 * telefone e o resto: o aviso chegava quando o trabalho já tinha sido feito à
 * toa. Vale para os inativos também, que o F6 não lista e por isso parecem não
 * existir.
 *
 * Só nome, id e se está ativo: é o bastante para avisar e para vincular, e não
 * transforma a rota numa consulta de cadastro por documento.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  await exigirUsuario(request)

  const documento = limparDocumento(params.documento ?? "")
  if (!validarCpfCnpj(documento)) {
    return Response.json({ erro: "Documento inválido" }, { status: 400 })
  }

  const cliente = await db.cliente.findUnique({
    where: { cpfCnpj: documento },
    select: { id: true, nome: true, ativo: true },
  })

  return { documento, cliente }
}
