import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
// Rotas do daemon repassadas em desenvolvimento — e as que ficam de fora de
// propósito (`/shutdown`, `/maintenance`, `/hooks`, `/api`). A lista vive em
// módulo próprio para ter teste (`src/logic/api-routes.test.ts`).
import { API_ROUTES } from './src/logic/api-routes';

const target = process.env['AGENTS_HUB_URL'] ?? 'http://127.0.0.1:4747';

/**
 * Token de operador (item 1.6) para o painel em `vite dev`.
 *
 * Servida pelo daemon, a UI recebe o token por cookie HttpOnly ao carregar
 * `/`. Em desenvolvimento o documento vem do Vite (outra porta, outro host de
 * cookie), então esse cookie não existe — quem autentica é o PROXY: ele lê o
 * mesmo arquivo que a CLI (`<AGENTS_HUB_HOME>/operator-token`) a cada
 * requisição (o daemon pode ter nascido depois do Vite) e injeta o header,
 * declarando-se `web` para a auditoria. O script da página nunca vê o token.
 *
 * Consequência: enquanto `vite dev` estiver no ar, qualquer página que
 * consiga falar com o servidor do Vite age como operador — mesma confiança
 * que o proxy já tinha. É ferramenta de desenvolvimento; não deixe no ar à toa.
 */
function lerTokenDeOperador(): string | null {
  const home = process.env['AGENTS_HUB_HOME'] ?? path.join(os.homedir(), '.agents-hub');
  try {
    const t = readFileSync(path.join(home, 'operator-token'), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

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
              const token = lerTokenDeOperador();
              if (token) {
                proxyReq.setHeader('authorization', `Bearer ${token}`);
                proxyReq.setHeader('x-hub-client', 'web');
              }
            });
          },
        },
      ]),
    ),
  },
});
