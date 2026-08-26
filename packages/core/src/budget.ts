import { HubError } from './errors.js';

export interface BudgetLimits {
  usd: number;
  tokens: number;
  seconds: number;
}

export interface BudgetUsage {
  usd: number;
  tokens: number;
  seconds: number;
}

export const ZERO_USAGE: BudgetUsage = { usd: 0, tokens: 0, seconds: 0 };

export function addUsage(a: BudgetUsage, b: Partial<BudgetUsage>): BudgetUsage {
  return {
    usd: a.usd + (b.usd ?? 0),
    tokens: a.tokens + (b.tokens ?? 0),
    seconds: a.seconds + (b.seconds ?? 0),
  };
}

export function subUsage(a: BudgetUsage, b: Partial<BudgetUsage>): BudgetUsage {
  return {
    usd: Math.max(0, a.usd - (b.usd ?? 0)),
    tokens: Math.max(0, a.tokens - (b.tokens ?? 0)),
    seconds: Math.max(0, a.seconds - (b.seconds ?? 0)),
  };
}

export interface BudgetSnapshot {
  limits: BudgetLimits;
  consumed: BudgetUsage;
  reserved: BudgetUsage;
  remaining: BudgetUsage;
  exhausted: boolean;
  /** Fração do limite mais apertado (0..1+). É o número que a UI mostra. */
  pressure: number;
}

/**
 * Livro-caixa de uma sessão-raiz (ADR 03.2).
 *
 * O orçamento é do FLUXO, não do agente: quando A delega para B, B reserva uma
 * fatia do saldo restante da raiz. Sem isso, cada agente teria seu próprio teto
 * e a soma escaparia do controle — que é exatamente como uma cadeia de
 * delegação vira uma conta cara sem ninguém perceber.
 */
export class BudgetLedger {
  readonly rootId: string;
  #limits: BudgetLimits;
  #consumed: BudgetUsage;
  #reserved: BudgetUsage;
  readonly #reservations = new Map<string, BudgetUsage>();

  constructor(
    rootId: string,
    limits: BudgetLimits,
    consumed: BudgetUsage = ZERO_USAGE,
    reserved: BudgetUsage = ZERO_USAGE,
  ) {
    this.rootId = rootId;
    this.#limits = limits;
    this.#consumed = consumed;
    this.#reserved = reserved;
  }

  get limits(): BudgetLimits {
    return this.#limits;
  }

  snapshot(): BudgetSnapshot {
    const remaining: BudgetUsage = {
      usd: this.#limits.usd - this.#consumed.usd - this.#reserved.usd,
      tokens: this.#limits.tokens - this.#consumed.tokens - this.#reserved.tokens,
      seconds: this.#limits.seconds - this.#consumed.seconds - this.#reserved.seconds,
    };
    const pressure = Math.max(
      safeRatio(this.#consumed.usd + this.#reserved.usd, this.#limits.usd),
      safeRatio(this.#consumed.tokens + this.#reserved.tokens, this.#limits.tokens),
      safeRatio(this.#consumed.seconds + this.#reserved.seconds, this.#limits.seconds),
    );
    return {
      limits: this.#limits,
      consumed: this.#consumed,
      reserved: this.#reserved,
      remaining,
      exhausted: remaining.usd <= 0 || remaining.tokens <= 0 || remaining.seconds <= 0,
      pressure,
    };
  }

  /**
   * Reserva uma fatia para uma task filha. Se o pedido não couber no saldo,
   * lança `BUDGET_EXCEEDED` — a task nasce em `input_required` e espera você.
   */
  reserve(taskId: string, request: Partial<BudgetLimits>): BudgetUsage {
    const { remaining } = this.snapshot();
    const want: BudgetUsage = {
      usd: request.usd ?? remaining.usd,
      tokens: request.tokens ?? remaining.tokens,
      seconds: request.seconds ?? remaining.seconds,
    };

    if (want.usd > remaining.usd || want.tokens > remaining.tokens || want.seconds > remaining.seconds) {
      throw new HubError(
        'BUDGET_EXCEEDED',
        'A reserva pedida excede o orçamento restante da sessão-raiz',
        { rootId: this.rootId, requested: want, remaining },
      );
    }

    this.#reservations.set(taskId, want);
    this.#reserved = addUsage(this.#reserved, want);
    return want;
  }

  /** Converte reserva em consumo real e devolve o que sobrou ao saldo. */
  settle(taskId: string, actual: Partial<BudgetUsage>): BudgetSnapshot {
    const reservation = this.#reservations.get(taskId);
    if (reservation) {
      this.#reserved = subUsage(this.#reserved, reservation);
      this.#reservations.delete(taskId);
    }
    this.#consumed = addUsage(this.#consumed, actual);
    return this.snapshot();
  }

  /** Consumo incremental durante a execução (cada evento com custo). */
  charge(actual: Partial<BudgetUsage>): BudgetSnapshot {
    this.#consumed = addUsage(this.#consumed, actual);
    return this.snapshot();
  }

  release(taskId: string): void {
    const reservation = this.#reservations.get(taskId);
    if (!reservation) return;
    this.#reserved = subUsage(this.#reserved, reservation);
    this.#reservations.delete(taskId);
  }

  /** Usado quando você aprova aumento de orçamento numa task travada. */
  raiseLimits(delta: Partial<BudgetLimits>): BudgetSnapshot {
    this.#limits = {
      usd: this.#limits.usd + (delta.usd ?? 0),
      tokens: this.#limits.tokens + (delta.tokens ?? 0),
      seconds: this.#limits.seconds + (delta.seconds ?? 0),
    };
    return this.snapshot();
  }
}

function safeRatio(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? Number.POSITIVE_INFINITY : 0;
  return used / limit;
}
