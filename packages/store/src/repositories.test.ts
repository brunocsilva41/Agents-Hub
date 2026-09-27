import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope, Session } from '@agents-hub/core';
import { createStore, openDatabase, SqliteUnitOfWork, type Db } from './index.js';

/**
 * "Não encontrado" precisa devolver `null`, nunca uma linha fantasma.
 *
 * Medido contra o piso declarado em `engines` (Node 22.5.0): `.get()` do
 * `node:sqlite` sem nenhuma linha casando devolvia `{ coluna: null, ... }`
 * em vez de `undefined` — só corrigido em versão posterior do runtime. Todo
 * `row ? mapX(row) : null` deste pacote lia esse objeto fantasma como
 * "encontrado". `getByPath` de um projeto inexistente virava "achado", e
 * `registerProject` retornava sem nunca inserir a linha real — a origem do
 * `FOREIGN KEY constraint failed` que a suíte via CI expôs (Node 24 não
 * reproduz; o job de Node 22.5 pegou). Corrigido trocando `.get()` por
 * `.all()[0]`, que devolve `[]` de verdade nas duas versões — estes testes
 * são a garantia de que a correção não volta a se perder numa próxima troca.
 */
describe('lookup de "uma linha ou nenhuma" devolve null quando não existe', () => {
  test('projeto por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.projects.get('prj_inexistente'), null);
  });

  test('projeto por caminho', () => {
    const store = createStore(':memory:');
    assert.equal(store.projects.getByPath('/caminho/que/nao/existe'), null);
  });

  test('pasta de projeto por caminho', () => {
    const store = createStore(':memory:');
    assert.equal(store.projects.findFolderByPath('/pasta/que/nao/existe'), null);
  });

  test('sessão por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.sessions.get('ses_inexistente'), null);
  });

  test('task por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.tasks.get('tsk_inexistente'), null);
  });

  test('aprovação por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.approvals.get('apv_inexistente'), null);
  });

  test('orçamento por root id', () => {
    const store = createStore(':memory:');
    assert.equal(store.budgets.get('ses_raiz_inexistente'), null);
  });

  test('registrar projeto duas vezes não recria: a segunda chamada acha o real', () => {
    // Reproduz o caminho exato que o bug quebrava: getByPath encontrando
    // (corretamente) um projeto que JÁ existe, sem confundir com "nenhuma
    // linha casou". Se getByPath devolvesse a linha fantasma para qualquer
    // busca, o projeto criado abaixo teria id vazio.
    const store = createStore(':memory:');
    const criado = store.projects.create({
      name: 'projeto-real',
      path: '/algum/caminho',
      defaultBranch: 'main',
    });
    assert.notEqual(criado.id, '');

    const encontrado = store.projects.getByPath('/algum/caminho');
    assert.deepEqual(encontrado, criado);
  });
});

/**
 * Retenção de eventos (ADR 06.3 + achado §3.7 do doc 08).
 *
 * `raw_json` cresce para sempre junto com `payload_json` sem nunca ser lido
 * no dia a dia — só serve para depurar mapper errado. `compactRawBefore`
 * zera esse campo para sessões encerradas há tempo suficiente, sem nunca
 * apagar a linha nem tocar `payload_json` (a decisão "eventos para sempre"
 * do ADR continua valendo para o que sustenta replay/timeline/auditoria).
 */
describe('compactRawBefore', () => {
  function semearSessaoComEvento(
    store: ReturnType<typeof createStore>,
    endedAt: string | null,
  ): { session: Session; event: EventEnvelope } {
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
      payload: { texto: 'oi' },
      cost: null,
      raw: { bruto: 'evento original do agente' },
    };
    store.events.append(event);

    return { session, event };
  }

  test('zera raw_json de eventos cuja sessão terminou antes do corte', () => {
    const store = createStore(':memory:');
    const { event } = semearSessaoComEvento(store, '2020-01-01T00:00:00.000Z');

    const cutoff = '2024-01-01T00:00:00.000Z';
    const afetadas = store.events.compactRawBefore(cutoff);

    assert.equal(afetadas, 1);
    const [lido] = store.events.list({ sessionId: event.sessionId });
    assert.equal(lido?.raw, null);
    // payload_json nunca é tocado — é o que sustenta replay/timeline/auditoria.
    assert.deepEqual(lido?.payload, { texto: 'oi' });
  });

  test('não toca eventos de sessão encerrada DEPOIS do corte', () => {
    const store = createStore(':memory:');
    const { event } = semearSessaoComEvento(store, '2030-01-01T00:00:00.000Z');

    const cutoff = '2024-01-01T00:00:00.000Z';
    const afetadas = store.events.compactRawBefore(cutoff);

    assert.equal(afetadas, 0);
    const [lido] = store.events.list({ sessionId: event.sessionId });
    assert.deepEqual(lido?.raw, { bruto: 'evento original do agente' });
  });

  test('não toca eventos de sessão ainda viva (ended_at null)', () => {
    const store = createStore(':memory:');
    const { event } = semearSessaoComEvento(store, null);

    const afetadas = store.events.compactRawBefore('2099-01-01T00:00:00.000Z');

    assert.equal(afetadas, 0);
    const [lido] = store.events.list({ sessionId: event.sessionId });
    assert.notEqual(lido?.raw, null);
  });

  test('é idempotente: rodar duas vezes não afeta linha já compactada', () => {
    const store = createStore(':memory:');
    semearSessaoComEvento(store, '2020-01-01T00:00:00.000Z');

    const cutoff = '2024-01-01T00:00:00.000Z';
    assert.equal(store.events.compactRawBefore(cutoff), 1);
    assert.equal(store.events.compactRawBefore(cutoff), 0);
  });
});

