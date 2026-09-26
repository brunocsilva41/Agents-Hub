import type { EventEnvelope } from '@agents-hub/core';
import {
  appendLive,
  HISTORY_PAGE,
  INITIAL_HISTORY,
  mergeBySeq,
  newestSeq,
  oldestSeq,
  pageHasMore,
  retryDelayMs,
  type HistoryState,
} from './eventMerge.js';
import { REAL_CLOCK, type SchedulerClock } from './refetchScheduler.js';

export interface FetchOptions {
  /** Os N mais recentes. */
  tail?: boolean;
  /** Os N anteriores a este `seq`. */
  before?: number;
  /** Os posteriores a este `seq` (repor buraco depois de reconexão). */
  since?: number;
  limit: number;
}

export type FetchEvents = (sessionId: string, options: FetchOptions) => Promise<EventEnvelope[]>;

/**
 * Timelines de todas as sessões que o painel já viu, com o estado de cada
 * histórico (carregando, falhou, há mais antigos, próxima tentativa).
 *
 * Sem React de propósito: o hook só assina `onChange`. É isto que deixa testar
 * as corridas que o painel perdia — evento ao vivo chegando antes ou durante a
 * busca do histórico, falha de rede que nunca era repetida.
 */
export class EventHistory {
  readonly #fetch: FetchEvents;
  readonly #clock: SchedulerClock;
  readonly #onChange: () => void;
  readonly #events = new Map<string, EventEnvelope[]>();
  readonly #history = new Map<string, HistoryState>();
  readonly #retryTimers = new Map<string, unknown>();
  #disposed = false;

  constructor(deps: { fetch: FetchEvents; onChange: () => void; clock?: SchedulerClock }) {
    this.#fetch = deps.fetch;
    this.#onChange = deps.onChange;
    this.#clock = deps.clock ?? REAL_CLOCK;
  }

  /** Mesma referência enquanto nada muda — seguro para `useMemo`. */
  events(sessionId: string): EventEnvelope[] {
    return this.#events.get(sessionId) ?? EMPTY;
  }

  history(sessionId: string): HistoryState {
    return this.#history.get(sessionId) ?? INITIAL_HISTORY;
  }

  /**
   * Garante que o histórico desta sessão foi (ou está sendo) buscado.
   *
   * Decide pelo ESTADO do histórico, não por "já tenho eventos": o SSE global
   * grava eventos de qualquer sessão viva, e a versão anterior tomava esse
   * cache parcial por histórico completo e nunca buscava o resto.
   */
  ensure(sessionId: string): void {
    if (!sessionId || this.#disposed) return;
    if (this.history(sessionId).status !== 'idle') return;
    void this.#loadLatest(sessionId);
  }

  /** Evento do SSE. Devolve `true` se mudou algo. */
  pushLive(event: EventEnvelope): boolean {
    const current = this.events(event.sessionId);
    const { events, trimmed } = appendLive(current, event);
    if (events === current) return false;
    this.#events.set(event.sessionId, events);
    if (trimmed) this.#patch(event.sessionId, { hasMoreBefore: true });
    this.#onChange();
    return true;
  }

  /** Página anterior ao evento mais antigo carregado. */
  async loadOlder(sessionId: string): Promise<void> {
    const state = this.history(sessionId);
    if (this.#disposed || state.loadingOlder || !state.hasMoreBefore) return;
    const before = oldestSeq(this.events(sessionId));
    if (before === null) return;
    this.#patch(sessionId, { loadingOlder: true, olderFailed: false });
    this.#onChange();
    try {
      const page = await this.#fetch(sessionId, { before, limit: HISTORY_PAGE });
      if (this.#disposed) return;
      this.#events.set(sessionId, mergeBySeq(this.events(sessionId), page));
      this.#patch(sessionId, { loadingOlder: false, hasMoreBefore: pageHasMore(page.length) });
    } catch {
      if (this.#disposed) return;
      this.#patch(sessionId, { loadingOlder: false, olderFailed: true });
    }
    this.#onChange();
  }

  /** Clique em "tentar de novo": zera o contador e busca já. */
  retry(sessionId: string): void {
    if (this.#disposed) return;
    this.#clearRetry(sessionId);
    this.#patch(sessionId, { failures: 0, nextRetryAt: null });
    void this.#loadLatest(sessionId);
  }

  /**
   * Depois de uma queda do SSE: o que passou enquanto estávamos fora não vem
   * por ele (o fluxo global não tem replay). Para cada sessão com histórico
   * carregado, busca o que veio depois do último `seq` conhecido.
   */
  async resync(): Promise<void> {
    const ready = [...this.#history.entries()].filter(([, h]) => h.status === 'ready');
    await Promise.all(
      ready.map(async ([sessionId]) => {
        const since = newestSeq(this.events(sessionId));
        try {
          const page =
            since === null
              ? await this.#fetch(sessionId, { tail: true, limit: HISTORY_PAGE })
              : await this.#fetch(sessionId, { since, limit: 5000 });
          if (this.#disposed || page.length === 0) return;
          this.#events.set(sessionId, mergeBySeq(this.events(sessionId), page));
          this.#onChange();
        } catch {
          // A próxima reconexão tenta de novo; o histórico que já está na tela
          // continua válido.
        }
      }),
    );
  }

  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#retryTimers.keys()]) this.#clearRetry(id);
  }

  async #loadLatest(sessionId: string): Promise<void> {
    const before = this.history(sessionId);
    this.#patch(sessionId, {
      status: before.status === 'ready' ? 'ready' : 'loading',
      nextRetryAt: null,
    });
    this.#onChange();
    try {
      const page = await this.#fetch(sessionId, { tail: true, limit: HISTORY_PAGE });
      if (this.#disposed) return;
      // MESCLA, não substitui: o que o SSE trouxe durante a requisição é mais
      // novo que a resposta e sumiria.
      this.#events.set(sessionId, mergeBySeq(page, this.events(sessionId)));
      this.#patch(sessionId, {
        status: 'ready',
        failures: 0,
        nextRetryAt: null,
        hasMoreBefore: pageHasMore(page.length) || this.history(sessionId).hasMoreBefore,
      });
    } catch {
      if (this.#disposed) return;
      const failures = this.history(sessionId).failures + 1;
      const delay = retryDelayMs(failures);
      const nextRetryAt = delay === null ? null : this.#clock.now() + delay;
      this.#patch(sessionId, { status: 'failed', failures, nextRetryAt });
      if (delay !== null) {
        this.#clearRetry(sessionId);
        this.#retryTimers.set(
          sessionId,
          this.#clock.setTimeout(() => {
            this.#retryTimers.delete(sessionId);
            void this.#loadLatest(sessionId);
          }, delay),
        );
      }
    }
    this.#onChange();
  }

  #clearRetry(sessionId: string): void {
    const timer = this.#retryTimers.get(sessionId);
    if (timer !== undefined) this.#clock.clearTimeout(timer);
    this.#retryTimers.delete(sessionId);
  }

  #patch(sessionId: string, patch: Partial<HistoryState>): void {
    this.#history.set(sessionId, { ...this.history(sessionId), ...patch });
  }
}

const EMPTY: EventEnvelope[] = [];
