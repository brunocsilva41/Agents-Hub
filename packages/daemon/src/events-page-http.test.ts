import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso, type EventEnvelope, type Session } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';


/**
 * `GET /sessions/:id/events` pelo fim (`tail=1`) e para trás (`before=`).
 *
 * O painel abria sessões longas nos 500 eventos MAIS ANTIGOS — a rota só sabia
 * "a partir de `since`". Este teste passa pela borda HTTP real, porque o
 * repositório saber paginar não adianta se a rota não repassar os parâmetros.
 */
describe('HTTP: página de eventos pelo fim', () => {
  let raiz: string;
  let hub: Hub;
  let baseUrl: string;
  let sessionId: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-events-page-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: 0,
    });
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;

    const projectId = hub.sessions.registerProject(raiz, 'projeto-pagina').id;
    sessionId = newId('ses');
    const session: Session = {
      id: sessionId,
      projectId,
      agentId: 'claude',
      parentId: null,
      rootId: sessionId,
      depth: 0,
      state: 'completed',
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      nativeSessionId: null,
      path: [`claude:${sessionId}`],
      title: 'sessão longa',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: nowIso(),
      pid: null,
    };
    hub.store.sessions.create(session);
    for (let seq = 1; seq <= 30; seq += 1) {
      const event: EventEnvelope = {
        id: newId('evt'),
        seq,
        ts: nowIso(),
        sessionId,
        taskId: null,
        agentId: 'claude',
        type: 'log',
        payload: { n: seq },
        cost: null,
        raw: null,
      };
      hub.store.events.append(event);
    }
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  async function seqs(query: string): Promise<number[]> {
    const res = await fetch(`${baseUrl}/sessions/${sessionId}/events${query}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: EventEnvelope[] };
    return body.events.map((e) => e.seq);
  }

  test('tail=1 devolve os mais recentes', async () => {
    assert.deepEqual(await seqs('?tail=1&limit=5'), [26, 27, 28, 29, 30]);
  });

  test('before= pagina para trás', async () => {
    assert.deepEqual(await seqs('?before=26&limit=5'), [21, 22, 23, 24, 25]);
  });

  test('sem parâmetros novos, o comportamento antigo continua', async () => {
    assert.deepEqual(await seqs('?limit=3'), [1, 2, 3]);
  });
});
