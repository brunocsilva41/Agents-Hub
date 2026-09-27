import type { HubClient } from './client.js';
import { required } from './cmd-util.js';
import { dim, green, yellow } from './render.js';

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
  const r = await client.pause(sessionId);
  // O daemon diz o estado resultante: "pausada" só quando é verdade.
  if (r.state !== undefined && r.state !== 'paused') {
    console.log(yellow(`a sessão não ficou pausada (estado: ${r.state})`));
    return;
  }
  console.log(green('sessão pausada — o turno em andamento foi parado'));
  console.log(dim(`   retome com: hub send ${sessionId} "<próxima instrução>"`));
}
