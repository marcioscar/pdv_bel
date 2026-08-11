import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Marcador do build, para /saude dizer qual versão está no ar.
  define: { __BUILD__: JSON.stringify(new Date().toISOString()) },
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
});
