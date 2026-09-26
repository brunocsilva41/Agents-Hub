import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { costCommand, type CostReport } from './cost-cmd.js';
import { capturar, limpar, montarHub, semearEvento, semearSessao, type HubDeTeste } from './test-kit.js';

const DIA = 86_400_000;

/** Não havia relatório de custo agregado — só `hub budget <rootId>`, fluxo a fluxo. */
describe('hub cost', () => {
  let t: HubDeTeste;
  let projA: string;

  before(async () => {
    t = await montarHub('cost');
    projA = t.hub.sessions.registerProject(path.join(t.raiz, 'a'), 'alfa').id;
    const projB = t.hub.sessions.registerProject(path.join(t.raiz, 'b'), 'beta').id;
    const recente = new Date(Date.now() - DIA).toISOString();
    const antigo = new Date(Date.now() - 30 * DIA).toISOString();

    // Fluxo recente em alfa: claude (US$ 1) delega a codex (US$ 0,5).
    const r1 = semearSessao(t.hub, projA, { createdAt: recente, title: 'fluxo caro' });
    const f1 = semearSessao(t.hub, projA, {
      parentId: r1.id,
      rootId: r1.id,
      depth: 1,
      agentId: 'codex',
      createdAt: recente,
      path: [`claude:${r1.id}`, 'codex:z'],
    });
    semearEvento(t.hub, r1, 'turn.completed', {}, { usd: 1, inputTokens: 1000, outputTokens: 0 });
    semearEvento(t.hub, f1, 'turn.completed', {}, { usd: 0.5, inputTokens: 500, outputTokens: 0 });
    // Custo provisório não conta (mesma regra do orçamento).
    semearEvento(t.hub, r1, 'turn.completed', {}, { usd: 99, provisional: true } as never);

    // Fluxo recente em beta: codex US$ 0,25.
    const r2 = semearSessao(t.hub, projB, { agentId: 'codex', createdAt: recente });
    semearEvento(t.hub, r2, 'turn.completed', {}, { usd: 0.25, inputTokens: 10, outputTokens: 10 });

    // Fluxo de 30 dias atrás: fora de --since 7d.
    const r3 = semearSessao(t.hub, projA, { createdAt: antigo });
    semearEvento(t.hub, r3, 'turn.completed', {}, { usd: 10, inputTokens: 1, outputTokens: 1 });
  });

  after(async () => {
    await t.fechar();
    limpar(t.raiz);
  });

  async function relatorio(flags: Record<string, string | boolean>): Promise<{ r: CostReport; out: string[] }> {
    const { out, valor } = await capturar(() => costCommand(t.client, { command: 'cost', positional: [], flags }));
    return { r: valor, out };
  }

  test('padrão (7 dias): soma por agente, projeto e dia; ignora o fluxo antigo e o custo provisório', async () => {
    const { r, out } = await relatorio({});
    assert.equal(r.total.flows, 2);
    assert.equal(r.total.sessions, 3);
    assert.equal(r.total.usd, 1.75);
    assert.deepEqual(
      r.byAgent.map((a) => [a.agentId, a.usd]),
      [
        ['claude', 1],
        ['codex', 0.75],
      ],
    );
    assert.deepEqual(
      r.byProject.map((p) => [p.name, p.usd]),
      [
        ['alfa', 1.5],
        ['beta', 0.25],
      ],
    );
    assert.equal(r.topFlows[0]?.title, 'fluxo caro');
    assert.equal(r.topFlows[0]?.usd, 1.5);
    assert.ok(out.some((l) => l.includes('US$ 1.7500')));
  });

  test('--project filtra (por nome, id ou caminho) sem registrar nada', async () => {
    const { r } = await relatorio({ project: 'alfa', since: '7d' });
    assert.equal(r.projectId, projA);
    assert.equal(r.total.usd, 1.5);
    const porCaminho = await relatorio({ project: path.join(t.raiz, 'a') });
    assert.equal(porCaminho.r.total.usd, 1.5);
    await assert.rejects(() => relatorio({ project: 'naoexiste' }), /não está registrado/);
    assert.equal((await t.client.projects()).projects.length, 2);
  });

  test('--all inclui o fluxo antigo; --json imprime só JSON', async () => {
    const { r, out } = await relatorio({ all: true, json: true });
    assert.equal(r.since, null);
    assert.equal(r.total.usd, 11.75);
    assert.equal((JSON.parse(out.join('\n')) as CostReport).total.flows, 3);
  });

  test('--since inválido é erro', async () => {
    await assert.rejects(() => relatorio({ since: 'ontem' }), /instante inválido/);
  });
});
