import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
  { rel: "icon", href: "/icon.png", type: "image/png" },
  { rel: "apple-touch-icon", href: "/logo.png" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {/* Aplica o tema salvo antes da primeira pintura para não piscar claro. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("pdv-tema")==="dark")document.documentElement.classList.add("dark")}catch(e){}`,
          }}
        />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

const TITULOS: Record<number, string> = {
  403: "Acesso restrito",
  404: "Página não encontrada",
};

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let titulo = "Algo deu errado";
  let detalhe = "Erro inesperado. Tente de novo ou volte ao caixa.";
  let pilha: string | undefined;

  if (isRouteErrorResponse(error)) {
    titulo = TITULOS[error.status] ?? `Erro ${error.status}`;
    // `data` é o CORPO da resposta lançada, que é onde as guardas de permissão
    // põem a explicação. `statusText` costuma vir vazio — ler dele deixava a tela
    // dizendo "erro inesperado" mesmo quando o motivo era conhecido.
    const doCorpo = typeof error.data === "string" ? error.data.trim() : "";
    detalhe = doCorpo || error.statusText || detalhe;
  } else if (import.meta.env.DEV && error instanceof Error) {
    detalhe = error.message;
    pilha = error.stack;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-7 shadow-lg">
        <h1 className="text-base font-semibold">{titulo}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detalhe}</p>
        <a
          href="/"
          className="mt-5 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          Voltar ao caixa
        </a>
        {pilha ? (
          <pre className="mt-5 max-h-72 w-full overflow-auto rounded-lg bg-muted/60 p-3 text-[11px]">
            <code>{pilha}</code>
          </pre>
        ) : null}
      </div>
    </main>
  );
}
