import type { BriefInput, HubClient } from './client.js';
import { sessaoOuErro } from './session-follow.js';

/**
 * `hub start --from <sessionId>`: continuar o trabalho de uma sessão que já
 * terminou numa sessão NOVA (vistoria 11, R11-05).
 *
 * O daemon não reabre sessão terminada (o resultado dela já foi entregue — ver
 * `session-continuation.ts`), e a recusa do `send` aponta para cá. A sessão
 * nova leva o que a anterior deixou:
 *
 * - `upstream`: o resumo da tarefa anterior no brief (o agente começa sabendo
 *   o que já foi feito, sem contexto nativo);
 * - `contextRefs`: o ponteiro `session:<id>` para a timeline, que o agente lê
 *   com `hub_context_fetch` se precisar;
 * - `baseSessionIds`: o worktree parte do branch `hub/<id>` da anterior (o
 *   daemon avisa quando não há branch, ex.: sessão sem worktree).
 */
export interface Continuacao {
  projectId: string;
  brief: Pick<BriefInput, 'upstream' | 'contextRefs'>;
  baseSessionIds: string[];
}

export async function continuacaoDe(client: HubClient, sessionId: string): Promise<Continuacao> {
  const { session } = await sessaoOuErro(client, sessionId);
  const { tasks } = await client.tasks(sessionId).catch(() => ({ tasks: [] }));
  const resumo =
    tasks[0]?.result?.summary ??
    `sessão ${session.state}${session.title ? `: ${session.title}` : ''} (sem resumo registrado)`;
  return {
    projectId: session.projectId,
    brief: {
      upstream: [
        { step: 'sessão anterior', agent: session.agentId, summary: resumo, sessionRef: `session:${session.id}` },
      ],
      contextRefs: [`session:${session.id}`],
    },
    baseSessionIds: [session.id],
  };
}
