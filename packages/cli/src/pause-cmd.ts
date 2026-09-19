import type { HubClient } from './client.js';
import { green } from './render.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * `hub pause` — a rota existia no daemon (`POST /sessions/:id/pause`) e no
 * client (`HubClient.pause`) desde sempre, mas nenhuma superfície a expunha.
 * Mesmo tratamento de `hub interrupt`/`hub cancel`: pega o id posicional,
 * chama o client e confirma em uma linha. Fica em arquivo próprio (como
 * `workflow-cmd.ts`) para poder ser testado sem importar `main.ts`, que
 * dispara `main()` como efeito colateral do próprio import.
 */
export async function pauseCommand(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  await client.pause(sessionId);
  console.log(green('sessão pausada'));
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`argumento obrigatório ausente: ${name}`);
  }
  return value;
}
