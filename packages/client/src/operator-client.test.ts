import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HubClient } from './index.js';
import { operatorTokenFile, readOperatorToken } from './operator-token.js';

/** Item 1.6: o cliente manda o token de operador e não declara mais `by`. */
describe('HubClient com token de operador', () => {
  const recebidas: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];
  let base = '';
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      recebidas.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ approval: {}, entries: [], policy: {} }));
    });
  });

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test('token (inclusive como função, lida a cada chamada) vai em Authorization: Bearer', async () => {
    let atual = 'a'.repeat(64);
    const client = new HubClient(base, { token: () => atual });
    await client.resolveApproval('apv_abc', 'approved');
    atual = 'b'.repeat(64);
    await client.setGlobalPolicy({ maxDepth: 2 });
    await client.audit({ since: '2h', projectId: 'prj_x' });

    assert.equal(recebidas[0]?.auth, `Bearer ${'a'.repeat(64)}`);
    assert.deepEqual(JSON.parse(recebidas[0].body), { decision: 'approved' }, 'sem `by` no corpo');
    assert.equal(recebidas[1]?.method, 'PUT');
    assert.equal(recebidas[1]?.url, '/policy');
    assert.equal(recebidas[1]?.auth, `Bearer ${'b'.repeat(64)}`);
    assert.equal(recebidas[2]?.url, '/audit?since=2h&projectId=prj_x');
  });

  test('sem token (navegador/MCP/hook): nenhum Authorization', async () => {
    recebidas.length = 0;
    await new HubClient(base).approvals();
    assert.equal(recebidas[0]?.auth, undefined);
  });
});

describe('readOperatorToken', () => {
  let home: string;
  before(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'hub-client-token-'));
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  test('lê o arquivo do home; ausente ou malformado é null', () => {
    assert.equal(readOperatorToken(home), null);
    writeFileSync(operatorTokenFile(home), 'nao-e-token\n');
    assert.equal(readOperatorToken(home), null);
    const t = 'c'.repeat(64);
    writeFileSync(operatorTokenFile(home), `${t}\n`);
    assert.equal(readOperatorToken(home), t);
  });
});
