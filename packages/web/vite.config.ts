import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Rotas do daemon — em desenvolvimento o Vite as repassa; em produção o
 *  próprio daemon serve esta build, então tudo já é a mesma origem. */
const API_ROUTES = [
  '/health',
  '/agents',
  '/projects',
  '/sessions',
  '/tasks',
  '/graph',
  '/budget',
  '/events',
  '/context',
];

const target = process.env['AGENTS_HUB_URL'] ?? 'http://127.0.0.1:4747';

export default defineConfig({
  plugins: [react()],
  // Relativo para a UI funcionar servida de qualquer caminho.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 4748,
    proxy: Object.fromEntries(
      API_ROUTES.map((route) => [
        route,
        // SSE precisa de proxy sem buffer, senão a timeline chega em blocos.
        { target, changeOrigin: true, ws: false },
      ]),
    ),
  },
});
