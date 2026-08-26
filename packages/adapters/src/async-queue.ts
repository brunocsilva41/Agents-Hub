/**
 * Fila assíncrona de item único produtor → consumidor.
 *
 * O adapter empurra eventos conforme o processo do agente fala; o consumidor
 * (SessionManager) itera com `for await`. Sem isso, precisaríamos bufferizar
 * toda a saída e perderíamos o streaming ao vivo — que é justamente o que
 * permite interromper um agente antes que ele faça besteira.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pending(): number {
    return this.#items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
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
