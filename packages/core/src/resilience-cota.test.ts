import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyOutcome, nextStep } from './resilience.js';
import type { TaskAttempt } from './domain.js';

/**
 * Cota x limite de taxa (teste real de 2026-09-26): "You've hit your usage
 * limit" era tratado como falha permanente genérica. Cota da conta não volta
 * em segundos — sem retry no mesmo agente; limite de taxa volta — retry.
 */

const falha = (error: string) => ({ reason: 'exit' as const, exitCode: 1, error });

test('classificação: cota, créditos e limite de taxa', () => {
  assert.equal(
    classifyOutcome(falha("processo terminou com código 1: You've hit your usage limit")),
    'quota',
  );
  assert.equal(classifyOutcome(falha('insufficient credits')), 'quota');
  assert.equal(classifyOutcome(falha('Error: insufficient_quota')), 'quota');
  assert.equal(classifyOutcome(falha('API error 429: rate limit exceeded')), 'rate_limited');
  assert.equal(classifyOutcome(falha('segfault')), 'permanent');
});

test('cota não repete o mesmo agente e passa ao fallback dizendo o motivo; taxa repete', () => {
  const attempts: TaskAttempt[] = [
    { n: 1, agentId: 'codex', startedAt: '', endedAt: '', outcome: 'error', error: 'usage limit' },
  ];
  const cfg = { maxRetries: 2, backoffMs: 10, fallbackChain: ['codex', 'claude'] };
  const cota = nextStep({ attempts, currentAgentId: 'codex' }, 'quota', cfg);
  assert.equal(cota.kind, 'fallback');
  assert.match(cota.reason, /cota/);
  assert.equal(nextStep({ attempts, currentAgentId: 'codex' }, 'rate_limited', cfg).kind, 'retry');
});
