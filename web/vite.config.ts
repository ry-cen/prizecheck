import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: "web",
  plugins: [tailwindcss()],
  // The verification gate gives each concurrent dev server its own dependency cache.
  cacheDir: process.env.VITE_CACHE_DIR || undefined,
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      "/auth": `http://127.0.0.1:${process.env.AUTH_PORT || 3001}`,
      "/api": `http://127.0.0.1:${process.env.AUTH_PORT || 3001}`,
    },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
