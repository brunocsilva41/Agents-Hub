import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope, Session } from '@agents-hub/core';
import { createStore } from './index.js';

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
