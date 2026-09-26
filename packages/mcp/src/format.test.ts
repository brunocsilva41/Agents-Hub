import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope } from '@agents-hub/core';
import type { TaskStatus } from '@agents-hub/client';
import { formatEvents, formatTaskStatus } from './format.js';

const orcamento = {
  limits: { usd: 1, tokens: 1000, seconds: 100 },
  consumed: { usd: 0.1, tokens: 10, seconds: 1 },
  reserved: { usd: 0, tokens: 0, seconds: 0 },
  remaining: { usd: 0.9, tokens: 990, seconds: 99 },
  pressure: 0.1,
  exhausted: false,
};

function status(agenteAtual: string, tentativas: Array<[string, string | null]>): TaskStatus {
  return {
    task: {
      id: 'tsk_1',
      sessionId: 'ses_atual',
      requesterSessionId: 'ses_pai',
      state: 'working',
      brief: { agent: 'claude', objective: 'objetivo de teste', acceptanceCriteria: [] },
      attempts: tentativas.map(([agentId, error], i) => ({
        n: i + 1,
        agentId,
        outcome: error ? 'error' : null,
        error,
      })),
      result: null,
      createdAt: '',
      updatedAt: '',
    },
    session: {
      id: 'ses_atual',
      projectId: 'prj_1',
      agentId: agenteAtual,
      nativeSessionId: null,
      rootId: 'ses_pai',
      parentId: 'ses_pai',
      depth: 1,
      state: 'running',
      mode: 'semi',
      isolation: 'worktree',
      title: null,
      workdir: '/tmp/x',
      createdAt: '',
      updatedAt: '',
      endedAt: null,
    },
    live: true,
    budget: orcamento,
  } as TaskStatus;
}

/**
 * Vistoria 08, achado 11: um objetivo gigante foi recusado pelo Claude
 * ("Prompt is too long"), o Hub repassou a codex e depois a opencode, e o
 * chamador só via "delegado para claude". O status precisa dizer quem executa
 * e por onde a tarefa passou.
 */
describe('formatTaskStatus: troca de agente visível', () => {
  test('failover em cascata aparece com a cadeia e o agente atual', () => {
    const texto = formatTaskStatus(
      status('opencode', [
        ['claude', 'Prompt is too long (processo terminou com código 1)'],
        ['codex', 'processo terminou com código 1'],
        ['opencode', null],
      ]),
    );
    assert.match(texto, /FALLBACK: a tarefa começou em claude e quem executa agora é opencode/);
    assert.match(texto, /claude → codex → opencode/);
    assert.match(texto, /Prompt is too long/);
  });

  test('sem troca, nenhuma linha de fallback', () => {
    const texto = formatTaskStatus(status('claude', [['claude', null]]));
    assert.doesNotMatch(texto, /FALLBACK/);
  });

  test('retry no mesmo agente não é fallback', () => {
    const texto = formatTaskStatus(status('claude', [['claude', 'falhou'], ['claude', null]]));
    assert.doesNotMatch(texto, /FALLBACK/);
  });
});

describe('formatEvents: erro nunca sai vazio (achado 16)', () => {
  const evento = (payload: Record<string, unknown>): EventEnvelope =>
    ({
      seq: 1,
      ts: '2026-09-25T04:00:00.000Z',
      sessionId: 'ses_1',
      taskId: null,
      agentId: 'claude',
      type: 'error',
      payload,
    }) as unknown as EventEnvelope;

  test('usa summary quando não há message (erro do Claude)', () => {
    const texto = formatEvents([evento({ subtype: 'success', summary: 'Prompt is too long' })]);
    assert.match(texto, /ERRO: Prompt is too long/);
  });

  test('usa error do desfecho do processo', () => {
    const texto = formatEvents([evento({ reason: 'exit', error: 'processo terminou com código 1' })]);
    assert.match(texto, /ERRO: processo terminou com código 1/);
  });

  test('sem texto nenhum, diz o motivo em vez de "ERRO: " vazio', () => {
    const texto = formatEvents([evento({ reason: 'timeout' })]);
    assert.doesNotMatch(texto, /ERRO: $/m);
    assert.match(texto, /ERRO: timeout/);
  });
});
