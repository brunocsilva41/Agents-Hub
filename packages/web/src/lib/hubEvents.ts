import type { EventEnvelope } from '@agents-hub/core';

/**
 * O que cada evento do SSE significa para o índice do painel.
 *
 * Só eventos ESTRUTURAIS mudam sessões/aprovações a ponto de valer uma recarga
 * do índice. `user.message` entra aqui porque retomar uma sessão pausada por
 * mensagem troca o estado dela para `running` sem nenhum outro evento — sem
 * isto o painel ficava "PAUSADA" com a sessão rodando.
 */
export const STRUCTURAL_EVENTS: ReadonlySet<string> = new Set([
  'session.started',
  'session.ended',
  'session.handoff',
  'user.message',
  'delegation.requested',
  'delegation.completed',
  'approval.requested',
  'approval.resolved',
  'turn.completed',
  'budget.exceeded',
  'budget.warning',
  'error',
]);

export function isStructural(event: Pick<EventEnvelope, 'type'>): boolean {
  return STRUCTURAL_EVENTS.has(event.type);
}

const TERMINAL = new Set(['completed', 'failed', 'killed']);

/** Linha do índice que um evento pode atualizar sem ir ao servidor. */
export interface PatchableSession {
  id: string;
  state: string;
  updatedAt: string;
}

/**
 * Aplica ao índice o que o PRÓPRIO evento afirma, antes da recarga agrupada
 * chegar. Só o que o evento diz com todas as letras — estado terminal de
 * `session.ended`, `waiting_approval` de `approval.requested` — e nunca um
 * palpite: "usuário mandou mensagem, então deve estar rodando" é exatamente o
 * tipo de estado inventado que o painel não pode mostrar. O resto espera a
 * recarga, que traz a verdade do daemon.
 *
 * Devolve a MESMA lista quando nada muda, para não disparar render.
 */
export function patchSessionsFromEvent<T extends PatchableSession>(
  sessions: readonly T[],
  event: Pick<EventEnvelope, 'type' | 'sessionId' | 'ts' | 'payload'>,
): readonly T[] {
  const index = sessions.findIndex((s) => s.id === event.sessionId);
  if (index === -1) return sessions;
  const current = sessions[index] as T;

  let state = current.state;
  if (event.type === 'session.ended') {
    const declared = event.payload['state'];
    if (typeof declared === 'string' && TERMINAL.has(declared)) state = declared;
  } else if (event.type === 'approval.requested' && !TERMINAL.has(current.state)) {
    state = 'waiting_approval';
  }

  const updatedAt = event.ts > current.updatedAt ? event.ts : current.updatedAt;
  if (state === current.state && updatedAt === current.updatedAt) return sessions;

  const next = [...sessions];
  next[index] = { ...current, state, updatedAt };
  return next;
}
