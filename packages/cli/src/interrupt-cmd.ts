import type { HubClient } from './client.js';
import { dim, green, yellow } from './render.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * `hub interrupt` — para o turno em andamento e deixa a sessão ociosa.
 *
 * Antes imprimia "turno interrompido" sem olhar a resposta: numa sessão sem
 * turno (ou já concluída) também dizia sucesso, e no Windows a sessão
 * terminava `failed` logo depois (vistoria 2026-09-25, relatórios 06/07/13).
 * Agora o daemon devolve `interrupted` e o estado resultante, e a mensagem diz
 * o que de fato aconteceu — inclusive como retomar.
 *
 * Em arquivo próprio (como `pause-cmd.ts`) para ser testável sem importar
 * `main.ts`, que dispara `main()` no import.
 */
export async function interruptCommand(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  const r = await client.interrupt(sessionId);
  if (r.interrupted === false) {
    console.log(yellow('nenhum turno em andamento — nada foi interrompido'));
    return;
  }
  console.log(green(`turno interrompido — sessão ${rotulo(r.state ?? 'idle')}`));
  console.log(dim(`   retome com: hub send ${sessionId} "<próxima instrução>"`));
}

function rotulo(state: string): string {
  if (state === 'idle') return 'ociosa, retomável';
  if (state === 'paused') return 'pausada, retomável';
  return `no estado ${state}`;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`argumento obrigatório ausente: ${name}`);
  }
  return value;
}
