import { defineConfig } from "vite";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { scannerEntryPlugin } from "./vite-scanner-plugin";
export default defineConfig({
  root: "web",
  plugins: [tailwindcss(), scannerEntryPlugin()],
  // The scanner recognizer runs in a module worker.
  worker: { format: "es" },
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
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    // Two HTML entries: the app, and the scanner (served at /collection/scan, cross-origin isolated).
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        scan: resolve(__dirname, "scan.html"),
      },
    },
  },
});
