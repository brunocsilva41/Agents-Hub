import type { TaskAttempt } from './domain.js';

/**
 * Decisão de resiliência (ADR 04.3 e 06.2), em forma pura.
 *
 * Fica separada do `SessionManager` de propósito: "quantas vezes tentar, com
 * quem, e quando desistir" é a lógica que mais precisa de teste e a que menos
 * precisa de processo rodando. Aqui ela é uma função de estado → decisão.
 */

export type OutcomeClass = 'success' | 'transient' | 'permanent' | 'canceled';

export interface RunOutcomeLike {
  reason: 'exit' | 'timeout' | 'heartbeat' | 'canceled' | 'error';
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
const TRANSIENT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
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
  if (outcome.reason === 'canceled') return 'canceled';

  // Run travada: nenhum evento por tempo demais, ou estouro do teto de duração.
  // Quase sempre é infraestrutura, não a tarefa — vale tentar de novo.
  if (outcome.reason === 'timeout' || outcome.reason === 'heartbeat') return 'transient';

  const failed = outcome.reason === 'error' || (outcome.exitCode ?? 0) !== 0;
  if (!failed) return 'success';

  const text = outcome.error ?? '';
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

  if (outcome === 'transient' && attemptsHere <= config.maxRetries) {
    return {
      kind: 'retry',
      agentId: state.currentAgentId,
      attempt: nextAttempt,
      // Exponencial a partir da segunda tentativa deste agente.
      backoffMs: config.backoffMs * 2 ** Math.max(0, attemptsHere - 1),
      reason:
        attemptsHere === 1
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
        outcome === 'permanent'
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
  | { name: string; kind: 'command'; command: string }
  | { name: string; kind: 'review'; agent: string };

export interface ValidationOutcome {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

export function validationPassed(outcome: ValidationOutcome | null): boolean {
  return outcome === null || outcome.passed;
}
