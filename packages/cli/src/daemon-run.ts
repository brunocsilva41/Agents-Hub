import {
  baseUrl,
  createHub,
  instalarRedeDeSeguranca,
  readHubEnv,
  type HubConfig,
  type HubEnv,
} from '@agents-hub/daemon';
import { bold, dim, green } from './render.js';

/**
 * Overrides de `HubConfig` derivados do ambiente — a mesma lógica que
 * `packages/daemon/src/main.ts` usa no outro entrypoint. Extraída como função
 * pura para ser testável sem precisar rodar o daemon de verdade: antes desta
 * mudança, `runDaemon()` (chamado por `hub daemon`, que é o caminho que o
 * autostart usa) ignorava `AGENTS_HUB_PORT` por completo, e nada na suíte
 * cobria essa lacuna.
 */
export function resolveDaemonOverrides(env: HubEnv): Partial<HubConfig> {
  return env.AGENTS_HUB_PORT !== undefined ? { port: env.AGENTS_HUB_PORT } : {};
}

export async function runDaemon(): Promise<void> {
  // Este é o caminho que o autostart usa (`ensureDaemon` em `daemon-control.ts`)
  // — o outro entrypoint, `daemon/src/main.ts`, só roda se alguém chamar
  // `node packages/daemon/dist/main.js` direto. Os dois precisam respeitar as
  // mesmas variáveis de ambiente; antes desta correção só o segundo lia
  // `AGENTS_HUB_PORT`, e o caminho mais usado o ignorava silenciosamente.
  const hub = createHub(resolveDaemonOverrides(readHubEnv()));
  // `start()` e não `server.listen()`: ligar a porta é o que impede um segundo
  // daemon de reconciliar o banco e declarar mortas as sessões do primeiro.
  // Este é o caminho que o autostart executa, então é o que mais precisa disto.
  const { host, port } = await hub.start();
  const url = baseUrl({ host, port });
  console.log(green(`daemon ouvindo em ${url}`));
  console.log(`painel: ${bold(url)}`);
  console.log(dim(`home: ${hub.config.home}`));
  console.log(dim(`agentes: ${hub.registry.ids().join(', ')}`));

  // A guarda de reentrância existia só no outro entrypoint — e é este aqui que
  // o autostart usa. Dois Ctrl-C rodavam dois desligamentos concorrentes sobre
  // o mesmo banco.
  let encerrando = false;
  const stop = async (): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    console.log(dim('\nencerrando sessões vivas…'));
    await hub.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  instalarRedeDeSeguranca(stop);
}
