import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, newId, nowIso, type Approval } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';
import { operatorTokenPath } from './operator-auth.js';

/**
 * Item 1.6 do GOAL (achado ALTO da vistoria 05): "qualquer processo local,
 * inclusive o agente gateado, pode aprovar as próprias aprovações", e `by`
 * era texto livre do corpo.
 *
 * Contra o daemon de verdade (porta própria, home temporário). Mede:
 * sem token -> 401; token errado -> 401; token certo -> 200; `by` do corpo
 * ignorado (vem da origem autenticada); a Web UI recebe o token por cookie
 * HttpOnly ao carregar `/`; e o ambiente do agente NÃO contém o token.
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

interface Resposta {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let porta = 0;

function http(
  method: string,
  caminho: string,
  opts: { headers?: Record<string, string>; json?: unknown } = {},
): Promise<Resposta> {
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
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('token de operador (item 1.6)', () => {
  let raiz: string;
  let hub: Hub;
  let projetoDir: string;
  let projectId: string;
  let envDump: string;
  const usuario = os.userInfo().username;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-operator-auth-'));
    projetoDir = path.join(raiz, 'projeto');
    mkdirSync(projetoDir, { recursive: true });
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    envDump = path.join(raiz, 'env-do-agente.json');

    // Agente falso: não chama modelo; grava o PRÓPRIO ambiente e termina.
    const script = path.join(raiz, 'agente-env.cjs');
    writeFileSync(
      script,
      `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));
  process.stdout.write('OK\\n');
  process.exit(0);
});
`,
      'utf8',
    );
    const esc = script.replace(/\\/g, '\\\\');
    writeFileSync(
      path.join(manifestos, 'agente-env.yaml'),
      `
id: agente-env
name: agente-env
vendor: Test
description: Agente de teste que despeja o ambiente
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

  /** Aprovação pendente de verdade no banco, numa sessão adotada. */
  function aprovacaoPendente(): Approval {
    const session = hub.sessions.adoptExternal({ agentId: 'agente-env', projectId });
    const approval: Approval = {
      id: newId('apv'),
      sessionId: session.id,
      taskId: null,
      risk: 'irreversible',
      action: 'Bash: git push --force',
      detail: { kind: 'tool-call', tool: 'Bash' },
      state: 'pending',
      requestedAt: nowIso(),
      resolvedAt: null,
      resolvedBy: null,
    };
    hub.store.approvals.create(approval);
    return approval;
  }

  const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

  test('o daemon cria <home>/operator-token, 64 hex, restrito ao usuário', () => {
    const arquivo = operatorTokenPath(hub.config.home);
    assert.ok(existsSync(arquivo));
    assert.equal(readFileSync(arquivo, 'utf8').trim(), hub.operatorToken);
    assert.match(hub.operatorToken, /^[0-9a-f]{64}$/);
    if (process.platform === 'win32') {
      // Sem ACE herdada ("(I)"): só o que foi concedido explicitamente ao usuário.
      const acl = execFileSync('icacls', [arquivo], { encoding: 'utf8' });
      assert.doesNotMatch(acl, /\(I\)/, acl);
      assert.match(acl, new RegExp(usuario.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), acl);
    } else {
      assert.equal(statSync(arquivo).mode & 0o777, 0o600);
    }
  });

  const protegidas: Array<[string, () => string, unknown]> = [
    ['POST', () => `/approvals/${newId('apv')}`, { decision: 'approved' }],
    ['POST', () => '/shutdown', {}],
    ['PUT', () => `/projects/${projectId}/context`, { memory: 'x' }],
    ['POST', () => `/projects/${projectId}/trust`, { trusted: true }],
    ['POST', () => `/projects/${projectId}/import`, { agentId: 'claude', kinds: ['env'] }],
    ['POST', () => `/projects/${projectId}/folders`, { path: 'C:/qualquer' }],
    ['DELETE', () => `/projects/${projectId}/folders/pfd_abc`, undefined],
    ['POST', () => '/maintenance/sweep', {}],
    ['PUT', () => '/policy', { policy: {} }],
    ['PUT', () => `/projects/${projectId}/policy`, { policy: {} }],
  ];

  for (const [method, caminho, json] of protegidas) {
    test(`${method} ${caminho().replace(/(prj|apv)_[a-z0-9]+|undefined/g, ':id')}: sem token e com token errado -> 401`, async () => {
      const semToken = await http(method, caminho(), { json });
      assert.equal(semToken.status, 401, semToken.body);
      assert.match(semToken.body, /UNAUTHORIZED/);
      assert.match(String(semToken.headers['www-authenticate']), /Bearer/);

      const errado = await http(method, caminho(), { json, headers: bearer('0'.repeat(64)) });
      assert.equal(errado.status, 401, errado.body);

      const erradoHeader = await http(method, caminho(), {
        json,
        headers: { 'x-hub-token': `${hub.operatorToken.slice(0, 63)}0` },
      });
      assert.equal(erradoHeader.status, 401, erradoHeader.body);

      const cookieErrado = await http(method, caminho(), {
        json,
        headers: { cookie: `hub_operator=${'f'.repeat(64)}` },
      });
      assert.equal(cookieErrado.status, 401, cookieErrado.body);
    });
  }

  test('o daemon continua de pé depois de POST /shutdown sem token', async () => {
    assert.equal((await http('POST', '/shutdown', { json: {} })).status, 401);
    assert.equal((await http('GET', '/health')).status, 200);
  });

  test('aprovação: sem token 401 e segue pendente; com token 200 e `by` do corpo é ignorado', async () => {
    const apv = aprovacaoPendente();
    const corpo = { decision: 'denied', by: 'Administrador (spoofed)' };

    const negado = await http('POST', `/approvals/${apv.id}`, { json: corpo });
    assert.equal(negado.status, 401, negado.body);
    assert.equal(hub.store.approvals.get(apv.id)?.state, 'pending', 'sem token nada muda');

    const ok = await http('POST', `/approvals/${apv.id}`, { json: corpo, headers: bearer(hub.operatorToken) });
    assert.equal(ok.status, 200, ok.body);
    const resolvida = (JSON.parse(ok.body) as { approval: Approval }).approval;
    assert.equal(resolvida.state, 'denied');
    assert.equal(resolvida.resolvedBy, `cli:${usuario}`, 'by vem da origem autenticada');
    assert.notEqual(hub.store.approvals.get(apv.id)?.resolvedBy, 'Administrador (spoofed)');

    // A auditoria registra o mesmo autor, não o do corpo.
    const trilha = hub.audit.list({ sessionId: apv.sessionId, kind: 'approval.resolved' });
    assert.equal(trilha[0]?.actor, `cli:${usuario}`);
  });

  test('X-Hub-Token também autentica', async () => {
    const apv = aprovacaoPendente();
    const ok = await http('POST', `/approvals/${apv.id}`, {
      json: { decision: 'denied' },
      headers: { 'x-hub-token': hub.operatorToken },
    });
    assert.equal(ok.status, 200, ok.body);
  });

  test('Web UI: carregar `/` no navegador entrega cookie HttpOnly SameSite=Strict, que autentica como `web`', async () => {
    const navegador = {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    };
    const pagina = await http('GET', '/', { headers: navegador });
    assert.equal(pagina.status, 200);
    const setCookie = String(pagina.headers['set-cookie'] ?? '');
    assert.match(setCookie, new RegExp(`hub_operator=${hub.operatorToken}`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    // `curl` / `fetch` sem cabeçalhos de navegação não ganham o cookie.
    assert.equal((await http('GET', '/')).headers['set-cookie'], undefined);
    assert.equal(
      (await http('GET', '/', { headers: { ...navegador, 'sec-fetch-site': 'cross-site' } })).headers['set-cookie'],
      undefined,
    );
    // Rota de API nunca devolve o cookie.
    assert.equal((await http('GET', '/health', { headers: navegador })).headers['set-cookie'], undefined);

    const apv = aprovacaoPendente();
    const ok = await http('POST', `/approvals/${apv.id}`, {
      json: { decision: 'denied', by: 'qualquer um' },
      headers: {
        cookie: `outro=1; hub_operator=${hub.operatorToken}`,
        origin: `http://127.0.0.1:${porta}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(ok.status, 200, ok.body);
    assert.equal((JSON.parse(ok.body) as { approval: Approval }).approval.resolvedBy, 'web');
  });

  test('rota de leitura segue sem token (GET /approvals, /policy, /audit)', async () => {
    for (const rota of ['/approvals', '/policy', '/audit']) {
      assert.equal((await http('GET', rota)).status, 200, rota);
    }
  });

  test('o ambiente do agente NÃO contém o token de operador', async () => {
    rmSync(envDump, { force: true });
    const started = await hub.sessions.start({
      projectId,
      agentId: 'agente-env',
      brief: {
        agent: 'agente-env',
        objective: 'despejar o ambiente',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });
    const limite = Date.now() + 20_000;
    while (!existsSync(envDump)) {
      if (Date.now() > limite) throw new Error('o agente de teste não gravou o ambiente');
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100));
    const bruto = readFileSync(envDump, 'utf8');
    const env = JSON.parse(bruto) as Record<string, string>;

    // Prova de que é o ambiente montado pelo Hub para ESTA sessão.
    assert.equal(env['AGENTS_HUB_SESSION_ID'], started.session.id);
    assert.ok(!bruto.includes(hub.operatorToken), 'o token não pode aparecer em nenhuma variável');
    assert.ok(
      !Object.keys(env).some((k) => /OPERATOR|HUB_TOKEN/i.test(k)),
      'nenhuma variável de token de operador',
    );
  });
});
