import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso } from '@agents-hub/core';
import { AdoptedRootLeases } from './adopted-leases.js';
import { createHub, type Hub } from './hub.js';

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
 * Raízes adotadas ficavam `running` para sempre quando o hospedeiro matava o
 * MCP server sem fechar stdin (vistoria 2026-09-25, 08-mcp-hooks achado 13;
 * item 2.8 do GOAL). Agora há um prazo renovado por sinal de vida.
 */
describe('prazo das raízes adotadas', () => {
  let raiz: string;
  let hub: Hub;
  let baseUrl: string;
  let projetoPath: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-leases-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    writeFileSync(
      path.join(manifestos, 'externo.yaml'),
      ['id: externo', 'name: Externo', 'bin: node', 'invoke:', '  oneShot: ["--version"]'].join('\n'),
      'utf8',
    );
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: await portaLivre(),
    });
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  async function adotarPorHttp(): Promise<string> {
    const res = await fetch(`${baseUrl}/sessions/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'externo', projectPath: projetoPath }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    return ((await res.json()) as { session: { id: string } }).session.id;
  }

  test('raiz adotada sem sinal de vida expira e é encerrada com evento explicando o motivo', async () => {
    const id = await adotarPorHttp();
    assert.equal(hub.store.sessions.get(id)?.state, 'running');

    const encerradas = await hub.leases.expire(Date.now() + hub.leases.leaseMs + 1000);

    assert.ok(encerradas.includes(id));
    assert.equal(hub.store.sessions.get(id)?.state, 'completed');
    const fim = hub.store.events.list({ sessionId: id, types: ['session.ended'] });
    assert.equal(fim.length, 1);
    assert.match(String(fim[0]?.payload['reason']), /sem sinal de vida/);
  });

  test('o sinal de vida renova o prazo; raiz expirada recusa o sinal (o MCP adota outra)', async () => {
    let agora = 1_000_000;
    const leases = new AdoptedRootLeases(hub.sessions, { leaseMs: 10_000, now: () => agora });
    const projectId = hub.sessions.registerProject(projetoPath).id;
    const id = hub.sessions.adoptExternal({ agentId: 'externo', projectId }).id;
    leases.track(id);

    agora += 8_000;
    leases.heartbeat(id);
    agora += 8_000;
    assert.deepEqual(await leases.expire(), [], 'o sinal de vida de 8 s atrás mantém a raiz viva');
    assert.equal(hub.store.sessions.get(id)?.state, 'running');

    agora += 11_000;
    assert.deepEqual(await leases.expire(), [id]);
    assert.throws(() => leases.heartbeat(id), /já terminou/);
  });

  test('POST /sessions/:id/heartbeat: 200 para raiz adotada viva, erro para sessão comum', async () => {
    const id = await adotarPorHttp();
    const ok = await fetch(`${baseUrl}/sessions/${id}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(ok.status, 200, await ok.clone().text());

    const comum = newId('ses');
    hub.store.sessions.create({
      id: comum,
      projectId: hub.store.sessions.get(id)!.projectId,
      agentId: 'externo',
      nativeSessionId: null,
      rootId: comum,
      parentId: null,
      depth: 0,
      path: ['externo:abc'],
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: projetoPath,
      title: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    });
    const recusa = await fetch(`${baseUrl}/sessions/${comum}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(recusa.status, 200);
    const corpo = (await recusa.json()) as { error: { code: string } };
    assert.equal(corpo.error.code, 'ILLEGAL_STATE');
  });
});
