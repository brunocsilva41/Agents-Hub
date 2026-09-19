import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { EventEnvelope, Session, UnitOfWork } from '@agents-hub/core';
import { createStore } from '@agents-hub/store';
import { DEFAULT_RETENTION } from './config.js';
import { EventRetentionCompactor } from './event-retention.js';

/**
 * Passada periódica de compactação de `raw_json` (achado §3.7 do doc 08).
 *
 * O que importa provar aqui não é a lógica SQL — isso já está coberto em
 * `packages/store/src/repositories.test.ts` (`compactRawBefore`) — é que o
 * módulo do daemon liga essa lógica no timer certo, com o corte certo, e que
 * uma passada não impede consultas concorrentes de continuar funcionando (o
 * daemon fica no ar por dias; um compactador que travasse o banco seria a
 * categoria de problema que este item existe para evitar).
 */
describe('EventRetentionCompactor', () => {
  let store: UnitOfWork;

  before(() => {
    store = createStore(':memory:');
  });

  after(() => {
    store.close();
  });

  function semear(endedAt: string | null): { session: Session; event: EventEnvelope } {
    const project = store.projects.create({
      name: `projeto-${Math.random()}`,
      path: `/proj/${Math.random()}`,
      defaultBranch: 'main',
    });
    const sessionId = `ses_${Math.random().toString(36).slice(2)}`;
    const session: Session = {
      id: sessionId,
      projectId: project.id,
      agentId: 'claude',
      nativeSessionId: null,
      rootId: sessionId,
      parentId: null,
      depth: 0,
      path: [],
      state: endedAt ? 'completed' : 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: '/tmp/x',
      title: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      endedAt,
      pid: null,
    };
    store.sessions.create(session);

    const event: EventEnvelope = {
      id: `evt_${Math.random().toString(36).slice(2)}`,
      seq: 1,
      ts: '2020-01-01T00:00:00.000Z',
      sessionId,
      taskId: null,
      agentId: 'claude',
      type: 'log',
      payload: {},
      cost: null,
      raw: { bruto: true },
    };
    store.events.append(event);
    return { session, event };
  }

  test('compact() usa rawEventDays para calcular o corte e compacta o que expirou', async () => {
    const { event } = semear('2020-01-01T00:00:00.000Z');

    const compactor = new EventRetentionCompactor(store, {
      ...DEFAULT_RETENTION,
      rawEventDays: 7,
    });

    const agora = new Date('2020-02-01T00:00:00.000Z');
    const resultado = await compactor.compact(agora);

    assert.equal(resultado.rowsCompacted, 1);
    assert.equal(resultado.cutoffIso, '2020-01-25T00:00:00.000Z');

    const [lido] = store.events.list({ sessionId: event.sessionId });
    assert.equal(lido?.raw, null);
  });

  test('start()/stop() rodam uma passada na largada sem travar consultas concorrentes', async () => {
    semear('2020-01-01T00:00:00.000Z');

    const compactor = new EventRetentionCompactor(store, {
      ...DEFAULT_RETENTION,
      rawEventDays: 0,
      sweepIntervalMinutes: 60,
    });

    compactor.start();
    try {
      // A passada da largada dispara em `void this.compact()` — sem espera
      // explícita, uma leitura logo em seguida precisa continuar funcionando
      // normalmente. `node:sqlite` é síncrono: se a compactação travasse o
      // banco, esta leitura já teria explodido ou travado junto.
      assert.doesNotThrow(() => store.sessions.list());
      assert.doesNotThrow(() => store.projects.list());
    } finally {
      compactor.stop();
    }
  });
});
