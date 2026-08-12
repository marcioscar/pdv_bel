import { redirect } from "react-router"

/**
 * Usuários passou para a administração. O link antigo continua funcionando:
 * quem tinha a tela salva no navegador não bate em 404.
 */
export function loader() {
  return redirect("/admin/usuarios", { status: 301 })
}
