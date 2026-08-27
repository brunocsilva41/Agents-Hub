import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { HubClient } from '@agents-hub/client';

/**
 * Sobe o daemon sozinho quando ele não está no ar.
 *
 * Sem isto, todo comando exige que você tenha deixado um terminal aberto com
 * `hub daemon` — e esquecer disso era o erro mais frequente de quem usa o Hub.
 * O daemon é detalhe de implementação do Hub, não uma cerimônia que o usuário
 * precisa executar.
 *
 * O processo sobe DESACOPLADO: sobrevive ao término do comando que o iniciou,
 * que é o que permite a sessão continuar viva depois que você fecha o terminal.
 */
export async function ensureDaemon(
  client: HubClient,
  options: { quiet?: boolean; timeoutMs?: number } = {},
): Promise<'ja-estava' | 'iniciado'> {
  if (await responde(client)) return 'ja-estava';

  if (process.env['AGENTS_HUB_NO_AUTOSTART'] === '1') {
    throw new Error(
      'daemon não está rodando e AGENTS_HUB_NO_AUTOSTART=1 impede subir sozinho. Rode: hub daemon',
    );
  }

  if (options.quiet !== true) {
    process.stderr.write('subindo o daemon…\n');
  }

  // `main.js` é este mesmo executável: reusar o próprio caminho evita depender
  // de instalação global ou de o `hub` estar no PATH.
  const entrada = fileURLToPath(new URL('./main.js', import.meta.url));

  const filho = spawn(process.execPath, [entrada, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  filho.unref();

  const limite = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < limite) {
    if (await responde(client)) return 'iniciado';
    await sleep(300);
  }

  throw new Error(
    'o daemon não respondeu a tempo. Rode `hub daemon` num terminal para ver o erro.',
  );
}

async function responde(client: HubClient): Promise<boolean> {
  try {
    await client.health();
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
