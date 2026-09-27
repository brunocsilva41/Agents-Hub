/**
 * Estado de ciclo de vida das sessões que NÃO mora no banco: o que foi pedido
 * a uma run (cancelar, interromper, pausar) e o que ainda está fechando depois
 * de o processo sair (validação, revisão, backoff de retry).
 *
 * Existe por causa de uma corrida medida na vistoria de 2026-09-25 (relatório
 * 06): `cancel` matava a run e gravava `killed`, mas o `#pump` da mesma run
 * seguia depois de `await handle.done`, via o desfecho `canceled`, passava pelo
 * pipeline de falha e sobrescrevia com `failed` — em 6 de 8 tentativas. O
 * processo morto não diz POR QUE morreu; quem pediu a morte precisa deixar isso
 * anotado ANTES de matar, e o pump precisa ler a anotação em vez de adivinhar.
 *
 * Separado de `session-manager.ts` para a mudança lá ficar pequena.
 */

/** O que foi pedido a uma sessão viva, anotado antes de mexer no processo. */
export interface PedidoDeParada {
  tipo: 'cancel' | 'interrupt' | 'pause';
  motivo: string;
}

export class CicloDeVida {
  readonly #pedidos = new Map<string, PedidoDeParada>();
  /**
   * Sessões cuja run já saiu de `#runs` mas cujo desfecho ainda está sendo
   * decidido (`#settle`: validação, revisão, backoff). O `AbortController` é
   * o que deixa `cancel`/`shutdown` matarem o comando de validação ou o
   * revisor em vez de esperá-los — ou de deixá-los órfãos.
   */
  readonly #fechando = new Map<string, AbortController>();
  /** Pump mais recente de cada sessão, para quem precisa esperar o desfecho. */
  readonly #pumps = new Map<string, Promise<void>>();

  /**
   * Anota o pedido. Cancelar vence interromper/pausar: quem pediu para matar
   * não pode ver a sessão voltar a `idle` porque um pause chegou antes.
   */
  pedir(sessionId: string, pedido: PedidoDeParada): void {
    const atual = this.#pedidos.get(sessionId);
    if (atual?.tipo === 'cancel' && pedido.tipo !== 'cancel') return;
    this.#pedidos.set(sessionId, pedido);
  }

  pedido(sessionId: string): PedidoDeParada | undefined {
    return this.#pedidos.get(sessionId);
  }

  cancelada(sessionId: string): boolean {
    return this.#pedidos.get(sessionId)?.tipo === 'cancel';
  }

  esquecer(sessionId: string): void {
    this.#pedidos.delete(sessionId);
  }

  /** Marca o início do fechamento de uma run e devolve o sinal que o aborta. */
  abrirFechamento(sessionId: string): AbortController {
    const controle = new AbortController();
    // Um pedido de cancelamento que chegou entre o fim do processo e este
    // ponto já vale: o fechamento nasce abortado.
    if (this.cancelada(sessionId)) controle.abort();
    this.#fechando.set(sessionId, controle);
    return controle;
  }

  /** Fecha só o fechamento que abriu — um retry pode ter aberto outro depois. */
  fecharFechamento(sessionId: string, controle: AbortController): void {
    if (this.#fechando.get(sessionId) === controle) this.#fechando.delete(sessionId);
  }

  emFechamento(sessionId: string): boolean {
    return this.#fechando.has(sessionId);
  }

  sessoesEmFechamento(): string[] {
    return [...this.#fechando.keys()];
  }

  /** Aborta validação/revisão/backoff em andamento. `true` se havia algo. */
  abortarFechamento(sessionId: string): boolean {
    const controle = this.#fechando.get(sessionId);
    if (!controle) return false;
    controle.abort();
    return true;
  }

  registrarPump(sessionId: string, pump: Promise<void>): void {
    this.#pumps.set(sessionId, pump);
    const esquecer = (): void => {
      if (this.#pumps.get(sessionId) === pump) this.#pumps.delete(sessionId);
    };
    // `then(f, f)` e não `finally(f)`: `finally` devolve uma promessa NOVA que
    // rejeita junto com o pump — e essa ninguém observa, virando
    // `unhandledRejection`. Quem reporta a falha do pump é quem o criou.
    pump.then(esquecer, esquecer);
  }

  /**
   * Espera o(s) pump(s) da sessão terminarem, até `tetoMs`.
   *
   * Em laço porque o fechamento de uma run pode lançar a seguinte (retry):
   * esperar só a promessa vista no começo devolveria o controle com uma run
   * nova recém-nascida. Devolve `false` se o teto venceu.
   */
  async aguardarPump(sessionId: string, tetoMs: number): Promise<boolean> {
    const limite = Date.now() + tetoMs;
    for (;;) {
      const pump = this.#pumps.get(sessionId);
      if (!pump) return true;
      const restante = limite - Date.now();
      if (restante <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const venceu = await Promise.race([
        pump.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), restante);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (venceu) return false;
      // Dá uma volta no loop de eventos para o `finally` do registro rodar.
      await new Promise((r) => setImmediate(r));
      if (this.#pumps.get(sessionId) === pump) return true;
    }
  }
}

/**
 * `sleep` que acorda cedo quando o sinal aborta. Devolve `true` se foi
 * abortado — o backoff de retry não pode segurar um cancelamento por segundos.
 */
export function esperarAbortavel(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aoAbortar);
      resolve(false);
    }, ms);
    const aoAbortar = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', aoAbortar, { once: true });
  });
}
