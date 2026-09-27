import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub, type Hub } from './hub.js';

/**
 * Vistoria 2026-09-25: R13-19 (aprovação inexistente era ILLEGAL_STATE/400) e
 * R02-12 (POST sem corpo e sem Content-Type levava 415).
 *
 * Socket cru de propósito: `http.request` do Node acrescenta
 * `Content-Length`/`Transfer-Encoding` sozinho, e o caso do R02-12 é
 * exatamente a requisição SEM nenhum dos dois (o `curl -X POST` sem `-d`).
 */
describe('códigos HTTP de aprovação e POST sem corpo', () => {
  let raiz: string;
  let hub: Hub;
  let porta = 0;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-codigos-http-'));
    const home = path.join(raiz, 'home');
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(home, { recursive: true });
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({ home, manifestsDir: manifestos, port: 0 });
    porta = (await hub.start()).port;
  });

  after(async () => {
    await hub.shutdown();
    rmSync(raiz, { recursive: true, force: true });
  });

  function cru(linhas: string[], corpo = ''): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const sock = connect(porta, '127.0.0.1');
      let bruto = '';
      sock.setEncoding('utf8');
      sock.on('data', (d: string) => (bruto += d));
      sock.on('error', reject);
      sock.on('end', () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(bruto)?.[1] ?? 0);
        resolve({ status, body: bruto.slice(bruto.indexOf('\r\n\r\n') + 4) });
      });
      sock.write(
        [...linhas, `Host: 127.0.0.1:${porta}`, 'Connection: close', '', ''].join('\r\n') + corpo,
      );
    });
  }

  test('GET de aprovação inexistente: 404 APPROVAL_NOT_FOUND', async () => {
    const r = await cru(['GET /approvals/apv_naoexiste HTTP/1.1']);
    assert.equal(r.status, 404, r.body);
    assert.match(r.body, /APPROVAL_NOT_FOUND/);
  });

  test('decidir aprovação inexistente: 404 APPROVAL_NOT_FOUND', async () => {
    const corpo = JSON.stringify({ decision: 'approved' });
    const r = await cru(
      [
        'POST /approvals/apv_naoexiste HTTP/1.1',
        `Authorization: Bearer ${hub.operatorToken}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(corpo)}`,
      ],
      corpo,
    );
    assert.equal(r.status, 404, r.body);
    assert.match(r.body, /APPROVAL_NOT_FOUND/);
  });

  test('POST sem corpo e sem Content-Type chega à rota (404 da sessão, não 415)', async () => {
    const r = await cru([
      'POST /sessions/ses_naoexiste/cancel HTTP/1.1',
      `Authorization: Bearer ${hub.operatorToken}`,
    ]);
    assert.notEqual(r.status, 415, r.body);
    assert.equal(r.status, 404, r.body);
    assert.match(r.body, /SESSION_NOT_FOUND/);
  });

  test('POST com corpo e sem Content-Type continua 415', async () => {
    const r = await cru(
      [
        'POST /sessions/ses_naoexiste/cancel HTTP/1.1',
        `Authorization: Bearer ${hub.operatorToken}`,
        'Content-Length: 2',
      ],
      '{}',
    );
    assert.equal(r.status, 415, r.body);
  });
});
