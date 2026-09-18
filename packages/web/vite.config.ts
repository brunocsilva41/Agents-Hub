import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/** Rotas do daemon — em desenvolvimento o Vite as repassa; em produção o
 *  próprio daemon serve esta build, então tudo já é a mesma origem. */
const API_ROUTES = [
  '/health',
  '/agents',
  '/approvals',
  '/projects',
  '/sessions',
  '/tasks',
  '/graph',
  '/budget',
  '/events',
  '/context',
];

// Ficam FORA de propósito, mesmo existindo no daemon: `/shutdown`,
// `/maintenance/sweep` e `/hooks/pretooluse`. Repassá-las pelo servidor de
// desenvolvimento daria a qualquer página aberta no navegador um caminho para
// derrubar o Hub ou responder por um gate de segurança. `/api/tasks` também
// fica de fora: é a superfície de automação externa, não a da interface.

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
      API_ROUTES.map((route): [string, ProxyOptions] => [
        route,
        {
          target,
          changeOrigin: true,
          ws: false,
          // `changeOrigin` reescreve o `Host`, mas NÃO o `Origin` — e o daemon
          // checa os dois. O navegador manda `Origin: http://localhost:4748`
          // em todo POST, inclusive de mesma origem, e a guarda de borda
          // rejeita com 403 porque a porta não é a dela.
          //
          // O efeito era silencioso e total: a interface listava tudo (GET não
          // leva `Origin`) mas nenhuma acao de escrita funcionava — criar
          // sessão, aprovar, negar, cancelar, enviar. Os botões estavam ali e
          // não faziam nada.
          //
          // A correção fica aqui, e não afrouxando a guarda para aceitar
          // qualquer porta loopback: isso deixaria um XSS em qualquer outro
          // servidor local dirigir o Hub, e uma máquina de desenvolvimento
          // costuma ter vários no ar.
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('origin', target);
            });
          },
        },
      ]),
    ),
  },
});
