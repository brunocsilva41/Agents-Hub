import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Session, Task } from '@agents-hub/core';
import { migrate, openDatabase, SqliteUnitOfWork, type Db } from './index.js';
import { MIGRATIONS } from './migrations.js';

/**
 * Vistoria 2026-09-25 (09-store-core): R09-08 (agregados), R09-16
 * (`transaction()`), R09-17 (lacunas de schema).
 */

function sessao(id: string, projectId: string, rootId = id, parentId: string | null = null): Session {
  return {
    id,
    projectId,
    agentId: 'claude',
    nativeSessionId: null,
    rootId,
    parentId,
    depth: parentId ? 1 : 0,
    path: [],
    state: 'completed',
    mode: 'semi',
    isolation: 'none',
    workdir: '/tmp/x',
    title: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    endedAt: null,
    pid: null,
  };
}

function task(id: string, sessionId: string): Task {
  return {
    id,
    sessionId,
    requesterSessionId: null,
    brief: {} as Task['brief'],
    state: 'working',
    attempts: [],
    result: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  };
}

function base(): { db: Db; store: SqliteUnitOfWork; projectId: string } {
  const db = openDatabase(':memory:');
  const store = new SqliteUnitOfWork(db);
  const p = store.projects.create({ name: 'p', path: `/p/${Math.random()}`, defaultBranch: 'main' });
  return { db, store, projectId: p.id };
}

const plano = (db: Db, sql: string, ...params: Array<string | number>): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(' | ');

