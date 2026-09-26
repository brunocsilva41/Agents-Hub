import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { AgentDiscovery } from '@agents-hub/core';
import { HubClient, type AgentSummary, type ProbeSummary } from './client.js';
import { avaliarAgentes, doctorCommand, statusCommand } from './doctor-cmd.js';
import { capturar, montarHubDeTeste, type HubDeTeste } from './hub-de-teste.js';

/**
 * Item 4.6 do GOAL (vistoria 2026-09-25, 11 e 14): `doctor`/`status` usam a
 * auth do `discover` e a versão conferida do manifesto para marcar agente
 * quebrado; `doctor --smoke` com teto mínimo, confirmação, um agente por vez
 * e projeto descartável com git. NUNCA sobe agente real: HTTP falso para o
 * veredito e daemon real com agentes FALSOS para o smoke.
 */

function probe(agentId: string, over: Partial<ProbeSummary> = {}): ProbeSummary {
  return { agentId, installed: true, version: '1.2.10', binPath: `/bin/${agentId}`, error: null, checkedAt: '', ...over };
}

function agente(id: string, versaoConferida: string | null = '1.2.10'): AgentSummary {
  return {
    id,
    name: id,
    vendor: 'teste',
    description: '',
    capabilities: [],
    sessionStrategy: 'native',
    streamFormat: 'jsonl',
    caveats: [],
    loginHint: `rode "${id} login"`,
    model: { supported: false, format: '' },
    verified: { status: 'verified', version: versaoConferida, date: '', notes: '' },
    probe: probe(id),
  };
}

function descoberta(agentId: string, auth: 'present' | 'absent' | 'unknown'): AgentDiscovery {
  return {
    agentId,
    installed: true,
    version: null,
    binPath: null,
    auth: { state: auth, evidence: [] },
    defaults: {},
    files: [],
    mcpServers: [],
    instructionFiles: [],
    warnings: [],
  };
}

describe('avaliarAgentes (veredito do doctor/status)', () => {
  test('credencial ausente no discover = quebrado, com a dica de login', () => {
    const [s] = avaliarAgentes([probe('claude')], [agente('claude')], [descoberta('claude', 'absent')]);
    assert.equal(s?.estado, 'quebrado');
    assert.match(s?.motivos.join(' ') ?? '', /nenhuma credencial/);
    assert.equal(s?.dica, 'rode "claude login"');
  });

  test('versão instalada fora da conferida no manifesto = atenção (o caso do Antigravity 1.1.22 x 1.2.6)', () => {
    const [s] = avaliarAgentes(
      [probe('antigravity', { version: '1.2.6' })],
      [agente('antigravity', '1.1.22')],
      [descoberta('antigravity', 'present')],
    );
    assert.equal(s?.estado, 'atencao');
    assert.match(s?.motivos[0] ?? '', /instalada 1\.2\.6, manifesto conferido na 1\.1\.22/);
  });

  test('erro no probe = quebrado; binário ausente = ausente; tudo certo = pronto', () => {
    const r = avaliarAgentes(
      [probe('a', { error: '--version saiu com código 1' }), probe('b', { installed: false }), probe('c', { version: '1.2.99' })],
      [agente('a'), agente('b'), agente('c')],
      [descoberta('a', 'present'), descoberta('c', 'present')],
    );
    const por = new Map(r.map((s) => [s.agentId, s.estado]));
    assert.equal(por.get('a'), 'quebrado');
    assert.equal(por.get('b'), 'ausente');
    assert.equal(por.get('c'), 'pronto', 'patch diferente não é drift');
  });
});

