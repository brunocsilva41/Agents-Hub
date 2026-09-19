import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateApiDescriptor, formatTaskResponse } from './api-tasks.js';
import { CreateTaskSchema } from './http-schemas.js';
import { AgentRegistry } from '@agents-hub/adapters';
import { DEFAULT_POLICY, parseBrief, type Task } from '@agents-hub/core';
import type { HubConfig } from './config.js';

describe('API REST de tasks (/api/tasks) — automação externa', () => {
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
    retention: { worktreeDays: 7, sweepIntervalMinutes: 60, rawEventDays: 7 },
    opencodePort: 4096,
    policy: DEFAULT_POLICY,
    codexGate: { bypassHookTrust: false },
  };

  test('generateApiDescriptor descreve a API REST, sem alegar compatibilidade A2A', () => {
    const registry = new AgentRegistry();
    const descriptor = generateApiDescriptor(dummyConfig, registry, 'http://127.0.0.1:4747');

    assert.equal(descriptor.name, 'Agents-Hub');
    assert.equal(descriptor.apiVersion, '1.0');
    assert.equal(descriptor.endpoints.tasks, 'http://127.0.0.1:4747/api/tasks');
    assert.equal(descriptor.endpoints.taskStatus, 'http://127.0.0.1:4747/api/tasks/:id');
    assert.equal(descriptor.endpoints.taskCancel, 'http://127.0.0.1:4747/api/tasks/:id/cancel');
    assert.equal(descriptor.endpoints.taskEvents, 'http://127.0.0.1:4747/api/tasks/:id/events');
    assert.equal(descriptor.authentication.mode, 'none');
  });

  test('formatTaskResponse formata a task para a resposta HTTP', () => {
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

    const formatted = formatTaskResponse(task, 'completed');
    assert.equal(formatted['id'], 'tsk_123456');
    assert.equal(formatted['state'], 'completed');
    assert.equal(formatted['sessionState'], 'completed');
    assert.equal((formatted['brief'] as any).objective, 'Refatorar módulo de pagamentos');
    assert.equal((formatted['result'] as any).summary, 'Refatoração concluída');
  });

  test('CreateTaskSchema valida payload de criação', () => {
    const valid = CreateTaskSchema.safeParse({
      objective: 'Construir pipeline',
      agent: 'codex',
      acceptanceCriteria: ['100% testes'],
      budget: { usd: 2.0 },
    });
    assert.equal(valid.success, true);

    const semObjetivo = CreateTaskSchema.safeParse({
      agent: 'codex',
    });
    assert.equal(semObjetivo.success, false);
  });
});
