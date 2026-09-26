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

/**
 * Valor de uso aproveitável: finito e >= 0; o resto vira zero.
 *
 * Um adapter que emita custo malformado não pode desligar o teto: `NaN`
 * contaminava `consumed` para sempre (toda comparação com NaN é falsa, então
 * `exhausted` nunca mais disparava) e um negativo "devolvia" gasto de verdade.
 */
function aproveitavel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Normaliza um uso parcial para as três dimensões, sem NaN nem negativos. */
export function sanitizeUsage(u: Partial<BudgetUsage> | null | undefined): BudgetUsage {
  return {
    usd: aproveitavel(u?.usd),
    tokens: aproveitavel(u?.tokens),
    seconds: aproveitavel(u?.seconds),
  };
}

export function addUsage(a: BudgetUsage, b: Partial<BudgetUsage>): BudgetUsage {
  const d = sanitizeUsage(b);
  return {
    usd: a.usd + d.usd,
    tokens: a.tokens + d.tokens,
    seconds: a.seconds + d.seconds,
  };
}

export function subUsage(a: BudgetUsage, b: Partial<BudgetUsage>): BudgetUsage {
  const d = sanitizeUsage(b);
  return {
    usd: Math.max(0, a.usd - d.usd),
    tokens: Math.max(0, a.tokens - d.tokens),
    seconds: Math.max(0, a.seconds - d.seconds),
  };
}

export interface BudgetProjection {
  projectedUsd: number;
  projectedTokens: number;
  burnRateUsdPerSec: number;
}

export interface BudgetSnapshot {
  limits: BudgetLimits;
  /** Gasto confirmado + estimativas em aberto dos turnos em andamento. */
  consumed: BudgetUsage;
  /** Parte das fatias reservadas pelos filhos que eles ainda NÃO gastaram. */
  reserved: BudgetUsage;
  remaining: BudgetUsage;
  exhausted: boolean;
  /** Fração do limite mais apertado (0..1+). É o número que a UI mostra. */
  pressure: number;
  /** Verdadeiro quando a pressão atingiu o limiar de alerta (ex.: >= 80%). */
  isWarning: boolean;
}

/** Fatia de um filho: o que ele pediu e o que já gastou dela. */
interface Fatia {
  pedido: BudgetUsage;
  gasto: BudgetUsage;
}

/**
 * Livro-caixa de uma sessão-raiz (ADR 03.2).
 *
 * O orçamento é do FLUXO, não do agente: quando A delega para B, B reserva uma
 * fatia do saldo restante da raiz. Sem isso, cada agente teria seu próprio teto
 * e a soma escaparia do controle — que é exatamente como uma cadeia de
 * delegação vira uma conta cara sem ninguém perceber.
 *
 * Invariante: o gasto de uma task SAI da fatia dela. Antes, `charge` somava em
 * `consumed` sem abater a reserva, e a fatia contava duas vezes (consumida e
 * reservada) — reservar 6 de 10 e gastar 5 dava `remaining = -1` e um
 * `exhausted` falso que pausava o fluxo inteiro com 55% gasto.
 */
export class BudgetLedger {
  readonly rootId: string;
  #limits: BudgetLimits;
  #consumed: BudgetUsage;
  /** Reserva herdada de fora (persistida) sem task conhecida nesta instância. */
  #reservedBase: BudgetUsage;
  readonly #reservations = new Map<string, Fatia>();
  /**
   * Estimativas em aberto por escopo (normalmente o id da task): o custo
   * parcial de um turno que ainda não terminou. Cada nova estimativa do mesmo
   * escopo SUBSTITUI a anterior, e o `charge` do valor final a apaga — é o que
   * impede as linhas intermediárias de somarem ao total do turno.
   */
  readonly #estimates = new Map<string, BudgetUsage>();

  constructor(
    rootId: string,
    limits: BudgetLimits,
    consumed: BudgetUsage = ZERO_USAGE,
    reserved: BudgetUsage = ZERO_USAGE,
  ) {
    this.rootId = rootId;
    this.#limits = limits;
    this.#consumed = sanitizeUsage(consumed);
    this.#reservedBase = sanitizeUsage(reserved);
  }

  get limits(): BudgetLimits {
    return this.#limits;
  }

