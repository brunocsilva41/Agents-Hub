import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentDiscovery } from '@agents-hub/core';
import { HubClient, type AgentSummary, type ProbeSummary } from './client.js';
import {
  avaliarAgentes,
  diagnosticarConfig,
  doctorCommand,
  doctorDaConfig,
  statusCommand,
} from './doctor-cmd.js';
import { capturar, montarHubDeTeste, portaLivre, type HubDeTeste } from './hub-de-teste.js';

/**
 * Item 4.6 do GOAL (vistoria 2026-09-25, 11 e 14): `doctor`/`status` usam a
 * auth do `discover` e a versão conferida do manifesto para marcar agente
 * quebrado; `doctor --smoke` com teto mínimo, confirmação, um agente por vez
 * e projeto descartável com git. NUNCA sobe agente real: HTTP falso para o
 * veredito e daemon real com agentes FALSOS para o smoke.
 */

function probe(agentId: string, over: Partial<ProbeSummary> = {}): ProbeSummary {
  return {
    agentId,
    installed: true,
    version: '1.2.10',
    binPath: `/bin/${agentId}`,
    error: null,
    checkedAt: '',
    ...over,
  };
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
      [
        probe('a', { error: '--version saiu com código 1' }),
        probe('b', { installed: false }),
        probe('c', { version: '1.2.99' }),
      ],
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
    const saude = await doctorCommand(
      client,
      { command: 'doctor', positional: [], flags: {} },
      { home: '/x', log: c.log },
    );
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
    assert.ok(
      (ordenadas[0]?.endedAt ?? '') <= (ordenadas[1]?.createdAt ?? ''),
      'sessões não podem se sobrepor',
    );

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

/**
 * Pendência D do fechamento: chave desconhecida em `policy` no config.json
 * GLOBAL impede o daemon de subir (intencional, R09-12). O `hub doctor` tem
 * de apontar arquivo e campo ANTES — e antes ele morria com stack trace no
 * `loadConfig` do `main`. Tudo em HOME/AGENTS_HUB_HOME temporários: o
 * ~/.agents-hub real nunca é lido nem tocado.
 */
describe('hub doctor × config.json global inválido', () => {
  let raiz: string;
  let hubHome: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-doctor-config-'));
    hubHome = path.join(raiz, 'hub');
    mkdirSync(hubHome, { recursive: true });
  });

  after(() => {
    rmSync(raiz, { recursive: true, force: true });
  });

  const gravar = (conteudo: unknown): void =>
    writeFileSync(
      path.join(hubHome, 'config.json'),
      typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo),
    );
  const env = (): NodeJS.ProcessEnv => ({ AGENTS_HUB_HOME: hubHome });

  test('aponta arquivo e campo, sugere a chave certa e diz que o daemon não sobe', () => {
    gravar({ policy: { maxDepht: 3, validation: { review: { agnt: 'x' } } } });
    const d = diagnosticarConfig(env());
    assert.equal(d.arquivo, path.join(hubHome, 'config.json'));
    assert.deepEqual(d.problemas.map((p) => [p.campo, p.problema, p.dica]).sort(), [
      ['policy.maxDepht', 'chave desconhecida', 'você quis dizer "policy.maxDepth"?'],
      [
        'policy.validation.review.agnt',
        'chave desconhecida',
        'você quis dizer "policy.validation.review.agent"?',
      ],
    ]);

    const c = capturar();
    assert.equal(doctorDaConfig({ log: c.log, env: env() }), false);
    assert.match(c.texto(), /config\.json global inválido/);
    assert.match(c.texto(), /o daemon NÃO sobe/);
    assert.ok(c.texto().includes(path.join(hubHome, 'config.json')));
    assert.match(c.texto(), /policy\.maxDepht: chave desconhecida/);
  });

  test('chave sem parecida lista as aceitas; erro fora de policy e JSON quebrado também são apontados', () => {
    gravar({ port: 70000, policy: { commands: { permitir: [] } } });
    const d = diagnosticarConfig(env());
    const porCampo = new Map(d.problemas.map((p) => [p.campo, p]));
    assert.equal(
      porCampo.get('policy.commands.permitir')?.dica,
      'chaves aceitas em policy.commands: allow, deny',
    );
    assert.match(porCampo.get('port')?.problema ?? '', /65535/);

    gravar('{ "policy": { "maxDepth": 3, } }');
    const quebrado = diagnosticarConfig(env());
    assert.equal(quebrado.problemas[0]?.campo, '(arquivo)');
    assert.match(quebrado.problemas[0]?.problema ?? '', /não é JSON válido/);
  });

  test('config válida (ou ausente) passa com ✓', () => {
    gravar({ policy: { maxDepth: 2 } });
    const c = capturar();
    assert.equal(doctorDaConfig({ log: c.log, env: env() }), true);
    assert.match(c.texto(), /✓ config\.json/);
  });

  test('`hub doctor` de verdade: explica e sai 1, sem stack trace e sem falar com daemon', async () => {
    gravar({ policy: { maxDepht: 3 } });
    const casa = path.join(raiz, 'casa');
    mkdirSync(casa, { recursive: true });
    const limpo: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(limpo)) {
      if (/^(AGENTS_HUB_|NODE_OPTIONS$)/.test(k)) delete limpo[k];
    }
    const r = spawnSync(
      process.execPath,
      ['--experimental-sqlite', fileURLToPath(new URL('./main.js', import.meta.url)), 'doctor'],
      {
        env: {
          ...limpo,
          HOME: casa,
          USERPROFILE: casa,
          AGENTS_HUB_HOME: hubHome,
          // Porta livre e sem autostart: se o doctor tentasse o daemon, falharia
          // aqui — nunca na 4747 do usuário.
          AGENTS_HUB_PORT: String(await portaLivre()),
          AGENTS_HUB_NO_AUTOSTART: '1',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /policy\.maxDepht: chave desconhecida/);
    assert.match(r.stdout, /você quis dizer "policy\.maxDepth"\?/);
    assert.doesNotMatch(r.stderr, /at loadConfig|HubError:/);
    assert.doesNotMatch(r.stdout, /checando agentes/);
  });
});
