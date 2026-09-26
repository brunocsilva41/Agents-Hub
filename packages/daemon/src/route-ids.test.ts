import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub, type Hub } from './hub.js';

/** Ver `sse-http.test.ts`: a guarda compara o Host contra a porta configurada. */
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
 * `fetch` normaliza `..` e corta `#` — exatamente o que fazia o traversal
 * funcionar no client. Aqui o caminho vai CRU, byte a byte, para exercitar o
 * que o roteador do daemon recebe de um chamador qualquer.
 */
function cru(
  porta: number,
  method: string,
  caminho: string,
): Promise<{ status: number; body: { error?: { code?: string } } }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: porta,
        method,
        path: caminho,
        headers: { Host: `127.0.0.1:${porta}` },
      },
      (res) => {
        let texto = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (texto += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: texto ? JSON.parse(texto) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('daemon: id malformado em parâmetro de rota é 400, não 404', () => {
  let raiz: string;
  let hub: Hub;
  let porta: number;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-route-ids-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    porta = await portaLivre();
    hub = createHub({ home: path.join(raiz, 'home'), manifestsDir: manifestos, port: porta });
    await hub.start();
  });

  after(async () => {
    await hub.shutdown();
    rmSync(raiz, { recursive: true, force: true });
  });

  // Rotas que antes passavam o parâmetro direto ao domínio, sem validar: o
  // desfecho era um 404 "não encontrado" (ou 200 com lista vazia) que
  // escondia a entrada torta.
  const casos: Array<[string, string]> = [
    ['GET', '/sessions/ses_..'],
    ['GET', '/sessions/lixo'],
    ['POST', '/sessions/lixo/detach'],
    ['POST', '/sessions/lixo/pause'],
    ['GET', '/sessions/lixo/tasks'],
    ['GET', '/approvals/lixo'],
    ['GET', '/graph/lixo'],
    ['GET', '/budget/lixo'],
    ['DELETE', '/projects/prj_abc/folders/lixo'],
    ['POST', '/sessions/..%2Fshutdown%23/cancel'],
    ['GET', '/tasks/ses_trocado'],
  ];

  for (const [method, caminho] of casos) {
    test(`${method} ${caminho} → 400 INVALID_ID`, async () => {
      const { status, body } = await cru(porta, method, caminho);
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(body.error?.code, 'INVALID_ID');
    });
  }

  test('segmento mal codificado (%E0) é 400 e o daemon continua de pé', async () => {
    const { status, body } = await cru(porta, 'GET', '/sessions/%E0');
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.error?.code, 'MALFORMED_URL');
    const saude = await cru(porta, 'GET', '/health');
    assert.equal(saude.status, 200);
  });

  test('id bem formado mas inexistente continua sendo 404 do domínio', async () => {
    const { status } = await cru(porta, 'GET', '/sessions/ses_naoexiste000');
    assert.equal(status, 404);
  });

  test('pasta no formato histórico da migração (pfd_prj_...) passa a validação', async () => {
    const { body } = await cru(porta, 'DELETE', '/projects/prj_abc/folders/pfd_prj_abc');
    assert.notEqual(body.error?.code, 'INVALID_ID');
  });
});
