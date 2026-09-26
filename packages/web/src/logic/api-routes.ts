/**
 * Rotas do daemon que o servidor de desenvolvimento do Vite repassa.
 *
 * Mora fora do `vite.config.ts` para poder ser testada sem subir o Vite: a aba
 * "Agentes detectados" quebrava no `npm run dev` porque `/discovery` não
 * estava aqui — a requisição caía no fallback de HTML do Vite e o painel
 * mostrava "o Hub respondeu algo que não é JSON" (vistoria 2026-09-25,
 * relatório 03). Em produção o próprio daemon serve a build, então tudo já é a
 * mesma origem e a lista não importa.
 */
export const API_ROUTES: readonly string[] = [
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
  '/discovery',
  '/policy',
  '/audit',
  '/integrations',
];

/**
 * Ficam FORA de propósito, mesmo existindo no daemon: `/shutdown`,
 * `/maintenance/sweep` e `/hooks/pretooluse`. Repassá-las pelo servidor de
 * desenvolvimento daria a qualquer página aberta no navegador um caminho para
 * derrubar o Hub ou responder por um gate de segurança. `/api/tasks` também
 * fica de fora: é a superfície de automação externa, não a da interface.
 */
export const ROTAS_FORA_DO_PROXY: readonly string[] = ['/shutdown', '/maintenance', '/hooks', '/api'];

/** A rota (caminho de requisição) seria repassada pelo proxy do Vite? */
export function passaPeloProxy(caminho: string): boolean {
  return API_ROUTES.some((r) => caminho === r || caminho.startsWith(`${r}/`) || caminho.startsWith(`${r}?`));
}
