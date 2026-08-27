import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso, type Approval, type Session, type Task } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Reconciliação de estado na subida do daemon.
 *
 * Uma run só existe dentro de um processo. Sem esta reconciliação, todo crash
 * ou reinício deixava sessões marcadas como `running` para sempre — apareciam
 * vivas no `hub status` e no painel sem nunca progredir.
 */
describe('reconciliação na subida do daemon', () => {
  let hub: Hub;
  let raiz: string;
  let projectId: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-reconcile-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });

    hub = createHub({ home: raiz, manifestsDir: manifestos, webRoot: path.join(raiz, 'sem-web') });
    projectId = hub.sessions.registerProject(raiz, 'projeto-reconcile').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function semear(state: Session['state'], comAprovacaoPendente = false): {
    session: Session;
    task: Task;
  } {
    const sessionId = newId('ses');
    const session: Session = {
      id: sessionId,
      projectId,
      agentId: 'fantasma',
      nativeSessionId: null,
      rootId: sessionId,
      parentId: null,
      depth: 0,
      path: [],
      state,
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      title: `sessão em ${state}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
    };

    const task: Task = {
      id: newId('tsk'),
      sessionId,
      requesterSessionId: null,
      brief: { agent: 'fantasma', objective: 'x' } as Task['brief'],
      state: 'working',
      attempts: [],
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    hub.store.sessions.create(session);
    hub.store.tasks.create(task);

    if (comAprovacaoPendente) {
      const approval: Approval = {
        id: newId('apv'),
        sessionId,
        taskId: task.id,
        risk: 'irreversible',
        action: 'algo que precisa da sua decisão',
        detail: {},
        state: 'pending',
        requestedAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
      };
      hub.store.approvals.create(approval);
    }

    return { session, task };
  }

  test('sessão marcada como running sem processo por trás é encerrada', () => {
    const { session, task } = semear('running');

    const resultado = hub.sessions.reconcileOnStartup();
    assert.ok(resultado.encerradas >= 1);

    assert.equal(hub.store.sessions.get(session.id)?.state, 'killed');
    assert.equal(
      hub.store.tasks.get(task.id)?.state,
      'failed',
      'a task não pode continuar "working" sem ninguém trabalhando nela',
    );
  });

  test('sessão esperando aprovação humana SOBREVIVE ao reinício', () => {
    const { session, task } = semear('waiting_approval', true);

    const resultado = hub.sessions.reconcileOnStartup();
    assert.ok(resultado.revividas >= 1);

    assert.equal(
      hub.store.sessions.get(session.id)?.state,
      'waiting_approval',
      'ela não depende de processo nenhum: depende de você',
    );
    assert.equal(hub.store.tasks.get(task.id)?.state, 'working');
  });

  test('sessão em waiting_approval SEM aprovação pendente é órfã e cai', () => {
    const { session } = semear('waiting_approval', false);

    hub.sessions.reconcileOnStartup();

    assert.equal(
      hub.store.sessions.get(session.id)?.state,
      'killed',
      'esperar uma aprovação que não existe é esperar para sempre',
    );
  });

  test('sessão já terminada não é tocada', () => {
    const { session } = semear('completed');
    const antes = hub.store.sessions.get(session.id);

    hub.sessions.reconcileOnStartup();

    assert.equal(hub.store.sessions.get(session.id)?.state, 'completed');
    assert.equal(hub.store.sessions.get(session.id)?.endedAt, antes?.endedAt);
  });

  test('rodar duas vezes seguidas não muda mais nada', () => {
    hub.sessions.reconcileOnStartup();
    const segunda = hub.sessions.reconcileOnStartup();
    assert.equal(segunda.encerradas, 0, 'a reconciliação precisa ser idempotente');
  });
});
