import type { BudgetUsage } from './budget.js';
import type { EventCost } from './events.js';

/**
 * Contabilidade de custo de UM turno (uma run de adapter).
 *
 * A regra: o custo final que o agente informa no fim do turno é a fonte de
 * verdade; o que chega antes dele é estimativa parcial, que atualiza o número
 * mostrado sem somar. Sem isto o Hub contava o Claude duas ou três vezes —
 * cada linha `assistant` repete o `usage` completo da mesma mensagem, e o
 * `result` ainda traz o total — e o teto de US$ 0,10 estourava num turno de
 * uma palavra (vistoria 2026-09-25, relatórios 10 e 11).
 *
 * - custo sem `provisional` ⇒ `final`: é cobrado como veio e zera as parciais.
 * - `provisional` com `partId` ⇒ substitui a parcial de mesmo id (mesma
 *   mensagem repetida em várias linhas) e soma com as de id diferente.
 * - `provisional` + `cumulative` ⇒ `usd` é o acumulado da sessão nativa
 *   (Copilot); o incremento do turno é `acumulado - base`.
 *
 * Quando o turno termina sem custo final (Copilot nunca manda um; processo
 * morto no meio), `flush()` devolve a estimativa para ser cobrada — custo de
 * turno interrompido não pode sumir.
 */
export type PassoDeCusto =
  /** Cobrar `cost` (substitui a estimativa aberta do turno). */
  | { kind: 'final'; cost: EventCost }
  /** Estimativa corrente do turno inteiro (substitui a anterior). */
  | { kind: 'estimate'; total: EventCost };

export class TurnCostTracker {
  readonly #partes = new Map<string, EventCost>();
  #anonimas = 0;
  #base: number;
  #acumulado: number | null = null;
  #creditosAcumulados: number | null = null;
  #baseCreditos: number;

  /**
   * @param base Acumulado (USD e créditos) da sessão nativa já cobrado em
   * turnos anteriores — só importa para custo `cumulative`.
   */
  constructor(base: { usd?: number; credits?: number } = {}) {
    this.#base = finito(base.usd);
    this.#baseCreditos = finito(base.credits);
  }

  observe(cost: EventCost): PassoDeCusto {
    if (cost.provisional !== true) {
      this.#fechar();
      return { kind: 'final', cost: semMarcas(cost) };
    }

    if (cost.cumulative === true) {
      // Acumulado só cresce; um valor menor fora de ordem não desconta nada.
      this.#acumulado = Math.max(this.#acumulado ?? 0, finito(cost.usd));
      if (cost.credits !== undefined) {
        this.#creditosAcumulados = Math.max(this.#creditosAcumulados ?? 0, finito(cost.credits));
      }
    } else {
      const chave = cost.partId ?? `#${(this.#anonimas += 1)}`;
      this.#partes.set(chave, cost);
    }
    return { kind: 'estimate', total: this.pending() ?? {} };
  }

  /** Estimativa do turno até aqui, ou `null` se nada foi estimado. */
  pending(): EventCost | null {
    if (this.#partes.size === 0 && this.#acumulado === null) return null;

    const total: EventCost = {};
    let usdPartes = 0;
    let temUsd = false;
    for (const parte of this.#partes.values()) {
      somar(total, 'inputTokens', parte.inputTokens);
      somar(total, 'outputTokens', parte.outputTokens);
      somar(total, 'cachedTokens', parte.cachedTokens);
      somar(total, 'cacheWriteTokens', parte.cacheWriteTokens);
      if (typeof parte.usd === 'number' && Number.isFinite(parte.usd)) {
        usdPartes += Math.max(0, parte.usd);
        temUsd = true;
      }
    }

    // O acumulado informado pelo agente (créditos convertidos) é medida; a
    // soma das parciais por token é estimativa — quando os dois existem, o
    // primeiro manda.
    if (this.#acumulado !== null) {
      total.usd = Math.max(0, this.#acumulado - this.#base);
      if (this.#creditosAcumulados !== null) {
        total.credits = Math.max(0, this.#creditosAcumulados - this.#baseCreditos);
      }
    } else if (temUsd) {
      total.usd = usdPartes;
    }
    return total;
  }

  /** Fecha o turno sem custo final: devolve a estimativa a cobrar (ou `null`). */
  flush(): EventCost | null {
    const aberto = this.pending();
    this.#fechar();
    return aberto;
  }

  /** Acumulado da sessão nativa visto por último (para a base do próximo turno). */
  get cumulativeUsd(): number | null {
    return this.#acumulado;
  }

  get cumulativeCredits(): number | null {
    return this.#creditosAcumulados;
  }

  #fechar(): void {
    this.#partes.clear();
    if (this.#acumulado !== null) this.#base = this.#acumulado;
    if (this.#creditosAcumulados !== null) this.#baseCreditos = this.#creditosAcumulados;
    this.#acumulado = null;
    this.#creditosAcumulados = null;
  }
}

/** Uso que o orçamento enxerga: dólares e tokens de entrada + saída. */
export function usoDoCusto(cost: EventCost): Partial<BudgetUsage> {
  return {
    usd: cost.usd ?? 0,
    tokens: (cost.inputTokens ?? 0) + (cost.outputTokens ?? 0),
    seconds: 0,
  };
}

function finito(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function somar(
  alvo: EventCost,
  campo: 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens',
  valor: number | undefined,
): void {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) return;
  alvo[campo] = (alvo[campo] ?? 0) + valor;
}

function semMarcas(cost: EventCost): EventCost {
  const { provisional: _p, partId: _i, cumulative: _c, ...resto } = cost;
  return resto;
}
