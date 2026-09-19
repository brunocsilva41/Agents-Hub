import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso, type Session } from '@agents-hub/core';
import { createHub, type Hub } from '@agents-hub/daemon';
import { HubClient } from './client.js';
import { pauseCommand } from './pause-cmd.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * `port: 0` não basta: a guarda de borda compara o `Host` da requisição contra
 * `config.port`, que só é conhecido depois do `listen`. Reservamos uma porta
 * livre antes de montar o Hub, mesma técnica de `sse-http.test.ts`.
 */
function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const endereco = srv.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      srv.close(() => resolve(porta));
    });
  });
}

/**
 * `hub pause` era a rota órfã do audit: existia no daemon (`sessions.pause`,
 * `POST /sessions/:id/pause`) e no client (`HubClient.pause`), mas nenhuma
 * superfície a expunha. Este teste cobre o caminho novo da CLI contra um
 * daemon de verdade — não um mock do client — porque é o daemon quem decide
 * se `pause` é aceito (estado terminal é recusado, ver `terminal-state.test.ts`).
 */
describe('hub pause (CLI)', () => {
  let hub: Hub;
  let raiz: string;
  let client: HubClient;
  let projectId: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-pause-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({
      home: raiz,
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: await portaLivre(),
    });
    const { host, port } = await hub.start();
    client = new HubClient(`http://${host}:${port}`);
    projectId = hub.sessions.registerProject(raiz, 'projeto-pause-cli').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function semearRodando(): Session {
    const id = newId('ses');
    const session: Session = {
      id,
      projectId,
      agentId: 'claude',
      parentId: null,
      rootId: id,
      depth: 0,
      path: [`claude:${id}`],
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      nativeSessionId: null,
      title: 'sessão de teste da CLI',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);
    return session;
  }

  test('pausa a sessão via daemon real e confirma no console', async () => {
    const session = semearRodando();
    const args: Args = { command: 'pause', positional: [session.id], flags: {} };

    const linhas: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => {
      linhas.push(String(msg));
    };
    try {
      await pauseCommand(client, args);
    } finally {
      console.log = originalLog;
    }

    assert.equal(hub.store.sessions.get(session.id)?.state, 'paused');
    assert.ok(linhas.some((l) => l.includes('pausada')), 'deveria confirmar a pausa no console');
  });

  test('sem sessionId, recusa com argumento obrigatório ausente', async () => {
    const args: Args = { command: 'pause', positional: [], flags: {} };
    await assert.rejects(() => pauseCommand(client, args), /argumento obrigatório ausente/i);
  });

  test('sessão já terminada é recusada pelo daemon', async () => {
    const id = newId('ses');
    const session: Session = {
      id,
      projectId,
      agentId: 'claude',
      parentId: null,
      rootId: id,
      depth: 0,
      path: [`claude:${id}`],
      state: 'completed',
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      nativeSessionId: null,
      title: 'sessão já concluída',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: nowIso(),
      pid: null,
    };
    hub.store.sessions.create(session);

    const args: Args = { command: 'pause', positional: [id], flags: {} };
    await assert.rejects(() => pauseCommand(client, args), /já terminou/i);
    assert.equal(hub.store.sessions.get(id)?.state, 'completed');
  });
});
