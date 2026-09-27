import { nowIso } from './ids.js';
import type { TaskAttempt } from './domain.js';

/**
 * Decisão de resiliência (ADR 04.3 e 06.2), em forma pura.
 *
 * Fica separada do `SessionManager` de propósito: "quantas vezes tentar, com
 * quem, e quando desistir" é a lógica que mais precisa de teste e a que menos
 * precisa de processo rodando. Aqui ela é uma função de estado → decisão.
 */

/**
 * `quota`: a CONTA do agente esgotou o limite de uso/créditos ("You've hit
 * your usage limit", "insufficient credits"). Não passa em segundos: repetir
 * com o mesmo agente só queima tempo. `rate_limited`: limite de TAXA (429,
 * "rate limit") — passa sozinho, vale nova tentativa com backoff.
 */
export type OutcomeClass = 'success' | 'transient' | 'rate_limited' | 'quota' | 'permanent' | 'canceled';

export interface RunOutcomeLike {
  /**
   * `interrupted`: alguém pediu para parar o TURNO, não a sessão (interrupt/
   * pause). Não é falha nem motivo de retry.
   */
  reason: 'exit' | 'timeout' | 'heartbeat' | 'canceled' | 'interrupted' | 'error';
  exitCode: number | null;
  error: string | null;
}

/**
 * Falhas que valem uma nova tentativa com o MESMO agente.
 *
 * Repetir um erro determinístico (prompt inválido, binário sem auth, comando
 * inexistente) só queima orçamento — a lista é intencionalmente curta e
 * conservadora: na dúvida, tratamos como permanente e passamos ao fallback,
 * que ao menos muda alguma variável.
 */
/**
 * Cota/limite de uso da conta. Vem ANTES do limite de taxa: "usage limit" não
 * é "rate limit", e tratá-lo como falha permanente genérica (teste real de
 * 2026-09-26, Codex) escondia do usuário por que a tarefa trocou de agente.
 */
const QUOTA_PATTERNS: RegExp[] = [
  /usage limit/i,
  /\bquota\b/i,
  /insufficient[_ ]quota/i,
  /insufficient[_ ](credits?|balance|funds)/i,
  /credit balance is too low/i,
  /out of credits/i,
  /limite de uso/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [/rate.?limit/i, /\b429\b/, /too many requests/i];

const TRANSIENT_PATTERNS: RegExp[] = [
  /\b50[234]\b/,
  /overloaded/i,
  /temporarily unavailable/i,
  /timed? ?out/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang ?up/i,
  /connection (reset|closed|refused)/i,
  /stream (interrupted|closed)/i,
  /wedged/i,
];

export function classifyOutcome(outcome: RunOutcomeLike): OutcomeClass {
  // Interrupção é pedido de alguém, como o cancelamento: insistir seria
  // desobedecer. Sem esta linha, `exitCode: null` caía em "sucesso".
  if (outcome.reason === 'canceled' || outcome.reason === 'interrupted') return 'canceled';

  // Run travada: nenhum evento por tempo demais, ou estouro do teto de duração.
  // Quase sempre é infraestrutura, não a tarefa — vale tentar de novo.
  if (outcome.reason === 'timeout' || outcome.reason === 'heartbeat') return 'transient';

  const failed = outcome.reason === 'error' || (outcome.exitCode ?? 0) !== 0;
  if (!failed) return 'success';

  const text = outcome.error ?? '';
  if (QUOTA_PATTERNS.some((re) => re.test(text))) return 'quota';
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) return 'rate_limited';
  return TRANSIENT_PATTERNS.some((re) => re.test(text)) ? 'transient' : 'permanent';
}

export interface ResilienceConfig {
  /** Tentativas ADICIONAIS com o mesmo agente antes de trocar. */
  maxRetries: number;
  backoffMs: number;
  /** Agentes candidatos, em ordem, para assumir quando o atual desiste. */
  fallbackChain: string[];
}

export interface ResilienceState {
  attempts: TaskAttempt[];
  currentAgentId: string;
}

export type ResilienceStep =
  | { kind: 'retry'; agentId: string; attempt: number; backoffMs: number; reason: string }
  | { kind: 'fallback'; agentId: string; attempt: number; reason: string }
  | { kind: 'give_up'; reason: string };

/**
 * O que fazer depois de uma tentativa falhar.
 *
 * A ordem é retry → fallback → desistir, e cada degrau só é usado quando o
 * anterior se esgotou. Desistir NÃO deixa a task pendurada esperando humano
 * (ADR 06.1): ela morre em `failed` com o contexto preservado.
 */
