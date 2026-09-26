import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createServer } from 'node:net';
import { DEFAULT_POLICY, type AuditEntry, type AuditFilter } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';
import { instanteDoFiltro } from './operator-routes.js';
import { PROJECT_CONFIG_RELATIVE } from './project-config.js';
import type { PolicyView, ProjectPolicyView } from './policy-service.js';

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

class HttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
  }
}

/**
 * Cliente mínimo com o mesmo contrato das rotas que o `HubClient` usa (o
 * daemon não depende do pacote do cliente; o cliente tem os próprios testes).
 */
class Api {
  constructor(private readonly base: string, private readonly token?: () => string) {}

  async #call<T>(method: string, caminho: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token()}`;
    const res = await fetch(`${this.base}${caminho}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const texto = await res.text();
    if (!res.ok) throw new HttpError(res.status, texto);
    return JSON.parse(texto) as T;
  }

  policy(projectId?: string): Promise<{ policy: PolicyView }> {
    return this.#call('GET', `/policy${projectId ? `?projectId=${projectId}` : ''}`);
  }
  setGlobalPolicy(layer: unknown): Promise<{ policy: PolicyView; loosened: string[] }> {
    return this.#call('PUT', '/policy', { policy: layer });
  }
  setProjectPolicy(
    projectId: string,
    layer: unknown,
  ): Promise<{ project: ProjectPolicyView; clamped: string[]; ignoredExecFields: string[] }> {
    return this.#call('PUT', `/projects/${projectId}/policy`, { policy: layer });
  }
  setProjectTrusted(projectId: string, trusted: boolean): Promise<unknown> {
    return this.#call('POST', `/projects/${projectId}/trust`, { trusted });
  }
  audit(q: AuditFilter & { since?: string; until?: string } = {}): Promise<{ entries: AuditEntry[] }> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return this.#call('GET', `/audit${p.size > 0 ? `?${p.toString()}` : ''}`);
  }
  gateToolCall(body: unknown): Promise<{ decision: string }> {
    return this.#call('POST', '/hooks/pretooluse', body);
  }
}

const HubApiError = HttpError;

/**
 * Item 1.10 do GOAL: editar política (global e por projeto) pela API/CLI com a
 * validação do schema e o MESMO clamp do item 0.7 na camada de projeto; e a
 * trilha de auditoria consultável por `GET /audit`.
 *
 * Pelo `HubClient` de verdade (o mesmo da CLI e do painel), contra o daemon
 * numa porta própria e home temporário.
 */
describe('editor de política e auditoria (item 1.10)', () => {
  let raiz: string;
  let hub: Hub;
  let operador: Api;
  let anonimo: Api;
  let projetoDir: string;
  let projectId: string;
  const usuario = os.userInfo().username;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-policy-audit-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    // Agente só para ser adotado (sessão-raiz sem processo): nunca é lançado.
    writeFileSync(
      path.join(manifestos, 'agente-x.yaml'),
      `
id: agente-x
name: agente-x
vendor: Test
description: Agente de teste
bin: node
invoke:
  oneShot: ["-e", "0"]
  stdinPrompt: true
  interactive: false
detect:
  args: ["--version"]
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
    projetoDir = path.join(raiz, 'projeto');
    mkdirSync(path.join(projetoDir, '.agents-hub'), { recursive: true });
    // O arquivo do projeto já tem memória e um comentário: editar a política
    // não pode apagar nenhum dos dois.
    writeFileSync(
      path.join(projetoDir, PROJECT_CONFIG_RELATIVE),
      '# regras da casa\nmemory: use npm workspaces\n',
      'utf8',
    );

    const porta = await portaLivre();
    hub = createHub({ home: path.join(raiz, 'home'), manifestsDir: manifestos, port: porta });
    const { host, port } = await hub.start();
    const base = `http://${host}:${port}`;
    operador = new Api(base, () => hub.operatorToken);
    anonimo = new Api(base);
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

  test('GET /policy devolve camada global vazia e a efetiva (padrão)', async () => {
    const { policy } = await anonimo.policy();
    assert.deepEqual(policy.global.layer, {});
    assert.equal((policy.global.effective['defaultBudget'] as { usd: number }).usd, DEFAULT_POLICY.defaultBudget.usd);
    assert.equal(policy.project, null);
  });

  test('PUT /policy sem token é 401 e nada é gravado', async () => {
    await assert.rejects(
      anonimo.setGlobalPolicy({ maxDepth: 9 }),
      (err: unknown) => err instanceof HubApiError && err.status === 401,
    );
    assert.equal(existsSync(path.join(hub.config.home, 'config.json')), false);
  });

  test('PUT /policy valida pelo schema: campo inexistente é 422', async () => {
    await assert.rejects(
      operador.setGlobalPolicy({ maxDeph: 2 }),
      (err: unknown) => err instanceof HubApiError && err.status === 422,
    );
    await assert.rejects(
      operador.setGlobalPolicy({ risk: { irreversible: 'talvez' } }),
      (err: unknown) => err instanceof HubApiError && err.status === 422,
    );
  });

  test('PUT /policy grava a camada global, vale na hora e avisa o que AFROUXA', async () => {
    const res = await operador.setGlobalPolicy({
      defaultBudget: { usd: 9 },
      maxDepth: 2,
      risk: { irreversible: 'allow' },
    });
    assert.deepEqual(res.loosened.sort(), ['defaultBudget.usd', 'risk.irreversible']);
    assert.equal(hub.config.policy.defaultBudget.usd, 9, 'o daemon passou a usar sem reiniciar');
    assert.equal(hub.config.policy.maxDepth, 2);
    const disco = JSON.parse(readFileSync(path.join(hub.config.home, 'config.json'), 'utf8')) as {
      policy: Record<string, unknown>;
    };
    assert.deepEqual(disco.policy['defaultBudget'], { usd: 9 });

    // Volta ao seguro para os testes seguintes.
    const volta = await operador.setGlobalPolicy({ defaultBudget: { usd: 9 }, maxDepth: 2 });
    assert.deepEqual(volta.loosened, []);
    assert.equal(hub.config.policy.risk.irreversible, 'approve');
  });

  test('PUT /projects/:id/policy aplica o clamp do 0.7 e preserva o resto do YAML', async () => {
    const res = await operador.setProjectPolicy(projectId, {
      maxDepth: 1, // aperta: vale
      defaultBudget: { usd: 1000 }, // afrouxa: clamp
      commands: { allow: ['git status', 'comando-inventado'], deny: ['rm -rf'] },
      risk: { exec: 'approve', irreversible: 'allow' }, // exec aperta; irreversible afrouxa
      validation: { command: 'node pwn.cjs' }, // execução: ignorado sem confiança
    });
    const ef = res.project.effective as typeof DEFAULT_POLICY;
    assert.equal(ef.maxDepth, 1);
    assert.equal(ef.defaultBudget.usd, 9, 'projeto não sobe o orçamento acima da global');
    assert.deepEqual(ef.commands.allow, ['git status'], 'allow só encolhe');
    assert.ok(ef.commands.deny.includes('rm -rf'), 'deny só cresce');
    assert.equal(ef.risk.exec, 'approve');
    assert.equal(ef.risk.irreversible, 'approve');
    assert.equal(ef.validation.command, null);
    for (const campo of ['defaultBudget.usd', 'commands.allow', 'risk.irreversible', 'validation.command']) {
      assert.ok(res.clamped.includes(campo), `${campo} deveria constar em clamped: ${res.clamped.join(',')}`);
    }
    assert.ok(!res.clamped.includes('maxDepth'));
    assert.deepEqual(res.ignoredExecFields, ['validation.command']);

    const yaml = readFileSync(path.join(projetoDir, PROJECT_CONFIG_RELATIVE), 'utf8');
    assert.match(yaml, /# regras da casa/);
    assert.match(yaml, /memory: use npm workspaces/);
    assert.match(yaml, /policy:/);

    // A leitura devolve a mesma visão.
    const { policy } = await anonimo.policy(projectId);
    assert.equal(policy.project?.projectId, projectId);
    assert.equal((policy.project?.layer as { maxDepth?: number }).maxDepth, 1);
  });

  test('camada de projeto: campo fora do schema é 422 e o arquivo não muda', async () => {
    const antes = readFileSync(path.join(projetoDir, PROJECT_CONFIG_RELATIVE), 'utf8');
    await assert.rejects(
      operador.setProjectPolicy(projectId, { comandos: { allow: [] } }),
      (err: unknown) => err instanceof HubApiError && err.status === 422,
    );
    assert.equal(readFileSync(path.join(projetoDir, PROJECT_CONFIG_RELATIVE), 'utf8'), antes);
  });

  test('GET /audit: mudanças de política com autor da origem autenticada, filtros por projeto/tipo/tempo', async () => {
    const { entries } = await anonimo.audit({ kind: 'policy.updated' });
    assert.ok(entries.length >= 3);
    assert.ok(entries.every((e) => e.actor === `cli:${usuario}`));
    // Mais recente primeiro.
    assert.ok(entries[0]!.ts >= entries[entries.length - 1]!.ts);
    const globalAfrouxou = entries.find((e) => e.decision === 'loosened');
    assert.match(String(globalAfrouxou?.reason), /risk\.irreversible/);

    const doProjeto = await anonimo.audit({ projectId });
    assert.ok(doProjeto.entries.length >= 1);
    assert.ok(doProjeto.entries.every((e) => e.projectId === projectId));

    assert.equal((await anonimo.audit({ since: '1h' })).entries.length > 0, true);
    assert.equal((await anonimo.audit({ until: '2000-01-01T00:00:00Z' })).entries.length, 0);
    await assert.rejects(
      anonimo.audit({ since: 'ontem' }),
      (err: unknown) => err instanceof HubApiError && err.status === 400,
    );
  });

  test('GET /audit: decisões do gate e pedidos de aprovação entram na trilha', async () => {
    const sessao = hub.sessions.adoptExternal({ agentId: 'agente-x', projectId });
    const res = await anonimo.gateToolCall({
      sessionId: sessao.id,
      toolName: 'Read',
      toolInput: { file_path: path.join(projetoDir, 'README.md') },
    });
    assert.equal(res.decision, 'allow');

    const { entries } = await anonimo.audit({ sessionId: sessao.id });
    const gate = entries.find((e) => e.kind === 'gate.decision');
    assert.ok(gate, 'decisão do gate auditada');
    assert.equal(gate.actor, 'gate');
    assert.equal(gate.decision, 'allow');
    assert.equal(gate.projectId, projectId);
    assert.match(gate.action, /^Read: /);
    assert.ok(gate.reason && gate.reason.length > 0);

    // Pedido de aprovação: vem do barramento (o gate/vigilância emitem o
    // evento; a trilha observa sem conhecer o gate por dentro).
    hub.bus.publish({
      id: 'evt_teste_apv',
      seq: 1,
      ts: new Date().toISOString(),
      sessionId: sessao.id,
      taskId: null,
      agentId: 'agente-x',
      type: 'approval.requested',
      payload: {
        approvalId: 'apv_teste',
        risk: 'irreversible',
        action: 'Bash: git push --force',
        kind: 'tool-call',
        reason: 'ação irreversível',
      },
      cost: null,
      raw: null,
    });
    const pedido = (await anonimo.audit({ sessionId: sessao.id, kind: 'approval.requested' })).entries[0];
    assert.equal(pedido?.actor, 'gate');
    assert.equal(pedido?.approvalId, 'apv_teste');
    assert.equal(pedido?.risk, 'irreversible');
    assert.equal(pedido?.reason, 'ação irreversível');
    assert.equal(pedido?.projectId, projectId);
  });

  test('confiança no projeto é auditada com autor', async () => {
    await operador.setProjectTrusted(projectId, true);
    await operador.setProjectTrusted(projectId, false);
    const { entries } = await anonimo.audit({ projectId, kind: 'project.trust' });
    assert.deepEqual(
      entries.map((e) => e.decision),
      ['untrusted', 'trusted'],
    );
    assert.ok(entries.every((e) => e.actor === `cli:${usuario}`));
  });

  test('instanteDoFiltro aceita relativo e ISO', () => {
    const agora = Date.parse('2026-09-26T12:00:00Z');
    assert.equal(instanteDoFiltro('2h', agora), '2026-09-26T10:00:00.000Z');
    assert.equal(instanteDoFiltro('7d', agora), '2026-09-19T12:00:00.000Z');
    assert.equal(instanteDoFiltro('2026-09-01T00:00:00Z'), '2026-09-01T00:00:00.000Z');
    assert.throws(() => instanteDoFiltro('amanhã'));
  });
});
