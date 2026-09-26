import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, newId, nowIso } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Item 6.12 do GOAL: rotas que o painel de Operação usa e que não existiam —
 * editar o teto do fluxo (token de operador), workflow pelo daemon, e a
 * marca `adopted` que decide quem pode ser desanexado.
 *
 * Contra o daemon de verdade (porta própria, home temporário, agente falso em
 * Node que não chama modelo nenhum).
 */

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

let porta = 0;

function http(
  method: string,
  caminho: string,
  opts: { headers?: Record<string, string>; json?: unknown } = {},
): Promise<{ status: number; body: string; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${porta}`, ...(opts.headers ?? {}) };
    const body = opts.json === undefined ? undefined : Buffer.from(JSON.stringify(opts.json));
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const req = request({ host: '127.0.0.1', port: porta, method, path: caminho, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, any> = {};
        try {
          json = JSON.parse(texto) as Record<string, any>;
        } catch {
          /* corpo vazio */
        }
        resolve({ status: res.statusCode ?? 0, body: texto, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('rotas de operação do painel (item 6.12)', () => {
  let raiz: string;
  let hub: Hub;
  let projectId: string;
  const operador = (): Record<string, string> => ({ authorization: `Bearer ${hub.operatorToken}` });

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-operacao-'));
    const projetoDir = path.join(raiz, 'projeto');
    mkdirSync(projetoDir, { recursive: true });
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });

    // Agente falso: não chama modelo; responde e termina.
    const script = path.join(raiz, 'agente-eco.cjs');
    writeFileSync(
      script,
      `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => { process.stdout.write('feito\\n'); process.exit(0); });
`,
      'utf8',
    );
    const esc = script.replace(/\\/g, '\\\\');
    writeFileSync(
      path.join(manifestos, 'agente-eco.yaml'),
      `
id: agente-eco
name: agente-eco
vendor: Test
description: Agente de teste que só responde
bin: node
invoke:
  oneShot: ["${esc}"]
  stdinPrompt: true
  interactive: false
