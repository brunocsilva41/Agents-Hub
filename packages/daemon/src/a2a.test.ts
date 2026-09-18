import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateAgentCard, formatA2aTask } from './a2a.js';
import { A2aCreateTaskSchema } from './http-schemas.js';
import { AgentRegistry } from '@agents-hub/adapters';
import { DEFAULT_POLICY, parseBrief, type Task } from '@agents-hub/core';
import type { HubConfig } from './config.js';

describe('A2A Protocol & Agent Card', () => {
  const dummyConfig: HubConfig = {
    home: '/home',
    dbFile: '/home/hub.sqlite',
    worktreeRoot: '/home/worktrees',
    artifactRoot: '/artifacts',
    logDir: '/home/logs',
    manifestsDir: '/manifests',
    host: '127.0.0.1',
    port: 4747,
    webRoot: '/web',
    retention: { worktreeDays: 7, sweepIntervalMinutes: 60 },
    opencodePort: 4096,
    policy: DEFAULT_POLICY,
    codexGate: { bypassHookTrust: false },
  };

  test('generateAgentCard produz Agent Card compatível com A2A v1.0', () => {
    const registry = new AgentRegistry();
    const card = generateAgentCard(dummyConfig, registry, 'http://127.0.0.1:4747');

    assert.equal(card.name, 'Agents-Hub');
    assert.equal(card.protocolVersion, '1.0');
    assert.equal(card.endpoints.tasks, 'http://127.0.0.1:4747/a2a/tasks');
    assert.equal(card.endpoints.taskStatus, 'http://127.0.0.1:4747/a2a/tasks/:id');
    assert.equal(card.endpoints.taskCancel, 'http://127.0.0.1:4747/a2a/tasks/:id/cancel');
    assert.equal(card.endpoints.taskEvents, 'http://127.0.0.1:4747/a2a/tasks/:id/events');
    assert.equal(card.authentication.mode, 'none');
  });

  test('formatA2aTask formata a task no padrão A2A', () => {
    const task: Task = {
      id: 'tsk_123456',
      sessionId: 'ses_123456',
      requesterSessionId: null,
      brief: parseBrief({
        agent: 'claude',
        objective: 'Refatorar módulo de pagamentos',
        acceptanceCriteria: ['Passar nos testes'],
        constraints: ['Não quebrar API'],
        budget: { usd: 1.5 },
        supervision: 'semi',
        isolation: 'worktree',
      }),
      state: 'completed',
      attempts: [],
      result: {
        summary: 'Refatoração concluída',
        artifacts: ['art_1'],
        usage: { usd: 0.1, tokens: 1500, seconds: 10 },
      },
      createdAt: '2026-08-28T00:00:00Z',
      updatedAt: '2026-08-28T00:01:00Z',
    };

    const formatted = formatA2aTask(task, 'completed');
    assert.equal(formatted['id'], 'tsk_123456');
    assert.equal(formatted['state'], 'completed');
    assert.equal(formatted['sessionState'], 'completed');
    assert.equal((formatted['brief'] as any).objective, 'Refatorar módulo de pagamentos');
    assert.equal((formatted['result'] as any).summary, 'Refatoração concluída');
  });

  test('A2aCreateTaskSchema valida payload de criação', () => {
    const valid = A2aCreateTaskSchema.safeParse({
      objective: 'Construir pipeline',
      agent: 'codex',
      acceptanceCriteria: ['100% testes'],
      budget: { usd: 2.0 },
    });
    assert.equal(valid.success, true);

    const semObjetivo = A2aCreateTaskSchema.safeParse({
      agent: 'codex',
    });
    assert.equal(semObjetivo.success, false);
  });
});
