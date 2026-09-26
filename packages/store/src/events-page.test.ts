import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope, Session } from '@agents-hub/core';
import { createStore } from './index.js';

/**
 * Leitura da timeline "pelo fim".
 *
 * A única leitura que existia era `ORDER BY seq LIMIT n`: numa sessão com mais
 * de 500 eventos o painel recebia os 500 MAIS ANTIGOS e nunca via o fim — nem o
 * que o agente acabou de fazer. `newest` escolhe os mais recentes e `beforeSeq`
 * pagina para trás; a ordem devolvida continua crescente nos dois casos.
 */
describe('eventos: página pelo fim e para trás', () => {
  function semear(total: number): { store: ReturnType<typeof createStore>; sessionId: string } {
    const store = createStore(':memory:');
    const project = store.projects.create({ name: 'p', path: '/proj/pagina', defaultBranch: 'main' });
    const sessionId = 'ses_pagina';
    const session: Session = {
      id: sessionId,
      projectId: project.id,
      agentId: 'claude',
      nativeSessionId: null,
      rootId: sessionId,
      parentId: null,
      depth: 0,
      path: [],
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: '/tmp/x',
      title: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      endedAt: null,
      pid: null,
    };
    store.sessions.create(session);
    for (let seq = 1; seq <= total; seq += 1) {
      const event: EventEnvelope = {
        id: `evt_${seq}`,
        seq,
        ts: '2020-01-01T00:00:00.000Z',
        sessionId,
        taskId: null,
        agentId: 'claude',
        type: 'log',
        payload: { n: seq },
        cost: null,
        raw: null,
      };
      store.events.append(event);
    }
    return { store, sessionId };
  }

  test('newest devolve os N mais RECENTES, em ordem crescente', () => {
    const { store, sessionId } = semear(30);
    const lidos = store.events.list({ sessionId, newest: true, limit: 10 });
    assert.deepEqual(
      lidos.map((e) => e.seq),
      [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    );
  });

  test('beforeSeq pagina para trás a partir do mais antigo já carregado', () => {
    const { store, sessionId } = semear(30);
    const pagina = store.events.list({ sessionId, beforeSeq: 21, limit: 10 });
    assert.deepEqual(
      pagina.map((e) => e.seq),
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    );
    const ultima = store.events.list({ sessionId, beforeSeq: 3, limit: 10 });
    assert.deepEqual(ultima.map((e) => e.seq), [1, 2]);
  });

  test('sem newest/beforeSeq o comportamento antigo (do começo) continua', () => {
    const { store, sessionId } = semear(30);
    const lidos = store.events.list({ sessionId, limit: 3 });
    assert.deepEqual(lidos.map((e) => e.seq), [1, 2, 3]);
  });
});