describe('hub status / hub doctor com daemon HTTP falso', () => {
  let server: Server;
  let client: HubClient;

  before(async () => {
    const agents = [agente('claude'), agente('antigravity')];
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (payload: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/health') return send({ ok: true, version: '0.1.0' });
      if (url.pathname === '/agents') return send({ agents });
      if (url.pathname === '/agents/probe') return send({ probes: agents.map((a) => a.probe) });
      if (url.pathname === '/discovery')
        return send({ agents: [descoberta('claude', 'present'), descoberta('antigravity', 'absent')] });
      if (url.pathname === '/sessions') return send({ sessions: [] });
      if (url.pathname === '/approvals') return send({ approvals: [] });
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    client = new HubClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('status conta só os utilizáveis e aponta o quebrado (antes: "2/2 disponíveis")', async () => {
    const c = capturar();
    await statusCommand(client, '/home-falso', { log: c.log });
    const texto = c.texto();
    assert.match(texto, /1\/2 disponíveis/);
    assert.match(texto, /✗ antigravity nenhuma credencial/);
  });

  test('doctor marca o agente sem auth como quebrado e mostra a auth de cada um', async () => {
    const c = capturar();
    const saude = await doctorCommand(client, { command: 'doctor', positional: [], flags: {} }, { home: '/x', log: c.log });
    assert.equal(saude.find((s) => s.agentId === 'antigravity')?.estado, 'quebrado');
    assert.match(c.texto(), /auth presente/);
    assert.match(c.texto(), /sem auth/);
    assert.match(c.texto(), /1 de 2 agentes utilizáveis, 1 quebrado/);
  });
});

describe('hub doctor --smoke (daemon real, agentes FALSOS)', () => {
  let h: HubDeTeste;

  before(async () => {
    h = await montarHubDeTeste(
      [
        { id: 'fake-a', modo: 'lento', sleepMs: 250 },
        { id: 'fake-b', modo: 'lento', sleepMs: 250 },
      ],
      { prefixo: 'hub-cli-smoke-' },
    );
  });

  after(async () => {
    await h.encerrar();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  const smoke = (flags: Record<string, string | boolean> = {}) => ({
    command: 'doctor',
    positional: [],
    flags: { smoke: true, ...flags },
  });

  test('sem terminal e sem --yes: recusa, exit 1, nenhuma sessão aberta', async () => {
    const c = capturar();
    await doctorCommand(h.client, smoke(), { home: h.raiz, log: c.log, interativo: false });
    assert.match(c.texto(), /rode de novo com --yes/);
    assert.equal(process.exitCode, 1);
    assert.equal(h.hub.store.sessions.list().length, 0);
  });

  test('confirmação negada: nenhuma sessão aberta', async () => {
    const c = capturar();
    let perguntou = '';
    await doctorCommand(h.client, smoke(), {
      home: h.raiz,
      log: c.log,
      interativo: true,
      confirmar: async (p) => {
        perguntou = p;
        return false;
      },
    });
    assert.match(perguntou, /Continuar\?/);
    assert.match(c.texto(), /US\$ 0\.10/);
    assert.equal(h.hub.store.sessions.list().length, 0);
  });

  test('--yes: um agente por vez, teto de US$ 0,10 cada, projeto descartável com git e commit', async () => {
    const c = capturar();
    await doctorCommand(h.client, smoke({ yes: true }), {
      home: h.raiz,
      log: c.log,
      smoke: { pollMs: 50, timeoutMs: 20_000 },
    });
    const sessoes = h.hub.store.sessions.list();
    assert.equal(sessoes.length, 2, c.texto());

    // Em série: a segunda só começa depois de a primeira terminar.
    const ordenadas = [...sessoes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    assert.ok(ordenadas[0]?.endedAt, 'a primeira terminou');
    assert.ok((ordenadas[0]?.endedAt ?? '') <= (ordenadas[1]?.createdAt ?? ''), 'sessões não podem se sobrepor');

    for (const s of sessoes) {
      const task = h.hub.store.tasks.list({ sessionId: s.id })[0];
      assert.equal(task?.brief.budget.usd, 0.1, 'teto mínimo por sessão');
      assert.equal(s.isolation, 'worktree');
    }

    const dir = path.join(h.raiz, 'smoke-projeto');
    assert.ok(existsSync(path.join(dir, '.git')));
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
    assert.match(log, /commit inicial/);
    assert.match(c.texto(), /2 de 2 agentes completaram/);
    assert.equal(process.exitCode, undefined);
  });
});
