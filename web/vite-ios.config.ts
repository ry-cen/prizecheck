import { defineConfig } from "vite";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "mobile",
  base: "./",
  plugins: [tailwindcss()],
  build: {
    outDir: "../dist/ios",
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "../mobile/index.html") },
  },
});
