import type { EventEnvelope, Session, UnitOfWork } from '@agents-hub/core';

/**
 * Marca do evento que fecha a conta de um turno sem custo final do agente
 * (Copilot sempre; qualquer agente morto no meio do turno). Leva o acumulado
 * da sessão nativa, que vira a base do turno seguinte.
 */
export const CUSTO_FECHADO = 'custo.turno.fechado';

/**
 * Base do custo ACUMULADO da sessão nativa (Copilot: créditos da sessão
 * inteira, inclusive turnos anteriores retomados com `--resume`).
 *
 * Sessão nativa nova (sem id) começa do zero. Retomada: o último fechamento
 * de turno gravado por este Hub para o mesmo agente. Sem nenhum registro, a
 * base é zero — o turno sai cobrado pelo acumulado inteiro, para MAIS, que é
 * o lado seguro para um teto de gasto.
 */
export function baseDoAcumulado(
  store: UnitOfWork,
  session: Session,
): { usd: number; credits: number } {
  if (!session.nativeSessionId) return { usd: 0, credits: 0 };
  const recentes = store.events.list({
    sessionId: session.id,
    types: ['log'],
    tail: true,
    limit: 500,
  });
  for (let i = recentes.length - 1; i >= 0; i -= 1) {
    const evento = recentes[i] as EventEnvelope;
    const p = evento.payload;
    if (p['kind'] !== CUSTO_FECHADO || evento.agentId !== session.agentId) continue;
    const usd = p['cumulativeUsd'];
    const credits = p['cumulativeCredits'];
    if (typeof usd !== 'number' || !Number.isFinite(usd)) continue;
    return {
      usd,
      credits: typeof credits === 'number' && Number.isFinite(credits) ? credits : 0,
    };
  }
  return { usd: 0, credits: 0 };
}
