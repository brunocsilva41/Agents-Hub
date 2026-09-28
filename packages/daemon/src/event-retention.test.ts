import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { EventEnvelope, Session, UnitOfWork } from '@agents-hub/core';
import { createStore } from '@agents-hub/store';
import { DEFAULT_RETENTION } from './config.js';
import {
  CONVERSAO_AUTOMATICA_MAX_BYTES,
  converterBancoAntigo,
  decidirConversao,
  EventRetentionCompactor,
} from './event-retention.js';

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

  test('compacta em lotes e cede o event loop entre eles; passadas simultâneas não se sobrepõem', async () => {
    for (let i = 0; i < 7; i += 1) semear('2020-01-01T00:00:00.000Z');
    const chamadas: Array<number | undefined> = [];
    const espiao = {
      // O compactador só usa este método.
      events: {
        compactRawBefore: (corte: string, limit?: number) => {
          chamadas.push(limit);
          return store.events.compactRawBefore(corte, limit);
        },
      },
    } as unknown as UnitOfWork;
    const compactor = new EventRetentionCompactor(espiao, { ...DEFAULT_RETENTION, rawEventDays: 0 }, 2);

    // Um `setImmediate` agendado ANTES da passada só roda antes de ela
    // terminar se a passada ceder o event loop entre os lotes.
    let cedeu = false;
    setImmediate(() => {
      cedeu = true;
    });
    const agora = new Date('2020-02-01T00:00:00.000Z');
    const [a, b] = await Promise.all([compactor.compact(agora), compactor.compact(agora)]);

    assert.equal(a, b, 'a segunda chamada recebe a passada em andamento');
    assert.ok(a.rowsCompacted >= 7);
    assert.ok(chamadas.length >= 4, `esperava vários lotes, vieram ${chamadas.length}`);
    assert.ok(
      chamadas.every((l) => l === 2),
      'todo lote tem limite',
    );
    assert.equal(cedeu, true, 'a passada precisa ceder o event loop entre os lotes');
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

describe('decidirConversao (R09-07)', () => {
  const MB = 1024 * 1024;
  const estado = (autoVacuum: 'none' | 'incremental', paginas: number, livres = 0) => ({
    autoVacuum,
    pageSize: 4096,
    pageCount: paginas,
    freelistCount: livres,
  });

  test('banco já incremental não é convertido', () => {
    assert.deepEqual(decidirConversao(estado('incremental', 10)), {
      converter: false,
      motivo: 'ja-incremental',
      bytesVivos: 10 * 4096,
    });
  });

  test('banco antigo pequeno converte; o teto conta só o dado vivo, não as páginas livres', () => {
    // 100 MB de arquivo, 90 MB livres: o VACUUM copia os 10 MB vivos.
    const d = decidirConversao(estado('none', (100 * MB) / 4096, (90 * MB) / 4096), 64 * MB);
    assert.deepEqual(d, { converter: true, bytesVivos: 10 * MB });
  });

  test('banco antigo acima do teto não converte na subida', () => {
    const d = decidirConversao(estado('none', (65 * MB) / 4096), 64 * MB);
    assert.deepEqual(d, { converter: false, motivo: 'grande-demais', bytesVivos: 65 * MB });
    assert.equal(CONVERSAO_AUTOMATICA_MAX_BYTES, 64 * MB);
  });
});

describe('converterBancoAntigo (R09-07)', () => {
  test('acima do teto não chama o VACUUM', () => {
    let vacuos = 0;
    const r = converterBancoAntigo(
      {
        estado: () => ({ autoVacuum: 'none', pageSize: 4096, pageCount: 1000, freelistCount: 0 }),
        converterParaIncremental: () => {
          vacuos += 1;
        },
      },
      1000,
    );
    assert.equal(r.converter, false);
    assert.equal(vacuos, 0);
  });

  test('banco novo já nasce incremental: a subida não paga VACUUM nenhum', () => {
    const store = createStore(':memory:');
    try {
      assert.equal(store.espaco.estado().autoVacuum, 'incremental');
      const r = converterBancoAntigo(store.espaco);
      assert.equal(r.converter, false);
      assert.equal(r.ms, 0);
    } finally {
      store.close();
    }
  });
});
