import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, newId, nowIso, type Session } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Fase 3.3 (vistoria 2026-09-25, relatório 09): `hub_context_fetch
 * session:<id>` devolvia os 200 PRIMEIROS eventos; numa sessão longa o filho
 * via a exploração inicial e nunca o estado atual.
 */
describe('hub_context_fetch devolve o fim da sessão', () => {
  let raiz: string;
  let hub: Hub;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-context-tail-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(path.join(raiz, 'projeto'), { recursive: true });
    hub = createHub({ home: path.join(raiz, 'home'), manifestsDir: manifestos, policy: DEFAULT_POLICY });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('sessão com 1000 eventos: session:<id> traz os últimos 200 (801..1000)', () => {
    const proj = hub.sessions.registerProject(path.join(raiz, 'projeto'), 'Contexto');
    const id = newId('ses');
    const sessao: Session = {
      id,
      projectId: proj.id,
      agentId: 'claude',
      nativeSessionId: null,
      rootId: id,
      parentId: null,
      depth: 0,
      path: [],
      state: 'completed',
      mode: 'semi',
      isolation: 'none',
      workdir: proj.path,
      title: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: nowIso(),
      pid: null,
    };
    hub.store.sessions.create(sessao);
    hub.store.transaction(() => {
      for (let seq = 1; seq <= 1000; seq += 1) {
        hub.store.events.append({
          id: newId('evt'),
          seq,
          ts: nowIso(),
          sessionId: id,
          taskId: null,
          agentId: 'claude',
          type: 'message',
          payload: { text: `passo ${seq}` },
          cost: null,
          raw: null,
        });
      }
    });

    const { events } = hub.sessions.fetchContext(`session:${id}`);
    assert.equal(events.length, 200);
    assert.equal(events[0]?.seq, 801);
    assert.equal(events.at(-1)?.seq, 1000, 'o último evento da sessão tem que vir');
  });
});