/** Sessão com `n` eventos (seq 1..n); `tipo(i)` e `custo(i)` opcionais. */
function sessaoComEventos(
  store: ReturnType<typeof createStore>,
  n: number,
  tipo: (i: number) => EventEnvelope['type'] = () => 'message',
  custo: (i: number) => EventEnvelope['cost'] = () => null,
): string {
  const project = store.projects.create({
    name: `p-${Math.random()}`,
    path: `/p/${Math.random()}`,
    defaultBranch: 'main',
  });
  const sessionId = `ses_${Math.random().toString(36).slice(2)}`;
  store.sessions.create({
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
  });
  store.transaction(() => {
    for (let i = 1; i <= n; i += 1) {
      store.events.append({
        id: `evt_${sessionId}_${i}`,
        seq: i,
        ts: '2020-01-01T00:00:00.000Z',
        sessionId,
        taskId: null,
        agentId: 'claude',
        type: tipo(i),
        payload: { text: `passo ${i}` },
        cost: custo(i),
        raw: null,
      });
    }
  });
  return sessionId;
}

/**
 * Fase 3.3 (vistoria 2026-09-25, relatório 09): o replay e o
 * `hub_context_fetch` pediam `limit` e recebiam os PRIMEIROS N eventos.
 */
describe('events.list: cauda da sessão', () => {
  test('1000 eventos, tail + limit 400 => seq 601..1000 em ordem crescente', () => {
    const store = createStore(':memory:');
    const sessionId = sessaoComEventos(store, 1000);

    const cauda = store.events.list({ sessionId, tail: true, limit: 400 });
    assert.equal(cauda.length, 400);
    assert.equal(cauda[0]?.seq, 601);
    assert.equal(cauda.at(-1)?.seq, 1000);
    assert.ok(
      cauda.every((e, i) => i === 0 || e.seq > (cauda[i - 1]?.seq ?? 0)),
      'ordem crescente',
    );

    // Sem `tail` o comportamento de paginação (sinceSeq + limit) não muda.
    const inicio = store.events.list({ sessionId, limit: 400 });
    assert.equal(inicio[0]?.seq, 1);
  });

  test('tail combina com filtro de tipo: os últimos N narrativos, não N de ruído', () => {
    const store = createStore(':memory:');
    // 1000 eventos, só os múltiplos de 10 são mensagem; o resto é log.
    const sessionId = sessaoComEventos(store, 1000, (i) => (i % 10 === 0 ? 'message' : 'log'));
    const cauda = store.events.list({ sessionId, types: ['message'], tail: true, limit: 5 });
    assert.deepEqual(
      cauda.map((e) => e.seq),
      [960, 970, 980, 990, 1000],
    );
  });

  test('limit negativo, zero ou NaN não vira "sem limite" (LIMIT -1 do SQLite)', () => {
    const store = createStore(':memory:');
    const sessionId = sessaoComEventos(store, 30);
    assert.equal(store.events.list({ sessionId, limit: -1 }).length, 1);
    assert.equal(store.events.list({ sessionId, limit: Number.NaN }).length, 30);
    assert.equal(store.events.list({ sessionId, limit: 10_000 }).length, 30);
  });
});

/** Fase 3.1: estimativa parcial não entra nas somas de custo. */
describe('costOf / graphRows ignoram custo provisório', () => {
  test('parciais + final: soma só o final', () => {
    const store = createStore(':memory:');
    const sessionId = sessaoComEventos(
      store,
      3,
      (i) => (i === 3 ? 'turn.completed' : 'message'),
      (i) =>
        i === 3
          ? { usd: 0.1378276, inputTokens: 2, outputTokens: 4 }
          : { usd: 0.013189, inputTokens: 2, outputTokens: 4, provisional: true, partId: 'msg_1' },
    );
    const custo = store.events.costOf(sessionId);
    assert.ok(Math.abs(custo.usd - 0.1378276) < 1e-12, `US$ ${custo.usd}`);
    assert.equal(custo.tokens, 6);
    const [linha] = store.sessions.graphRows(sessionId);
    assert.ok(Math.abs((linha?.usd ?? 0) - 0.1378276) < 1e-12);
    assert.equal(linha?.tokens, 6);
  });
});

