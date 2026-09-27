import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskAttempt } from './domain.js';
import { isHubError } from './errors.js';
import { buildGraph, checkDelegation, pathKey } from './graph.js';
import { nextStep } from './resilience.js';

/** Vistoria 2026-09-25, R09-19: resiliência e CallGraph. */

const tentativa = (n: number, agentId: string): TaskAttempt => ({
  n,
  agentId,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:30:00.000Z',
  outcome: 'error',
  error: 'timeout',
});
const config = { maxRetries: 3, backoffMs: 10, fallbackChain: ['claude', 'codex'] };

describe('R09-19: timeout da tarefa ganha no máximo uma nova tentativa', () => {
  test('primeiro timeout: repete no mesmo agente', () => {
    const step = nextStep(
      { attempts: [tentativa(1, 'claude')], currentAgentId: 'claude' },
      'transient',
      config,
      { reason: 'timeout' },
    );
    assert.equal(step.kind, 'retry');
  });

  test('segundo timeout no mesmo agente: vai para o fallback, não repete de novo', () => {
    const step = nextStep(
      { attempts: [tentativa(1, 'claude'), tentativa(2, 'claude')], currentAgentId: 'claude' },
      'transient',
      config,
      { reason: 'timeout' },
    );
    assert.deepEqual([step.kind, step.kind === 'fallback' ? step.agentId : null], ['fallback', 'codex']);
  });

  test('heartbeat (run muda) continua com o teto normal de retries', () => {
    const step = nextStep(
      { attempts: [tentativa(1, 'claude'), tentativa(2, 'claude')], currentAgentId: 'claude' },
      'transient',
      config,
      { reason: 'heartbeat' },
    );
    assert.equal(step.kind, 'retry');
  });

  test('retries.max 0 continua valendo para timeout', () => {
    const step = nextStep(
      { attempts: [tentativa(1, 'claude')], currentAgentId: 'claude' },
      'transient',
      { ...config, maxRetries: 0 },
      { reason: 'timeout' },
    );
    assert.equal(step.kind, 'fallback');
  });
});

describe('R09-19: ciclo semântico ignora pontuação final', () => {
  test('"Fix the bug." e "fix the bug" são o mesmo objetivo', () => {
    assert.equal(pathKey('claude', 'Fix the bug.'), pathKey('claude', 'fix the bug'));
    assert.equal(pathKey('claude', 'Corrija o teste!!  '), pathKey('claude', 'corrija o teste'));
    assert.throws(
      () =>
        checkDelegation({
          parentPath: [pathKey('claude', 'Fix the bug')],
          parentDepth: 1,
          maxDepth: 5,
          target: { agentId: 'claude', objective: 'Fix the bug.' },
        }),
      (err: unknown) => isHubError(err) && err.code === 'CYCLE_DETECTED',
    );
  });

  test('pontuação interna ainda distingue (chaves gravadas não mudam)', () => {
    assert.notEqual(pathKey('claude', 'a.b'), pathKey('claude', 'ab'));
  });
});

describe('R09-19: ciclo de parent_id não some com os nós', () => {
  const no = (sessionId: string, parentId: string | null, startedAt: string) => ({
    sessionId,
    parentId,
    agentId: 'claude',
    title: null,
    state: 'completed',
    depth: 0,
    usd: 0,
    tokens: 0,
    startedAt,
    endedAt: null,
  });

  test('A→B→A: o mais antigo vira raiz e o outro fica como filho', () => {
    const roots = buildGraph([no('ses_a', 'ses_b', '2026-01-01'), no('ses_b', 'ses_a', '2026-01-02')]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.sessionId, 'ses_a');
    assert.deepEqual(roots[0]?.children.map((c) => c.sessionId), ['ses_b']);
    assert.deepEqual(roots[0]?.children[0]?.children, []);
  });

  test('ciclo ao lado de árvore sã: nada se perde', () => {
    const roots = buildGraph([
      no('ses_r', null, '2026-01-01'),
      no('ses_f', 'ses_r', '2026-01-02'),
      no('ses_x', 'ses_y', '2026-01-03'),
      no('ses_y', 'ses_x', '2026-01-04'),
    ]);
    const ids = new Set<string>();
    const visita = (ns: typeof roots): void => {
      for (const n of ns) {
        ids.add(n.sessionId);
        visita(n.children);
      }
    };
    visita(roots);
    assert.equal(ids.size, 4);
  });
});
