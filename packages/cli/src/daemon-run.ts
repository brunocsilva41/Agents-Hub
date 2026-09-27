import {
  baseUrl,
  createHub,
  encerradorDoProcesso,
  instalarRedeDeSeguranca,
  readHubEnv,
  type Hub,
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
  const { host, port } = await subirDaemon(hub);
  const url = baseUrl({ host, port });
  console.log(green(`daemon ouvindo em ${url}`));
  console.log(`painel: ${bold(url)}`);
  console.log(dim(`home: ${hub.config.home}`));
  console.log(dim(`agentes: ${hub.registry.ids().join(', ')}`));

  // A guarda de reentrância existia só no outro entrypoint — e é este aqui que
  // o autostart usa. Dois Ctrl-C rodavam dois desligamentos concorrentes sobre
  // o mesmo banco. E sai mesmo que `hub.shutdown()` rejeite — ver
  // `encerradorDoProcesso`.
  const stop = encerradorDoProcesso(async (): Promise<void> => {
    console.log(dim('\nencerrando sessões vivas…'));
    await hub.shutdown();
  });
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  instalarRedeDeSeguranca(stop);
}

/** Há um Hub respondendo em `url`? (GET /health com `ok: true`, teto curto.) */
export async function haHubEm(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const corpo = (await res.json()) as { ok?: unknown };
    return corpo.ok === true;
  } catch {
    return false;
  }
}

/**
 * Traduz a falha de `listen` (vistoria 07, R07-07). `EADDRINUSE` virava
 * `Error: listen EADDRINUSE 127.0.0.1:4747` — sem dizer que, quase sempre, o
 * que ocupa a porta é o próprio daemon (autostart) e que não há nada a fazer
 * além de usá-lo. Pergunta ao ocupante se ele é um Hub para dar a resposta
 * certa. Outros erros passam como vieram.
 */
export async function explicarFalhaDeListen(
  err: unknown,
  url: string,
  sondar: (url: string) => Promise<boolean> = haHubEm,
): Promise<unknown> {
  if ((err as { code?: unknown } | null)?.code !== 'EADDRINUSE') return err;
  if (await sondar(url)) {
    return Object.assign(
      new Error(`já há um daemon em ${url} — veja o estado com: hub status (encerre com: hub stop)`),
      { code: 'DAEMON_ALREADY_RUNNING' },
    );
  }
  return Object.assign(
    new Error(
      `a porta de ${url} já está em uso por outro programa (não é um Agents-Hub) — ` +
        'escolha outra com AGENTS_HUB_PORT ou "port" no config.json',
    ),
    { code: 'PORT_IN_USE' },
  );
}

/**
 * `hub.start()` com a falha de porta explicada. Não chama `hub.shutdown()` na
 * falha: este processo não reconciliou nada, e encerrar "as sessões vivas"
 * daqui mexeria no banco do daemon que está de pé.
 */
export async function subirDaemon(
  hub: Hub,
  sondar?: (url: string) => Promise<boolean>,
): Promise<{ host: string; port: number }> {
  try {
    return await hub.start();
  } catch (err) {
    throw await explicarFalhaDeListen(err, baseUrl(hub.config), sondar);
  }
}
