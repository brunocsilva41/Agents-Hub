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
  /**
   * Fala do humano (ou de quem chamou `send`) para a sessão. Tipo à parte, e
   * não `message` com um `role`: histórico reconstruído, resumo de tarefa e
   * retorno de delegação leem `message` como fala do AGENTE.
   */
  | 'user.message'
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
  /** Tokens LIDOS do cache. */
  cachedTokens?: number;
  /** Tokens ESCRITOS no cache (Anthropic cobra 1,25x a entrada por eles). */
  cacheWriteTokens?: number;
  usd?: number;
  /**
   * Estimativa parcial do turno em andamento — NÃO é somada em lugar nenhum
   * (store, grafo, orçamento). O custo final do turno (o `result` do Claude,
   * por exemplo) substitui todas as parciais; se o turno morrer sem ele, o
   * Hub fecha a conta com a última estimativa num evento próprio.
   *
   * Existe porque o Claude repete o `usage` completo da mesma mensagem em cada
   * linha do stream e ainda manda o total no `result`: somar tudo contava o
   * turno duas ou três vezes.
   */
  provisional?: boolean;
  /**
   * Identidade da parcial (ex.: `message.id` do Claude). Parciais com o mesmo
   * `partId` se substituem; com ids diferentes, somam dentro do turno.
   */
  partId?: string;
  /**
   * `usd` é o ACUMULADO da sessão nativa, não o incremento deste evento (os
   * créditos do Copilot vêm assim). Sempre acompanha `provisional: true`.
   */
  cumulative?: boolean;
  /** Créditos informados pelo agente (Copilot: AI Credits), quando houver. */
  credits?: number;
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
