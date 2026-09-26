import type { HubClient } from './client.js';
import { flagOn, type Args } from './cmd-util.js';
import { bold, dim, green, yellow } from './render.js';

export interface RestartDeps {
  /** Sobe o daemon (em produção, `ensureDaemon`). */
  start: () => Promise<unknown>;
  /** Quanto esperar o daemon antigo largar a porta. */
  timeoutMs?: number;
  pollMs?: number;
}

async function responde(client: HubClient): Promise<{ version: string; liveSessions: number } | null> {
  try {
    const h = await client.health();
    return { version: h.version, liveSessions: h.liveSessions };
  } catch {
    return null;
  }
}

/**
 * `hub restart [--force]` — encerra o daemon (com o token de operador, como
 * `hub stop`) e sobe de novo.
 *
 * Existe porque o daemon sobrevive ao terminal: depois de `git pull && npm run
 * build`, sem isto você seguia rodando o código antigo. Encerrar o daemon
 * encerra as sessões vivas — por isso, com sessão rodando, recusa sem
 * `--force` em vez de matar trabalho em silêncio.
 *
 * A subida só acontece DEPOIS de o antigo parar de responder: subir antes
 * faria o novo morrer com EADDRINUSE e o `health` ainda responder — pelo
 * processo velho.
 */
export async function restartCommand(client: HubClient, args: Args, deps: RestartDeps): Promise<void> {
  const antes = await responde(client);

  if (antes !== null) {
    if (antes.liveSessions > 0 && !flagOn(args, 'force')) {
      throw new Error(
        `${antes.liveSessions} sessão(ões) viva(s) seriam encerradas pelo reinício. ` +
          'Espere terminarem (hub status) ou repita com --force.',
      );
    }
    await client.shutdown();
    console.log(dim('daemon encerrando…'));

    const limite = Date.now() + (deps.timeoutMs ?? 20_000);
    while ((await responde(client)) !== null) {
      if (Date.now() > limite) {
        throw new Error('o daemon aceitou o encerramento mas continua respondendo; tente de novo em instantes.');
      }
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 200));
    }
  } else {
    console.log(dim('o daemon não estava rodando — só subindo.'));
  }

  await deps.start();
  const depois = await responde(client);
  if (depois === null) {
    throw new Error('o daemon não voltou. Veja: hub logs');
  }
  console.log(`${green('daemon reiniciado')} ${dim(`v${depois.version}`)}`);
  if (antes !== null && antes.liveSessions > 0) {
    console.log(yellow(`${antes.liveSessions} sessão(ões) viva(s) foram encerradas (--force).`));
  }
  console.log(dim('logs:'), bold('hub logs'));
}