detect:
  args: ["${esc}", "--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 30
`,
      'utf8',
    );

    porta = await portaLivre();
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      port: porta,
      policy: { ...DEFAULT_POLICY, watch: { pauseOn: [], flagOn: [] } },
    });
    await hub.start();
    projectId = hub.sessions.registerProject(projetoDir, 'projeto').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  describe('PUT /budget/:rootId', () => {
    test('sem token: 401 e o teto não muda', async () => {
      const s = hub.sessions.adoptExternal({ agentId: 'agente-eco', projectId, budget: { usd: 1 } });
      const r = await http('PUT', `/budget/${s.id}`, { json: { limits: { usd: 9 } } });
      assert.equal(r.status, 401, r.body);
      assert.equal(hub.sessions.budget(s.id).limits.usd, 1);
    });

    test('com token: sobe e desce o teto, persiste, emite evento e audita', async () => {
      const s = hub.sessions.adoptExternal({ agentId: 'agente-eco', projectId, budget: { usd: 1, tokens: 1000 } });

      const sobe = await http('PUT', `/budget/${s.id}`, { json: { limits: { usd: 7.5 } }, headers: operador() });
      assert.equal(sobe.status, 200, sobe.body);
      assert.equal(sobe.json['budget'].limits.usd, 7.5);
      assert.equal(sobe.json['budget'].limits.tokens, 1000, 'campo ausente fica como estava');

      // Descer também é editar — `raiseLimits` sozinho descartaria a parcela negativa.
      const desce = await http('PUT', `/budget/${s.id}`, { json: { limits: { usd: 0.5, tokens: 400 } }, headers: operador() });
      assert.equal(desce.status, 200, desce.body);
      assert.equal(desce.json['budget'].limits.usd, 0.5);
      assert.equal(desce.json['budget'].limits.tokens, 400);

      const lido = await http('GET', `/budget/${s.id}`);
      assert.equal(lido.json['budget'].limits.usd, 0.5);
      assert.equal(hub.store.budgets.get(s.id)?.limits.usd, 0.5, 'persistido no banco');

      const eventos = hub.sessions.listEvents(s.id).filter((e) => e.type === 'budget.updated');
      assert.equal(eventos.length, 2);

      const trilha = hub.audit.list({ sessionId: s.id, kind: 'budget.updated' });
      assert.equal(trilha.length, 2);
      assert.deepEqual((trilha[0]?.detail as { depois: { usd: number } }).depois.usd, 0.5);
    });

    test('abaixo do já gasto: recusado, e o teto fica', async () => {
      // Sessão-raiz gravada direto no banco, com gasto e reserva, ANTES de o
      // SessionManager carregar o ledger dela — é assim que ele o lê do disco.
      const modelo = hub.sessions.adoptExternal({ agentId: 'agente-eco', projectId });
      const id = newId('ses');
      hub.store.sessions.create({ ...modelo, id, rootId: id });
      hub.store.budgets.upsert({
        rootId: id,
        limits: { usd: 2, tokens: 1000, seconds: 600 },
        consumed: { usd: 1.2, tokens: 0, seconds: 0 },
        // Reserva persistida não entra no ledger recarregado (só as fatias
        // vivas contam) — o piso aqui é o gasto.
        reserved: { usd: 0, tokens: 0, seconds: 0 },
        updatedAt: nowIso(),
      });

      const r = await http('PUT', `/budget/${id}`, { json: { limits: { usd: 1.1 } }, headers: operador() });
      assert.equal(r.status, 400, r.body);
      assert.match(r.body, /usd \(mínimo 1\.2\)/);
      assert.equal(hub.sessions.budget(id).limits.usd, 2);

      const noPiso = await http('PUT', `/budget/${id}`, { json: { limits: { usd: 1.2 } }, headers: operador() });
      assert.equal(noPiso.status, 200, noPiso.body);
    });

    test('sub-sessão não tem teto próprio: recusado', async () => {
      const pai = hub.sessions.adoptExternal({ agentId: 'agente-eco', projectId });
      const id = newId('ses');
      hub.store.sessions.create({ ...pai, id, rootId: pai.id, parentId: pai.id, depth: 1 });
      const r = await http('PUT', `/budget/${id}`, { json: { limits: { usd: 5 } }, headers: operador() });
      assert.equal(r.status, 400, r.body);
      assert.match(r.body, /não é raiz/);
      assert.equal(hub.store.budgets.get(id), null, 'nenhum ledger órfão criado');
    });

    test('sessão inexistente e corpo inválido', async () => {
      const inexistente = await http('PUT', '/budget/ses_naoexiste', { json: { limits: { usd: 1 } }, headers: operador() });
      assert.equal(inexistente.status, 404, inexistente.body);

      const s = hub.sessions.adoptExternal({ agentId: 'agente-eco', projectId });
      const vazio = await http('PUT', `/budget/${s.id}`, { json: { limits: {} }, headers: operador() });
      assert.equal(vazio.status, 422, vazio.body);
      const negativo = await http('PUT', `/budget/${s.id}`, { json: { limits: { usd: -1 } }, headers: operador() });
      assert.equal(negativo.status, 422, negativo.body);
    });
  });

  describe('adopted/detach', () => {
    test('GET /sessions marca `adopted`; detach recusa sessão comum e aceita a adotada', async () => {
      const adotada = hub.sessions.adoptExternal({ agentId: 'agente-eco', projectId });
      const { session: comum } = await hub.sessions.start({
        projectId,
        agentId: '',
        brief: { agent: 'agente-eco', objective: 'responder uma saudação simples de teste', isolation: 'none' },
      });

      const lista = await http('GET', '/sessions');
      const porId = new Map((lista.json['sessions'] as Array<{ id: string; adopted: boolean }>).map((s) => [s.id, s]));
      assert.equal(porId.get(adotada.id)?.adopted, true);
      assert.equal(porId.get(comum.id)?.adopted, false);
      assert.equal((await http('GET', `/sessions/${adotada.id}`)).json['session'].adopted, true);

      const recusa = await http('POST', `/sessions/${comum.id}/detach`, { json: {} });
      assert.equal(recusa.status, 400, recusa.body);
      assert.match(recusa.body, /não foi adotada/);
      assert.notEqual(hub.sessions.getSession(comum.id).state, 'completed', 'estado não foi forjado');

      const ok = await http('POST', `/sessions/${adotada.id}/detach`, { json: {} });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(hub.sessions.getSession(adotada.id).state, 'completed');

      const deNovo = await http('POST', `/sessions/${adotada.id}/detach`, { json: {} });
      assert.equal(deNovo.status, 400, 'já desanexada');
    });
  });

  describe('/workflows', () => {
    test('validate: válido com lotes; inválido com erros', async () => {
      const ok = await http('POST', '/workflows/validate', {
        json: { yaml: 'name: w\nsteps:\n  - { id: a, agent: agente-eco, objective: fazer a primeira parte }\n  - { id: b, agent: agente-eco, objective: fazer a segunda parte, dependsOn: [a] }\n' },
      });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json['valid'], true);
      assert.deepEqual(ok.json['executionOrder'], [['a'], ['b']]);
      assert.equal(ok.json['parsed'], undefined, 'o objeto interno não vaza');

      const ruim = await http('POST', '/workflows/validate', { json: { yaml: 'name: w\nsteps: []\n' } });
      assert.equal(ruim.status, 200);
      assert.equal(ruim.json['valid'], false);
      assert.ok((ruim.json['errors'] as string[]).length > 0);
    });

    test('runs: dispara no daemon, encadeia e termina; projeto inexistente é 404', async () => {
      const nada = await http('POST', '/workflows/runs', {
        json: { yaml: 'name: w\nsteps:\n  - { id: a, agent: agente-eco, objective: x }\n', projectId: 'prj_naoexiste' },
      });
      assert.equal(nada.status, 404, nada.body);

      const r = await http('POST', '/workflows/runs', {
        json: {
          yaml: 'name: w\nsteps:\n  - { id: a, agent: agente-eco, objective: fazer a primeira parte, isolation: none }\n  - { id: b, agent: agente-eco, objective: fazer a segunda parte, dependsOn: [a], isolation: none }\n',
          projectId,
          budgetUsd: 1,
        },
      });
      assert.equal(r.status, 201, r.body);
      const id = r.json['run'].id as string;

      let run: Record<string, any> = r.json['run'];
      const limite = Date.now() + 30_000;
      while (run['state'] === 'running' && Date.now() < limite) {
        await new Promise((res) => setTimeout(res, 250));
        run = (await http('GET', `/workflows/runs/${id}`)).json['run'];
      }
      assert.equal(run['state'], 'completed', JSON.stringify(run));
      const [a, b] = run['steps'] as Array<{ state: string; sessionId: string }>;
      assert.equal(a?.state, 'completed');
      assert.equal(b?.state, 'completed');
      // `b` só nasceu depois de `a` terminar.
      const sa = hub.sessions.getSession(a!.sessionId);
      const sb = hub.sessions.getSession(b!.sessionId);
      assert.ok(sb.createdAt >= (sa.endedAt ?? ''), `${sb.createdAt} >= ${sa.endedAt}`);

      const lista = await http('GET', '/workflows/runs');
      assert.ok((lista.json['runs'] as Array<{ id: string }>).some((x) => x.id === id));
      assert.equal((await http('GET', '/workflows/runs/wfr_naoexiste')).status, 404);
      assert.equal((await http('GET', '/workflows/runs/..%2Fshutdown')).status, 400);
    });
  });
});
