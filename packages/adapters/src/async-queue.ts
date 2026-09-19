/**
 * Fila assíncrona de item único produtor → consumidor.
 *
 * O adapter empurra eventos conforme o processo do agente fala; o consumidor
 * (SessionManager) itera com `for await`. Sem isso, precisaríamos bufferizar
 * toda a saída e perderíamos o streaming ao vivo — que é justamente o que
 * permite interromper um agente antes que ele faça besteira.
 *
 * Watermarks: o consumidor faz uma escrita SQLite síncrona por evento, então
 * um produtor mais rápido (stdout de um agente falante, ou um stream SSE)
 * pode empilhar itens em memória sem limite algum. `onPressureChange` avisa
 * quem produz quando cruzar o teto de cima (pare de produzir) e quando voltar
 * a cruzar o de baixo (pode continuar) — a fila em si não impõe backpressure
 * sozinha, só oferece o sinal para quem sabe pausar a fonte.
 */
export interface AsyncQueueOptions {
  /** Nº de itens pendentes a partir do qual `onPressureChange(true)` dispara. */
  highWaterMark?: number;
  /** Nº de itens pendentes em que, descendo, `onPressureChange(false)` dispara. */
  lowWaterMark?: number;
  /** Chamado ao cruzar o teto de cima (push) ou o de baixo (consumo). */
  onPressureChange?: (aboveHigh: boolean) => void;
}

interface DrainWaiter {
  threshold: number;
  resolve: () => void;
}

const DEFAULT_HIGH_WATER_MARK = 1000;

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  readonly #drainWaiters: DrainWaiter[] = [];
  readonly #highWaterMark: number;
  readonly #lowWaterMark: number;
  readonly #onPressureChange?: (aboveHigh: boolean) => void;
  #aboveHigh = false;
  #closed = false;

  constructor(options: AsyncQueueOptions = {}) {
    this.#highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.#lowWaterMark = options.lowWaterMark ?? Math.floor(this.#highWaterMark / 2);
    this.#onPressureChange = options.onPressureChange;
  }

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      // Entregue direto a quem já esperava: nunca passou por `#items`, então
      // não pode empurrar a fila para cima do teto sozinho.
      waiter({ value: item, done: false });
      return;
    }
    this.#items.push(item);
    if (!this.#aboveHigh && this.#items.length >= this.#highWaterMark) {
      this.#aboveHigh = true;
      this.#onPressureChange?.(true);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.({ value: undefined as never, done: true });
    }
    // Fila fechada não vai drenar mais nada por conta própria — quem estava
    // esperando `whenBelow` ficaria pendurado para sempre sem isto.
    const pendentes = this.#drainWaiters.splice(0);
    for (const w of pendentes) w.resolve();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pending(): number {
    return this.#items.length;
  }

  /**
   * Resolve quando `pending` estiver abaixo de `threshold` — de imediato, se já
   * estiver, ou assim que o consumo cruzar essa marca. É o que dá a um produtor
   * (o loop de consumo do SSE do OpenCode, por exemplo) um jeito de pausar a si
   * mesmo com `await` em vez de continuar empurrando para uma fila que já não
   * dá conta.
   */
  whenBelow(threshold: number): Promise<void> {
    if (this.#closed || this.#items.length < threshold) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push({ threshold, resolve }));
  }

  #afterConsume(): void {
    if (this.#aboveHigh && this.#items.length <= this.#lowWaterMark) {
      this.#aboveHigh = false;
      this.#onPressureChange?.(false);
    }
    if (this.#drainWaiters.length === 0) return;
    const restantes: DrainWaiter[] = [];
    for (const w of this.#drainWaiters) {
      if (this.#items.length < w.threshold) w.resolve();
      else restantes.push(w);
    }
    this.#drainWaiters.length = 0;
    this.#drainWaiters.push(...restantes);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) {
          this.#afterConsume();
          return Promise.resolve({ value: item, done: false });
        }
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