describe('R09-08: somas de custo e listagens por tipo escalam com o que importa', () => {
  test('somas vêm das colunas geradas, com a mesma regra de provisório', () => {
    const { db, store, projectId } = base();
    store.sessions.create(sessao('ses_a', projectId));
    const ins = db.prepare(
      `INSERT INTO events (id, seq, ts, session_id, task_id, agent_id, type, payload_json, cost_json)
       VALUES (?, ?, 't', 'ses_a', NULL, 'claude', 'cost', '{}', ?)`,
    );
    ins.run('e1', 1, JSON.stringify({ usd: 0.5, inputTokens: 10, outputTokens: 5 }));
    // Provisório não conta (o custo final do turno o substitui).
    ins.run('e2', 2, JSON.stringify({ usd: 9, inputTokens: 900, provisional: true }));
    // Sem usd: conta só nos tokens.
    ins.run('e3', 3, JSON.stringify({ inputTokens: 1 }));
    ins.run('e4', 4, null);
    assert.deepEqual(store.events.costOf('ses_a'), { usd: 0.5, tokens: 16, seconds: 0 });
    assert.equal(store.sessions.graphRows('ses_a')[0]?.usd, 0.5);
    assert.equal(store.sessions.graphRows('ses_a')[0]?.tokens, 16);
  });

  test('planos: soma lê o índice das colunas geradas; listagem por tipo não ordena em B-TREE temporária', () => {
    const { db } = base();
    const custo = plano(
      db,
      `SELECT SUM(cost_usd), SUM(cost_tokens) FROM events WHERE session_id = ? AND cost_tokens IS NOT NULL`,
      'x',
    );
    assert.match(custo, /idx_events_custo_soma/, custo);
    const porTipo = plano(
      db,
      `SELECT * FROM events WHERE type IN (?) ORDER BY session_id, seq LIMIT 10`,
      'cost',
    );
    assert.match(porTipo, /idx_events_type_sessao/, porTipo);
    assert.doesNotMatch(porTipo, /TEMP B-TREE/, porTipo);
    const porTask = plano(db, `SELECT * FROM events WHERE task_id = ? ORDER BY session_id, seq LIMIT 10`, 't');
    assert.match(porTask, /idx_events_task_sessao/, porTask);
    assert.doesNotMatch(porTask, /TEMP B-TREE/, porTask);
  });

  test('desempenho com 100k eventos: grafo bem mais rápido que a varredura por JSON', () => {
    const { db, store, projectId } = base();
    const raiz = 'ses_raiz';
    const ids = [raiz];
    store.sessions.create(sessao(raiz, projectId));
    for (let i = 1; i < 10; i += 1) {
      ids.push(`ses_f${i}`);
      store.sessions.create(sessao(`ses_f${i}`, projectId, raiz, raiz));
    }
    const ins = db.prepare(
      `INSERT INTO events (id, seq, ts, session_id, task_id, agent_id, type, payload_json, cost_json)
       VALUES (?, ?, 't', ?, NULL, 'claude', ?, '{"content":"abcdefghij"}', ?)`,
    );
    db.exec('BEGIN');
    for (let i = 0; i < 100_000; i += 1) {
      const comCusto = i % 3 === 0;
      ins.run(
        `evt_${i}`,
        Math.floor(i / 10) + 1,
        ids[i % 10]!,
        comCusto ? 'turn.completed' : 'message',
        comCusto ? JSON.stringify({ usd: 0.001, inputTokens: 10, outputTokens: 5 }) : null,
      );
    }
    db.exec('COMMIT');

    // Tempo ABSOLUTO não serve de critério: sob a suíte inteira em paralelo o
    // mesmo graphRows foi de 6 ms para 100 ms. O teste compara com a consulta
    // ANTIGA (varredura com json_extract por evento), medida intercalada no
    // mesmo banco e na mesma carga: a razão entre as duas é estável.
    const antigaGrafo = db.prepare(
      `SELECT s.id,
              COALESCE(SUM(CASE WHEN COALESCE(json_extract(e.cost_json, '$.provisional'), 0) = 0
                                THEN json_extract(e.cost_json, '$.usd') END), 0) AS usd,
              COALESCE(SUM(CASE WHEN COALESCE(json_extract(e.cost_json, '$.provisional'), 0) = 0
                                THEN COALESCE(json_extract(e.cost_json, '$.inputTokens'), 0) +
                                     COALESCE(json_extract(e.cost_json, '$.outputTokens'), 0) END), 0) AS tokens
       FROM sessions s LEFT JOIN events e ON e.session_id = s.id
       WHERE s.root_id = ? GROUP BY s.id`,
    );
    const mediana = (xs: number[]): number => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    const comparar = (nova: () => unknown, antiga: () => unknown): { nova: number; antiga: number } => {
      nova();
      antiga(); // aquece o cache de páginas
      const tn: number[] = [];
      const ta: number[] = [];
      for (let k = 0; k < 7; k += 1) {
        let t0 = performance.now();
        nova();
        tn.push(performance.now() - t0);
        t0 = performance.now();
        antiga();
        ta.push(performance.now() - t0);
      }
      return { nova: mediana(tn), antiga: mediana(ta) };
    };

    // Resultado certo (33 334 eventos com custo, US$ 0,001 cada), igual ao antigo.
    const total = store.sessions.graphRows(raiz).reduce((a, r) => a + r.usd, 0);
    assert.ok(Math.abs(total - 33.334) < 1e-6, String(total));
    const totalAntigo = (antigaGrafo.all(raiz) as Array<{ usd: number }>).reduce((a, r) => a + r.usd, 0);
    assert.ok(Math.abs(total - totalAntigo) < 1e-6);

    // Medido nesta máquina (Node 24, Windows, isolado): graphRows ~70 ms ->
    // ~6 ms (~11x). Exige ao menos 3x — folga para CI e carga — e um teto
    // absoluto largo só para pegar regressão de ordem de grandeza.
    const g = comparar(
      () => store.sessions.graphRows(raiz),
      () => antigaGrafo.all(raiz),
    );
    assert.ok(
      g.nova * 3 < g.antiga,
      `graphRows ${g.nova.toFixed(1)} ms não ficou 3x mais rápido que a varredura (${g.antiga.toFixed(1)} ms)`,
    );
    assert.ok(g.nova < 1000, `graphRows levou ${g.nova.toFixed(1)} ms`);
  });
});

