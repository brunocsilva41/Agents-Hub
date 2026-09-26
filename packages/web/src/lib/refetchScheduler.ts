/**
 * Agendador de recarga: N pedidos numa rajada viram UMA busca.
 *
 * Medido ao vivo: 253 requisições em 15 min com ~12 sessões. Cada evento
 * estrutural recarregava o índice, e a recarga de uma rajada não esperava a
 * anterior terminar — duas buscas iguais em voo ao mesmo tempo. Aqui:
 *
 * - `request()` só agenda; a busca roda `delayMs` depois do ÚLTIMO pedido
 *   (debounce), mas nunca mais que `maxWaitMs` depois do PRIMEIRO — um fluxo
 *   falante não pode adiar a atualização para sempre;
 * - com uma busca em voo, pedidos novos marcam "tem mais" e geram exatamente
 *   UMA busca ao fim dela, nunca duas simultâneas.
 *
 * Os relógios são injetáveis para o teste contar buscas sem esperar tempo real.
 */

export interface SchedulerClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const REAL_CLOCK: SchedulerClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface RefetchScheduler {
  /** Pede uma recarga. Barato: pode ser chamado a cada evento. */
  request(): void;
  /** Roda já (ou logo ao fim da busca em voo), sem esperar o debounce. */
  flush(): void;
  /** Cancela o que estiver agendado; buscas em voo terminam, mas não repetem. */
  dispose(): void;
  /** Há busca agendada ou em voo? */
  readonly pending: boolean;
}

export interface SchedulerOptions {
  delayMs?: number;
  maxWaitMs?: number;
  clock?: SchedulerClock;
  /** Chamado quando `run` rejeita; a falha não impede as próximas buscas. */
  onError?: (err: unknown) => void;
}

export function createRefetchScheduler(
  run: () => Promise<unknown>,
  { delayMs = 300, maxWaitMs = 1500, clock = REAL_CLOCK, onError }: SchedulerOptions = {},
): RefetchScheduler {
  let timer: unknown = null;
  let firstRequestAt: number | null = null;
  let inFlight = false;
  let again = false;
  let disposed = false;

  const clear = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const fire = (): void => {
    clear();
    firstRequestAt = null;
    if (disposed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(run());
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise
      .catch((err: unknown) => onError?.(err))
      .finally(() => {
        inFlight = false;
        if (again && !disposed) {
          again = false;
          // O que chegou durante a busca ainda não foi visto: uma (e só uma)
          // rodada a mais, também agrupada.
          schedule();
        }
      });
  };

  const schedule = (): void => {
    if (disposed) return;
    const now = clock.now();
    if (firstRequestAt === null) firstRequestAt = now;
    const waitLeft = Math.max(0, firstRequestAt + maxWaitMs - now);
    clear();
    timer = clock.setTimeout(fire, Math.min(delayMs, waitLeft));
  };

  return {
    request() {
      if (disposed) return;
      if (inFlight) {
        again = true;
        return;
      }
      schedule();
    },
    flush() {
      if (disposed) return;
      fire();
    },
    dispose() {
      disposed = true;
      clear();
      again = false;
    },
    get pending() {
      return timer !== null || inFlight;
    },
  };
}
