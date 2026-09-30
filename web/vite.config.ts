import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/auth': 'http://127.0.0.1:3001', '/api': 'http://127.0.0.1:3001' },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