  snapshot(warningThreshold = 0.8): BudgetSnapshot {
    let consumed = this.#consumed;
    for (const estimativa of this.#estimates.values()) consumed = addUsage(consumed, estimativa);

    let reserved = this.#reservedBase;
    for (const [taskId, fatia] of this.#reservations) {
      const usado = addUsage(fatia.gasto, this.#estimates.get(taskId) ?? ZERO_USAGE);
      reserved = addUsage(reserved, subUsage(fatia.pedido, usado));
    }

    const remaining: BudgetUsage = {
      usd: this.#limits.usd - consumed.usd - reserved.usd,
      tokens: this.#limits.tokens - consumed.tokens - reserved.tokens,
      seconds: this.#limits.seconds - consumed.seconds - reserved.seconds,
    };
    const pressure = Math.max(
      safeRatio(consumed.usd + reserved.usd, this.#limits.usd),
      safeRatio(consumed.tokens + reserved.tokens, this.#limits.tokens),
      safeRatio(consumed.seconds + reserved.seconds, this.#limits.seconds),
    );
    // Esgotado = o gasto alcançou o teto, ou passou por cima de fatia alheia.
    // Saldo exatamente zero só porque tudo está RESERVADO não é esgotamento:
    // a fatia existe justamente para ser gasta por quem a pediu.
    const exhausted =
      consumed.usd >= this.#limits.usd ||
      consumed.tokens >= this.#limits.tokens ||
      consumed.seconds >= this.#limits.seconds ||
      remaining.usd < 0 ||
      remaining.tokens < 0 ||
      remaining.seconds < 0;
    return {
      limits: this.#limits,
      consumed,
      reserved,
      remaining,
      exhausted,
      pressure,
      isWarning: pressure >= warningThreshold && !exhausted,
    };
  }

  /**
   * Calcula a projeção de custo final e taxa de consumo (burn rate)
   * com base no tempo decorrido até agora.
   */
  project(elapsedSeconds: number, targetDurationSeconds?: number): BudgetProjection {
    const { consumed } = this.snapshot();
    const totalSecs = targetDurationSeconds ?? this.#limits.seconds;
    const safeElapsed = Math.max(1, aproveitavel(elapsedSeconds));
    const burnRateUsdPerSec = consumed.usd / safeElapsed;
    const burnRateTokensPerSec = consumed.tokens / safeElapsed;

    return {
      projectedUsd: burnRateUsdPerSec * totalSecs,
      projectedTokens: Math.round(burnRateTokensPerSec * totalSecs),
      burnRateUsdPerSec,
    };
  }

  /**
   * Reserva uma fatia para uma task filha. Se o pedido não couber no saldo,
   * lança `BUDGET_EXCEEDED` — a task nasce em `input_required` e espera você.
   *
   * Reservar de novo o mesmo `taskId` (retry/fallback movem a task mantendo o
   * id) SUBSTITUI a fatia anterior. Antes somava as duas, e o `release` único
   * deixava a primeira presa até o daemon reiniciar.
   */
  reserve(taskId: string, request: Partial<BudgetLimits>): BudgetUsage {
    // Dimensão não pedida reserva ZERO, não "todo o resto".
    // Reservar o saldo inteiro faria o primeiro filho de um fan-out travar
    // todos os irmãos com BUDGET_EXCEEDED — o teto do fluxo continua sendo
    // garantido pelo `charge`, que é onde o consumo real acontece.
    const want = sanitizeUsage(request);

    const anterior = this.#reservations.get(taskId);
    this.#reservations.delete(taskId);
    const { remaining } = this.snapshot();

    if (want.usd > remaining.usd || want.tokens > remaining.tokens || want.seconds > remaining.seconds) {
      if (anterior) this.#reservations.set(taskId, anterior);
      throw new HubError(
        'BUDGET_EXCEEDED',
        'A reserva pedida excede o orçamento restante da sessão-raiz',
        { rootId: this.rootId, requested: want, remaining },
      );
    }

    this.#reservations.set(taskId, { pedido: want, gasto: ZERO_USAGE });
    return want;
  }

  /**
   * Fecha a task: o que ela ainda tinha em estimativa aberta vira consumo
   * (turno morto no meio ainda custou), a fatia não gasta volta ao saldo, e
   * `actual` entra como consumo.
   */
  settle(taskId: string, actual: Partial<BudgetUsage>): BudgetSnapshot {
    const aberta = this.#estimates.get(taskId);
    if (aberta) {
      this.#consumed = addUsage(this.#consumed, aberta);
      this.#estimates.delete(taskId);
    }
    this.#reservations.delete(taskId);
    this.#consumed = addUsage(this.#consumed, actual);
    return this.snapshot();
  }

  /**
   * Consumo confirmado (cada evento com custo final).
   *
   * Com `taskId`, o gasto sai da fatia reservada daquela task e a estimativa
   * aberta dela é substituída por este valor — é o "o `result` final é a
   * fonte de verdade do turno".
   */
  charge(actual: Partial<BudgetUsage>, taskId?: string): BudgetSnapshot {
    const valor = sanitizeUsage(actual);
    this.#consumed = addUsage(this.#consumed, valor);
    if (taskId !== undefined) {
      this.#estimates.delete(taskId);
      const fatia = this.#reservations.get(taskId);
      if (fatia) fatia.gasto = addUsage(fatia.gasto, valor);
    }
    return this.snapshot();
  }

  /**
   * Estimativa parcial do turno em andamento de `taskId`: SUBSTITUI a anterior
   * do mesmo escopo, nunca soma. Conta para o teto (o fluxo para no meio de um
   * turno caro), mas desaparece quando o `charge` do valor final chegar.
   */
  estimate(taskId: string, partial: Partial<BudgetUsage>): BudgetSnapshot {
    this.#estimates.set(taskId, sanitizeUsage(partial));
    return this.snapshot();
  }

  release(taskId: string): void {
    this.#reservations.delete(taskId);
  }

  /** Usado quando você aprova aumento de orçamento numa task travada. */
  raiseLimits(delta: Partial<BudgetLimits>): BudgetSnapshot {
    this.#limits = addUsage(this.#limits, delta);
    return this.snapshot();
  }
}

function safeRatio(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? Number.POSITIVE_INFINITY : 0;
  return used / limit;
}
