import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub, type Hub } from './hub.js';

/**
 * Item 4.3 do GOAL: o `/agents` diz, por agente, se o CLI aceita modelo por
 * invocação (`model.supported`) e contra qual versão o manifesto foi
 * conferido (`verified`) — é o dado que o painel e a CLI usam para NÃO
 * oferecer "Modelo" onde o valor não chegaria ao agente.
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

const COM_MODELO = `id: com-modelo
name: Com modelo
bin: hub-bin-inexistente-a
invoke:
  oneShot: ["-p"]
model:
  supported: true
  args: ["--model", "{{model}}"]
  format: "provider/model"
verified:
  status: verified
  version: "1.2.3"
  date: "2026-09-26"
`;

const SEM_MODELO = `id: sem-modelo
name: Sem modelo
bin: hub-bin-inexistente-b
invoke:
  oneShot: ["-p"]
`;

describe('GET /agents expõe suporte a modelo e verificação do manifesto', () => {
  let raiz: string;
  let hub: Hub;
  let porta: number;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-agents-model-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    writeFileSync(path.join(manifestos, 'a.yaml'), COM_MODELO);
    writeFileSync(path.join(manifestos, 'b.yaml'), SEM_MODELO);
    porta = await portaLivre();
    hub = createHub({ home: path.join(raiz, 'home'), manifestsDir: manifestos, port: porta });
    await hub.start();
  });

  after(async () => {
    await hub.shutdown();
    rmSync(raiz, { recursive: true, force: true });
  });

  test('model.supported/format e verified por agente', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/agents`);
    assert.equal(res.status, 200);
    const { agents } = (await res.json()) as {
      agents: Array<{ id: string; model: unknown; verified: unknown }>;
    };
    const porId = new Map(agents.map((a) => [a.id, a]));
    assert.deepEqual(porId.get('com-modelo')?.model, { supported: true, format: 'provider/model' });
    assert.deepEqual(porId.get('com-modelo')?.verified, {
      status: 'verified',
      version: '1.2.3',
      date: '2026-09-26',
      notes: '',
    });
    // Sem declaração: sem suporte e não verificado — nunca "sim" por omissão.
    assert.deepEqual(porId.get('sem-modelo')?.model, { supported: false, format: '' });
    assert.equal((porId.get('sem-modelo')?.verified as { status: string }).status, 'unverified');
  });
});
