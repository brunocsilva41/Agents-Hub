import { createHash, randomUUID } from 'node:crypto';

/**
 * Ids com prefixo legível. Ao ler um log ou um grafo de chamadas, saber que
 * `ses_...` é sessão e `tsk_...` é task economiza muito tempo de depuração.
 */
export type IdPrefix = 'prj' | 'pfd' | 'ses' | 'tsk' | 'evt' | 'apv' | 'art' | 'run';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/**
 * Hash estável do objetivo de um Brief. Usado pelo CallGraph para detectar
 * ciclo *semântico* (A pede a mesma coisa de volta para quem já pediu),
 * e não apenas ciclo de identidade de agente.
 */
export function objectiveHash(objective: string): string {
  const normalized = objective.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}
