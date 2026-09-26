import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { HubClient, InvalidHubIdError, isHubId } from './index.js';

/**
 * Servidor HTTP falso que só registra o caminho de cada requisição recebida.
 * Responde 200 `{ ok: true }` a tudo — inclusive a `/shutdown`, como o daemon
 * de verdade: é justamente por isso que o traversal passava por sucesso.
 */
describe('client: ids no caminho não viram path traversal', () => {
  let server: Server;
  let client: HubClient;
  const recebidos: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      recebidos.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endereco = server.address();
    const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
    client = new HubClient(`http://127.0.0.1:${porta}`);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    recebidos.length = 0;
  });

  test("cancel('../shutdown#') rejeita sem fazer requisição nenhuma", async () => {
    await assert.rejects(client.cancel('../shutdown#'), InvalidHubIdError);
    assert.deepEqual(recebidos, [], 'nenhuma requisição deveria ter saído — muito menos POST /shutdown');
  });

  test('toda rota com id recusa formato inválido antes da requisição', async () => {
    const lixos = ['../shutdown#', '..%2Fshutdown', 'ses_../x', 'ses_a/b', 'ses_a?x=1', '', 'xyz_123'];
    const chamadas: Array<(id: string) => Promise<unknown>> = [
      (id) => client.session(id),
      (id) => client.detach(id),
      (id) => client.delegate(id, { agent: 'x', objective: 'y' }),
      (id) => client.send(id, 'oi'),
      (id) => client.interrupt(id),
      (id) => client.pause(id),
      (id) => client.cancel(id),
      (id) => client.handoff(id, 'codex'),
      (id) => client.task(id),
      (id) => client.diff(id),
      (id) => client.artifacts(id),
      (id) => client.tasks(id),
      (id) => client.approval(id),
      (id) => client.resolveApproval(id, 'approved'),
      (id) => client.events(id),
      (id) => client.folders(id),
      (id) => client.addFolder(id, 'C:/x'),
      (id) => client.removeFolder('prj_abc', id),
      (id) => client.removeFolder(id, 'pfd_abc'),
      (id) => client.projectContext(id),
      (id) => client.saveProjectContext(id, {} as never),
      (id) => client.graph(id),
      (id) => client.budget(id),
    ];
    for (const chamada of chamadas) {
      for (const lixo of lixos) {
        // Rejeição (promessa), não exceção síncrona: `.catch()` de quem chama pega.
        const p = chamada(lixo);
        assert.ok(p instanceof Promise);
        await assert.rejects(p, InvalidHubIdError, `deveria recusar ${JSON.stringify(lixo)}`);
      }
    }
    assert.deepEqual(recebidos, []);
  });

  test('id válido chega intacto, codificado como segmento único', async () => {
    await client.cancel('ses_dd3b39062941461faea543eb');
    await client.task('tsk_123456');
    await client.approval('apv_abc');
    await client.budget('ses_raiz1');
    await client.removeFolder('prj_abc', 'pfd_prj_abc');
    assert.deepEqual(recebidos, [
      'POST /sessions/ses_dd3b39062941461faea543eb/cancel',
      'GET /tasks/tsk_123456',
      'GET /approvals/apv_abc',
      'GET /budget/ses_raiz1',
      'DELETE /projects/prj_abc/folders/pfd_prj_abc',
    ]);
  });

  test('prefixo de um tipo não serve como id de outro', () => {
    assert.equal(isHubId('ses_abc', 'ses'), true);
    assert.equal(isHubId('ses_abc', 'apv'), false);
    assert.equal(isHubId('pfd_prj_abc', 'pfd'), true, 'formato histórico da migração 2');
    assert.equal(isHubId(`ses_${'a'.repeat(61)}`, 'ses'), false, 'tamanho tem teto');
  });
});