export function nextStep(
  state: ResilienceState,
  outcome: OutcomeClass,
  config: ResilienceConfig,
  /**
   * Por que a run acabou. `timeout` é o estouro de `taskTimeoutSeconds` (30
   * min por padrão): repetir `retries.max` vezes no mesmo agente eram até 3
   * execuções de 30 min seguidas (R09-19). Timeout ganha no máximo UMA nova
   * tentativa com o mesmo agente; depois vai para o fallback. `heartbeat`
   * (run muda) continua com o teto normal — é o caso típico de infraestrutura.
   */
  origem?: { reason?: RunOutcomeLike['reason'] },
): ResilienceStep {
  if (outcome === 'success') {
    return { kind: 'give_up', reason: 'a tentativa foi bem-sucedida; nada a decidir' };
  }

  if (outcome === 'canceled') {
    // Cancelamento é decisão de alguém — insistir seria desobedecer.
    return { kind: 'give_up', reason: 'execução cancelada' };
  }

  const attemptsHere = state.attempts.filter((a) => a.agentId === state.currentAgentId).length;
  const nextAttempt = state.attempts.length + 1;

  const tetoDeRetries =
    origem?.reason === 'timeout' ? Math.min(config.maxRetries, 1) : config.maxRetries;

  // Limite de taxa passa sozinho: mesma regra do transitório (backoff
  // exponencial). Cota NÃO: esperar segundos não devolve o limite da conta.
  const repetivel = outcome === 'transient' || outcome === 'rate_limited';
  if (repetivel && attemptsHere <= tetoDeRetries) {
    return {
      kind: 'retry',
      agentId: state.currentAgentId,
      attempt: nextAttempt,
      // Exponencial a partir da segunda tentativa deste agente.
      backoffMs: config.backoffMs * 2 ** Math.max(0, attemptsHere - 1),
      reason:
        outcome === 'rate_limited'
          ? `limite de taxa em ${state.currentAgentId} (tentativa ${attemptsHere} deste agente)`
          : attemptsHere === 1
            ? 'falha transitória na primeira tentativa'
            : `falha transitória (tentativa ${attemptsHere} deste agente)`,
    };
  }

  const tried = new Set(state.attempts.map((a) => a.agentId));
  const next = config.fallbackChain.find((id) => !tried.has(id));

  if (next) {
    return {
      kind: 'fallback',
      agentId: next,
      attempt: nextAttempt,
      reason:
        outcome === 'quota'
          ? `cota/limite de uso da conta de ${state.currentAgentId} esgotado`
          : outcome === 'permanent'
            ? `falha permanente em ${state.currentAgentId}`
            : `${state.currentAgentId} esgotou as tentativas`,
    };
  }

  return {
    kind: 'give_up',
    reason: `todos os agentes da cadeia falharam (${[...tried].join(' → ')})`,
  };
}

/**
 * Resumo das falhas para anexar ao brief do próximo agente.
 *
 * Sem isto o fallback recomeça cego e tende a repetir o mesmo erro — que é
 * justamente o desperdício que a cadeia deveria evitar.
 */
export function failureContext(attempts: TaskAttempt[]): string {
  const failures = attempts.filter((a) => a.outcome !== null && a.outcome !== 'success');
  if (failures.length === 0) return '';

  const lines = [
    '## Tentativas anteriores desta tarefa',
    '',
    'Outro agente já tentou isto e falhou. Leia antes de repetir o mesmo caminho:',
    '',
  ];

  for (const attempt of failures) {
    lines.push(
      `- tentativa ${attempt.n} (${attempt.agentId}): ${attempt.outcome} — ${
        attempt.error ?? 'sem detalhe'
      }`,
    );
  }

  return lines.join('\n');
}

/** Portões de validação aplicados ao resultado antes de aceitá-lo. */
export type ValidationCheck =
  { name: string; kind: 'command'; command: string } | { name: string; kind: 'review'; agent: string };

export interface ValidationOutcome {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

export function validationPassed(outcome: ValidationOutcome | null): boolean {
  return outcome === null || outcome.passed;
}

/**
 * Fecha a última tentativa registrada com o desfecho observado.
 *
 * Extraído de `session-manager.ts` (dívida arquitetural do arquivo grande) —
 * mora ao lado de `failureContext`/`ResilienceStep`, mesma lógica de
 * `TaskAttempt` que o retry/fallback já trata aqui.
 */
export function closeLastAttempt(
  attempts: TaskAttempt[],
  outcome: OutcomeClass | 'invalid',
  error: string | null,
): TaskAttempt[] {
  if (attempts.length === 0) return attempts;

  const mapped: TaskAttempt['outcome'] =
    outcome === 'success'
      ? 'success'
      : outcome === 'invalid'
        ? 'invalid'
        : outcome === 'canceled'
          ? null
          : 'error';

  return attempts.map((a, i, arr) =>
    i === arr.length - 1 ? { ...a, endedAt: nowIso(), outcome: mapped, error } : a,
  );
}

/** Abre uma nova tentativa (`n`-ésima) para o agente indicado. */
export function novaTentativa(n: number, agentId: string): TaskAttempt {
  return { n, agentId, startedAt: nowIso(), endedAt: null, outcome: null, error: null };
}

/** Espera `ms` milissegundos — usado no backoff de retry. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