describe('R09-16: transaction()', () => {
  test('fn assíncrona é recusada e nada é confirmado', async () => {
    const { store, projectId } = base();
    assert.throws(
      () =>
        store.transaction(() => {
          store.sessions.create(sessao('ses_async', projectId));
          return Promise.resolve(1);
        }),
      /função assíncrona/,
    );
    assert.equal(store.sessions.get('ses_async'), null);
    // A transação foi encerrada: uma nova abre normalmente.
    store.transaction(() => store.sessions.create(sessao('ses_depois', projectId)));
    assert.ok(store.sessions.get('ses_depois'));
  });

  test('interna que falha com exceção engolida não deixa escrita parcial no commit externo', () => {
    const { store, projectId } = base();
    store.transaction(() => {
      store.sessions.create(sessao('ses_externa', projectId));
      try {
        store.transaction(() => {
          store.sessions.create(sessao('ses_interna', projectId));
          throw new Error('falhou no meio');
        });
      } catch {
        /* engolida de propósito */
      }
    });
    assert.ok(store.sessions.get('ses_externa'));
    assert.equal(store.sessions.get('ses_interna'), null);
  });

  test('interna bem-sucedida entra no commit externo; externa que falha desfaz tudo', () => {
    const { store, projectId } = base();
    assert.throws(() =>
      store.transaction(() => {
        store.transaction(() => store.sessions.create(sessao('ses_i', projectId)));
        throw new Error('externa falhou');
      }),
    );
    assert.equal(store.sessions.get('ses_i'), null);
    store.transaction(() => {
      store.transaction(() => store.sessions.create(sessao('ses_ok', projectId)));
    });
    assert.ok(store.sessions.get('ses_ok'));
  });
});

describe('R09-17: integridade no schema', () => {
  test('duas pastas principais no mesmo projeto são recusadas pelo banco', () => {
    const { store, projectId } = base();
    store.projects.addFolder({ projectId, path: '/a', label: null, isPrimary: true });
    assert.throws(
      () => store.projects.addFolder({ projectId, path: '/b', label: null, isPrimary: true }),
      /UNIQUE/,
    );
    // Pasta comum continua livre.
    store.projects.addFolder({ projectId, path: '/c', label: null, isPrimary: false });
  });

  test('evento com task inexistente é recusado; com task real passa', () => {
    const { store, projectId } = base();
    store.sessions.create(sessao('ses_t', projectId));
    store.tasks.create(task('tsk_real', 'ses_t'));
    const ev = (id: string, seq: number, taskId: string | null) => ({
      id,
      seq,
      ts: 't',
      sessionId: 'ses_t',
      taskId,
      agentId: 'claude',
      type: 'log' as const,
      payload: {},
      cost: null,
      raw: null,
    });
    assert.throws(() => store.events.append(ev('e1', 1, 'tsk_ghost')), /FOREIGN KEY/);
    store.events.append(ev('e2', 2, 'tsk_real'));
    store.events.append(ev('e3', 3, null));
    assert.equal(store.events.list({ sessionId: 'ses_t' }).length, 2);
  });

  test('migração 10 em banco com duas principais não perde pasta: a mais antiga fica principal', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    // Sobe até a 9, planta a duplicidade que a guarda do daemon evitava.
    const ate9 = MIGRATIONS.filter((m) => m.version <= 9);
    db.exec(`CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`);
    for (const m of ate9) {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations VALUES (?, ?, ?)').run(m.version, m.name, 'x');
    }
    db.exec(`INSERT INTO projects (id, name, path, default_branch, created_at) VALUES ('prj_1','p','/p','main','1')`);
    db.exec(`INSERT INTO project_folders (id, project_id, path, label, is_primary, created_at) VALUES
      ('pfd_nova','prj_1','/nova',NULL,1,'2021'),
      ('pfd_velha','prj_1','/velha',NULL,1,'2020'),
      ('pfd_comum','prj_1','/comum',NULL,0,'2019')`);
    migrate(db);
    const linhas = db
      .prepare('SELECT id, is_primary FROM project_folders ORDER BY id')
      .all() as Array<{ id: string; is_primary: number }>;
    assert.deepEqual(
      linhas.map((l) => [l.id, l.is_primary]),
      [
        ['pfd_comum', 0],
        ['pfd_nova', 0],
        ['pfd_velha', 1],
      ],
    );
  });
});
