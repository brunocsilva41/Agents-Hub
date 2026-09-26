import type { SchedulerClock } from './refetchScheduler.js';

/**
 * Relógio manual para os testes da lógica do painel: timers só disparam em
 * `advance`, e a ordem é a do instante agendado. Mora fora dos `.test.ts` para
 * ser compartilhado entre eles; não é importado por nada do painel.
 */
export class FakeClock implements SchedulerClock {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Avança o relógio disparando, em ordem, tudo que vencer no caminho. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.#timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId) as { at: number; fn: () => void };
      this.#timers.delete(nextId);
      this.#now = timer.at;
      timer.fn();
      await flushMicrotasks();
    }
    this.#now = target;
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
