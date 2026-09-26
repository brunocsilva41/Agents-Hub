import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Session } from '@agents-hub/core';
import { JSON_COMMANDS, jsonCommand } from './json-cmd.js';
import { capturar, limpar, montarHub, semearEvento, semearSessao, type HubDeTeste } from './test-kit.js';

const ESC = String.fromCharCode(27);

/**
 * `--json` só existia em `discover` (vistoria 07: "nenhum outro comando de
 * listagem tem saída máquina-legível"). Cada comando de leitura agora
 * imprime JSON puro — um `JSON.parse` da saída inteira tem de funcionar.
 */
describe('--json uniforme nos comandos de leitura', () => {
  let t: HubDeTeste;
  let raiz: Session;

  before(async () => {
    t = await montarHub('json');
    const projectId = t.hub.sessions.registerProject(t.raiz, 'projeto-json').id;
    raiz = semearSessao(t.hub, projectId, { title: 'fluxo com custo' });
    semearSessao(t.hub, projectId, {
      parentId: raiz.id,
      rootId: raiz.id,
      depth: 1,
      agentId: 'codex',
      path: [`claude:${raiz.id}`, 'codex:x'],
    });
    semearEvento(t.hub, raiz, 'turn.completed', {}, { usd: 0.25, inputTokens: 100, outputTokens: 50 });
  });

  after(async () => {
    await t.fechar();
    limpar(t.raiz);
  });

  async function rodar(command: string, positional: string[] = []): Promise<unknown> {
    const { out, err } = await capturar(() =>
      jsonCommand(t.client, { command, positional, flags: { json: true } }, { home: t.hub.config.home, url: t.url }),
    );
    const texto = out.join('\n');
    assert.ok(!texto.includes(ESC), `${command}: sem código de cor`);
    assert.deepEqual(err, [], `${command}: nada no stderr`);
    return JSON.parse(texto);
  }

  test('os comandos de leitura pedidos estão todos cobertos', () => {
    for (const c of ['status', 'sessions', 'projects', 'agents', 'budget', 'graph', 'doctor']) {
      assert.ok(JSON_COMMANDS.has(c), c);
    }
  });

  test('status', async () => {
    const s = (await rodar('status')) as {
      daemon: { version: string; url: string };
      sessions: { total: number };
      approvals: { pending: number };
    };
    assert.equal(s.daemon.url, t.url);
    assert.equal(s.sessions.total, 2);
    assert.equal(s.approvals.pending, 0);
  });

  test('sessions, projects, agents, approvals, health', async () => {
    const { sessions } = (await rodar('sessions')) as { sessions: Array<{ id: string }> };
    assert.ok(sessions.some((x) => x.id === raiz.id));
    const { projects } = (await rodar('projects')) as { projects: Array<{ name: string }> };
    assert.deepEqual(projects.map((p) => p.name), ['projeto-json']);
    assert.ok(Array.isArray(((await rodar('agents')) as { agents: unknown[] }).agents));
    assert.deepEqual(((await rodar('approvals')) as { approvals: unknown[] }).approvals, []);
    assert.equal(((await rodar('health')) as { ok: boolean }).ok, true);
  });

  test('graph (com total) e budget', async () => {
    const g = (await rodar('graph', [raiz.id])) as { graph: Array<{ children: unknown[] }>; totalUsd: number };
    assert.equal(g.graph.length, 1);
    assert.equal(g.graph[0]!.children.length, 1);
    assert.equal(g.totalUsd, 0.25);
    const b = (await rodar('budget', [raiz.id])) as { budget: { consumed: { usd: number } } };
    assert.equal(typeof b.budget.consumed.usd, 'number');
  });

  test('doctor', async () => {
    const d = (await rodar('doctor')) as { probes: unknown[]; installed: number; total: number };
    assert.ok(Array.isArray(d.probes));
    assert.equal(d.total, d.probes.length);
  });

  test('doctor --smoke --json é recusado (gasta tokens e mostra progresso)', async () => {
    await assert.rejects(
      () => jsonCommand(t.client, { command: 'doctor', positional: [], flags: { json: true, smoke: true } }, { home: '', url: '' }),
      /--smoke não aceita --json/,
    );
  });
});