/**
 * Handoff troca o agente da sessão (vistoria 2026-09-25, item 2.7): o
 * `UPDATE sessions` não tinha `agent_id`, e a troca virava no-op no banco.
 */
describe('sessions.update persiste agentId', () => {
  test('mudar agentId sobrevive a uma releitura do banco', () => {
    const store = createStore(':memory:');
    const project = store.projects.create({ name: 'p', path: '/p/handoff', defaultBranch: 'main' });
    const id = `ses_${Math.random().toString(36).slice(2)}`;
    store.sessions.create({
      id,
      projectId: project.id,
      agentId: 'alfa',
      nativeSessionId: null,
      rootId: id,
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
    });

    store.sessions.update(id, { agentId: 'gama' });

    assert.equal(store.sessions.get(id)?.agentId, 'gama');
    assert.equal(store.sessions.list({ rootId: id })[0]?.agentId, 'gama');
    assert.equal(store.sessions.graphRows(id)[0]?.agentId, 'gama');
  });
});

/**
 * Compactação em lotes e consultas agregadas por índice parcial (vistoria
 * 2026-09-25, 09-store-core, MÉDIOs de compactação e agregados).
 */
describe('compactação em lotes e índices parciais', () => {
  function semear(db: Db, store: ReturnType<typeof createStore>, eventos: number): string {
    const project = store.projects.create({
      name: `p-${Math.random()}`,
      path: `/p/${Math.random()}`,
      defaultBranch: 'main',
    });
    const id = `ses_${Math.random().toString(36).slice(2)}`;
    store.sessions.create({
      id,
      projectId: project.id,
      agentId: 'claude',
      nativeSessionId: null,
      rootId: id,
      parentId: null,
      depth: 0,
      path: [],
      state: 'completed',
      mode: 'semi',
      isolation: 'none',
      workdir: '/tmp/x',
      title: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:00:00.000Z',
      pid: null,
    });
    const ins = db.prepare(
      `INSERT INTO events (id, seq, ts, session_id, task_id, agent_id, type, payload_json, cost_json, raw_json)
       VALUES (?, ?, '2020-01-01T00:00:00.000Z', ?, NULL, 'claude', 'log', '{}', ?, '{"bruto":1}')`,
    );
    db.exec('BEGIN');
    for (let seq = 1; seq <= eventos; seq += 1) {
      ins.run(`evt_${id}_${seq}`, seq, id, seq % 10 === 0 ? '{"usd":0.5,"inputTokens":1}' : null);
    }
    db.exec('COMMIT');
    return id;
  }

  test('compactRawBefore(limit) afeta no máximo `limit` linhas por chamada', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteUnitOfWork(db);
    semear(db, store, 25);

    const corte = '2024-01-01T00:00:00.000Z';
    assert.equal(store.events.compactRawBefore(corte, 10), 10);
    assert.equal(store.events.compactRawBefore(corte, 10), 10);
    assert.equal(store.events.compactRawBefore(corte, 10), 5);
    assert.equal(store.events.compactRawBefore(corte, 10), 0);
    const restantes = db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE raw_json IS NOT NULL')
      .get() as { n: number };
    assert.equal(restantes.n, 0);
  });

  test('a passada de compactação e as somas de custo usam os índices parciais', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteUnitOfWork(db);
    const id = semear(db, store, 50);
    db.exec('ANALYZE');

    const plano = (sql: string, ...params: Array<string | number>): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ');

    const compactacao = plano(
      `SELECT e.rowid FROM sessions s
       JOIN events e ON e.session_id = s.id AND e.raw_json IS NOT NULL
       WHERE s.ended_at IS NOT NULL AND s.ended_at < ? LIMIT ?`,
      '2024-01-01T00:00:00.000Z',
      10,
    );
    assert.match(compactacao, /idx_events_raw/, compactacao);

    const custo = plano(
      `SELECT SUM(cost_usd) FROM events WHERE session_id = ? AND cost_tokens IS NOT NULL`,
      id,
    );
    assert.match(custo, /idx_events_custo_soma/, custo);

    // E o resultado das somas não muda com o filtro.
    assert.equal(store.events.costOf(id).usd, 2.5);
    assert.equal(store.sessions.graphRows(id)[0]?.usd, 2.5);
  });
});
