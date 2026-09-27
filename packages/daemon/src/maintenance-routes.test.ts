import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub, type Hub } from './hub.js';

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const porta = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => resolve(porta));
    });
  });
}

/**
 * `POST /maintenance/backup` (item 5.6): backup consistente pelo daemon no
 * ar. Grava arquivo em caminho escolhido por quem chama — exige token.
 */
describe('POST /maintenance/backup', () => {
  let raiz: string;
  let hub: Hub;
  let base: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-maint-backup-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: await portaLivre(),
    });
    const { host, port } = await hub.start();
    base = `http://${host}:${port}`;
    for (let i = 0; i < 20; i += 1) hub.sessions.registerProject(path.join(raiz, `p${i}`), `p${i}`);
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* oportunista */
    }
  });

  const post = (corpo: unknown, token?: string) =>
    fetch(`${base}/maintenance/backup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(corpo),
    });

  test('sem token -> 401 e nada é gravado', async () => {
    const out = path.join(raiz, 'sem-token.db');
    const r = await post({ out });
    assert.equal(r.status, 401);
    assert.equal(existsSync(out), false);
  });

  test('com token grava um banco com todos os projetos (inclui o WAL) e registra na auditoria', async () => {
    const out = path.join(raiz, 'saida', 'b.db');
    const r = await post({ out }, hub.operatorToken);
    assert.equal(r.status, 200);
    const { backup } = (await r.json()) as { backup: { path: string; bytes: number } };
    assert.equal(backup.path, out);
    const db = new DatabaseSync(out);
    try {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
      assert.equal(Number(n), 20);
    } finally {
      db.close();
    }
    const trilha = hub.audit.list({ kind: 'maintenance.backup' });
    assert.equal(trilha.length, 1);
    assert.equal(trilha[0]?.detail['path'], out);
  });

  test('sem "out" grava em <home>/backups', async () => {
    const r = await post({}, hub.operatorToken);
    assert.equal(r.status, 200);
    const { backup } = (await r.json()) as { backup: { path: string } };
    assert.equal(path.dirname(backup.path), path.join(hub.config.home, 'backups'));
    assert.ok(existsSync(backup.path));
  });

  test('caminho relativo e arquivo existente são recusados', async () => {
    const rel = await post({ out: 'relativo.db' }, hub.operatorToken);
    assert.equal(rel.status >= 400 && rel.status < 500, true);
    const out = path.join(raiz, 'saida', 'b.db'); // já criado acima
    const dup = await post({ out }, hub.operatorToken);
    assert.equal(dup.status >= 400 && dup.status < 500, true);
  });
});
