# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # dev server with HMR at http://localhost:5173
npm run build      # production build -> build/client + build/server
npm run start      # serve the production build (react-router-serve)
npm run typecheck  # react-router typegen && tsc  -- the only check available
```

There is no test runner, linter, or formatter configured. `npm run typecheck` is the sole verification step; run it after changes, and run it (or `npm run dev`) after adding or renaming routes so `.react-router/types` is regenerated.

Docker: `docker build -t pdv . && docker run -p 3000:3000 pdv` (multi-stage; the final image runs `npm run start`).

## Architecture

React Router v8 in **Framework Mode** with SSR enabled (`react-router.config.ts` → `ssr: true`). This is currently the unmodified React Router starter template; the app itself (a PDV / point-of-sale) has not been built yet, so most of what exists is scaffolding.

- Routes are declared explicitly in [app/routes.ts](app/routes.ts) using the config helpers (`index`, `route`, `layout`, `prefix`) — **not** by file-system convention. A new file under `app/routes/` does nothing until it is registered there.
- Each route module gets generated types at `./+types/<route-name>`. Import `Route` from there and type exports as `Route.LoaderArgs`, `Route.MetaArgs`, `Route.ComponentProps`, etc. These types live in the gitignored `.react-router/` dir and only exist after typegen has run.
- [app/root.tsx](app/root.tsx) owns the `<html>` shell via the `Layout` export, plus the app-wide `links` and `ErrorBoundary`.
- Import alias: `~/*` → `app/*` (tsconfig paths + `tsconfigPaths` in [vite.config.ts](vite.config.ts)).

### UI layer

shadcn is configured in [components.json](components.json) with the **`base-luma` style over Base UI** (`@base-ui/react`), not Radix. Generated components import primitives from `@base-ui/react/*` and spread `Primitive.Props` — see [app/components/ui/button.tsx](app/components/ui/button.tsx) for the house pattern (`cva` variants + `cn()` + `data-slot` attribute). Match that shape when hand-writing components; use `npx shadcn@latest add <component>` to pull new ones so the style stays consistent.

Tailwind v4 is configured entirely in CSS — there is no `tailwind.config.*`. [app/app.css](app/app.css) imports `shadcn/tailwind.css` and defines the theme tokens in `@theme` / `@theme inline` blocks; dark mode uses the `.dark` class variant (`@custom-variant dark`). Icons come from `lucide-react`.

Note: `app/app.css` sets `--font-sans` to Roboto Variable (via `@fontsource-variable/roboto`) while `app/root.tsx` still preconnects and loads Inter from Google Fonts — leftover from the template.

## React Router skill

[.agents/skills/react-router/](.agents/skills/react-router/) contains a mode-aware React Router reference. For non-trivial routing, loader/action, form, or rendering-mode work, read `.agents/skills/react-router/references/framework-mode.md` (this app is Framework Mode), and treat the version-matched docs shipped in `node_modules/react-router/docs/` as the source of truth over recalled API details.

Sempre responda em portugues
