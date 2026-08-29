import { newId, nowIso } from './ids.js';

/**
 * O vocabulário único de eventos do Hub.
 *
 * Cada adapter traduz a saída nativa do seu agente para estes tipos. É o que
 * permite ver Claude, Codex e Cursor lado a lado na mesma timeline — e o que
 * permite ao grafo, ao painel de custo e ao replay existirem.
 */
export type EventType =
  | 'session.started'
  | 'session.ended'
  | 'session.handoff'
  | 'turn.started'
  | 'turn.completed'
  | 'message'
  | 'message.delta'
  | 'reasoning'
  | 'tool.call'
  | 'tool.result'
  | 'file.changed'
  | 'command.executed'
  | 'delegation.requested'
  | 'delegation.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'budget.updated'
  | 'budget.warning'
  | 'budget.exceeded'
  | 'error'
  | 'log';

export interface EventCost {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  usd?: number;
}

export interface EventEnvelope {
  id: string;
  /** Monotônico por sessão. Garante ordem total e permite replay determinístico. */
  seq: number;
  ts: string;
  sessionId: string;
  taskId: string | null;
  agentId: string;
  type: EventType;
  payload: Record<string, unknown>;
  cost: EventCost | null;
  /**
   * Evento original do agente, preservado na íntegra.
   * Quando um mapeamento estiver errado, a verdade ainda está aqui.
   */
  raw: unknown;
}

export interface EventDraft {
  sessionId: string;
  taskId?: string | null;
  agentId: string;
  type: EventType;
  payload?: Record<string, unknown>;
  cost?: EventCost | null;
  raw?: unknown;
}

/**
 * Sequenciador por sessão. Fica no domínio (e não no adapter) porque a ordem
 * é uma propriedade da sessão, não do processo que a produziu — importante
 * quando uma sessão é retomada por um processo novo.
 */
export class SequenceCounter {
  readonly #counters = new Map<string, number>();

  constructor(initial?: Iterable<[string, number]>) {
    if (initial) for (const [k, v] of initial) this.#counters.set(k, v);
  }

  next(sessionId: string): number {
    const current = this.#counters.get(sessionId) ?? 0;
    const next = current + 1;
    this.#counters.set(sessionId, next);
    return next;
  }

  seed(sessionId: string, value: number): void {
    this.#counters.set(sessionId, Math.max(value, this.#counters.get(sessionId) ?? 0));
  }
}

export function makeEvent(draft: EventDraft, seq: number): EventEnvelope {
  return {
    id: newId('evt'),
    seq,
    ts: nowIso(),
    sessionId: draft.sessionId,
    taskId: draft.taskId ?? null,
    agentId: draft.agentId,
    type: draft.type,
    payload: draft.payload ?? {},
    cost: draft.cost ?? null,
    raw: draft.raw ?? null,
  };
}

/** Eventos que a UI trata como "o agente falou algo que vale mostrar". */
export const NARRATIVE_EVENTS: readonly EventType[] = [
  'message',
  'reasoning',
  'tool.call',
  'command.executed',
  'file.changed',
  'error',
];
