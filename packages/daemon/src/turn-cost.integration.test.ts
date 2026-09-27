import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveMapper } from '@agents-hub/adapters';
import { DEFAULT_POLICY, TurnCostTracker } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';
import { baseDoAcumulado } from './turn-cost-base.js';

/**
 * Fase 3.1 (vistoria 2026-09-25, relatórios 10 e 11): custo contado 2–3x.
 *
 * Os agentes de teste abaixo imprimem o stream com o FORMATO das saídas reais
 * capturadas na vistoria, passando pelo daemon inteiro (mapper → precificação
 * → orçamento → store):
 *
 * - Claude: turno real do relatório 11 — `reasoning` e `message` da MESMA
 *   mensagem, cada linha repetindo o `usage` completo (2 in / 4 out / 26158
 *   cache lido / 16256 cache escrito), e o `result` com `total_cost_usd`
 *   0.1378276. O Hub contabilizava 0.1642 (0.013189 x 2 + 0.1378276).
 * - Copilot: sessão real 3b14c0e2 (1.0.83) — `session.usage_checkpoint` com
 *   `totalNanoAiu` 529821900 = os "AI Credits 0.53" que o CLI imprimiu; o Hub
 *   registrava US$ 0 e 0 tokens.
 */

const CLAUDE_STREAM = [
  {
    type: 'system',
    subtype: 'init',
    session_id: 'c44c9fea-0000-4000-8000-000000000001',
    model: 'claude-opus-5-5',
    tools: [],
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_011CfSch8XbDVJdK2vbhMueP',
      model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: 'O usuário quer só OK.' }],
      usage: {
        input_tokens: 2,
        output_tokens: 4,
        cache_read_input_tokens: 26158,
        cache_creation_input_tokens: 16256,
      },
    },
    session_id: 'c44c9fea-0000-4000-8000-000000000001',
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_011CfSch8XbDVJdK2vbhMueP',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'OK' }],
      usage: {
        input_tokens: 2,
        output_tokens: 4,
        cache_read_input_tokens: 26158,
        cache_creation_input_tokens: 16256,
      },
    },
    session_id: 'c44c9fea-0000-4000-8000-000000000001',
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 11000,
    num_turns: 1,
    result: 'OK',
    session_id: 'c44c9fea-0000-4000-8000-000000000001',
    total_cost_usd: 0.1378276,
    usage: {
      input_tokens: 2,
      output_tokens: 4,
      cache_read_input_tokens: 26158,
      cache_creation_input_tokens: 16256,
    },
  },
];

/** Stream do Copilot no `--output-format json`; `nano` é o acumulado da sessão. */
function copilotStream(sessionId: string, nano: number): unknown[] {
  return [
    {
      type: 'session.auto_mode_resolved',
      data: { chosenModel: 'gpt-5.6-luna', routingMethod: 'auto_v2' },
      id: 'e1',
      timestamp: '2026-09-25T04:05:34.945Z',
      parentId: null,
    },
    { type: 'assistant.turn_start', data: { turnId: '0' }, id: 'e2', timestamp: '', parentId: 'e1' },
    {
      type: 'assistant.message',
      data: {
        messageId: 'b9c29dab-dd0d-4803-8f5a-78d2c5592ecc',
        model: 'gpt-5.6-luna',
        content: 'Não há uma descrição da tarefa nem arquivos no repositório para modificar.',
        toolRequests: [],
        outputTokens: 322,
        turnId: '0',
      },
      id: 'e3',
      timestamp: '',
      parentId: 'e2',
    },
    { type: 'assistant.turn_end', data: { turnId: '0' }, id: 'e4', timestamp: '', parentId: 'e3' },
    {
      type: 'session.usage_checkpoint',
      data: { totalNanoAiu: nano, totalPremiumRequests: 1 },
      id: 'e5',
      timestamp: '',
      parentId: 'e4',
    },
    {
      type: 'result',
      timestamp: '2026-09-25T04:06:47.006Z',
      sessionId,
      exitCode: 0,
      usage: {
        premiumRequests: 1,
        totalApiDurationMs: 9122,
        sessionDurationMs: 78000,
        codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
      },
    },
  ];
}

describe('custo do turno: o total informado pelo agente é a verdade (Fase 3.1)', () => {
  let raiz: string;
  let hub: Hub;
  let projetoPath: string;

  function manifest(dir: string, id: string, script: string, mapper: string, native: boolean): void {
    const s = script.replace(/\\/g, '\\\\');
    writeFileSync(
      path.join(dir, `${id}.yaml`),
      `
id: ${id}
name: ${id}
vendor: Test
description: Agente de teste de custo
bin: node
invoke:
  oneShot: ["${s}"]
  resume: ["${s}", "--resume", "{{nativeSessionId}}"]
  stdinPrompt: true
  interactive: false
detect:
  args: ["${s}", "--version"]
capabilities:
  - code-edit
session:
  strategy: ${native ? 'native' : 'replay'}
stream:
  format: jsonl
  mapper: ${mapper}
defaults:
  isolation: none
  timeoutSeconds: 30
`,
      'utf8',
    );
  }

  /** Script que imprime `linhas` (JSON) — ou, com contador, uma lista por invocação. */
  function script(file: string, porInvocacao: unknown[][]): void {
    const contador = `${file}.n`;
    writeFileSync(contador, '0', 'utf8');
    writeFileSync(
      file,
      `
const fs = require('fs');
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  const n = Number(fs.readFileSync(${JSON.stringify(contador)}, 'utf8'));
  fs.writeFileSync(${JSON.stringify(contador)}, String(n + 1), 'utf8');
  const todas = ${JSON.stringify(porInvocacao)};
  for (const l of todas[Math.min(n, todas.length - 1)]) process.stdout.write(JSON.stringify(l) + '\\n');
  process.exit(0);
});
`,
      'utf8',
    );
  }

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-custo-turno-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });

    const claude = path.join(raiz, 'claude-fake.cjs');
    script(claude, [CLAUDE_STREAM]);
    manifest(manifestos, 'claude-fake', claude, 'claude', false);

    const copilot = path.join(raiz, 'copilot-fake.cjs');
    // Duas invocações da MESMA sessão nativa: o acumulado dobra (0,53 → 1,06).
    script(copilot, [
      copilotStream('3b14c0e2-bab4-4fc0-85e4-5367868c2838', 529821900),
      copilotStream('3b14c0e2-bab4-4fc0-85e4-5367868c2838', 1059643800),
    ]);
    manifest(manifestos, 'copilot-fake', copilot, 'copilot', true);

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: {
        ...DEFAULT_POLICY,
        watch: { pauseOn: [], flagOn: [] },
        defaultBudget: { usd: 10, tokens: 1_000_000, seconds: 100_000 },
      },
    });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  async function esperar(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
    const limite = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > limite) throw new Error('condição não satisfeita a tempo');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function brief(agent: string, usd: number) {
    return {
      agent,
      objective: 'Responda apenas com a palavra OK',
      acceptanceCriteria: [],
      constraints: [],
      budget: { usd },
      isolation: 'none' as const,
      supervision: 'semi' as const,
    };
  }

  const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected', 'input_required']);

  test('Claude: custo do fluxo == total_cost_usd do result, e teto de 0,15 não estoura', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Custo Claude');
    // 0,15 fica entre o custo real (0,1378) e o que o Hub contabilizava (0,1642).
    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId: 'claude-fake',
      brief: brief('claude-fake', 0.15),
    });
    await esperar(() => {
      const t = hub.store.tasks.get(started.task.id);
      return !!t && TERMINAIS.has(t.state) && !hub.sessions.isLive(started.session.id);
    });

    const custo = hub.store.events.costOf(started.session.id);
    assert.ok(Math.abs(custo.usd - 0.1378276) < 1e-9, `store: US$ ${custo.usd}, real 0.1378276`);
    assert.equal(custo.tokens, 6, 'tokens do result (2 in + 4 out), uma vez só');

    const budget = hub.sessions.budget(started.session.rootId);
    assert.ok(
      Math.abs(budget.consumed.usd - 0.1378276) < 1e-9,
      `orçamento: US$ ${budget.consumed.usd}, real 0.1378276`,
    );
    const eventos = hub.sessions.listEvents(started.session.id);
    assert.equal(eventos.filter((e) => e.type === 'budget.exceeded').length, 0, 'estouro falso');
    assert.equal(hub.sessions.pendingApprovals(started.session.id).length, 0);

    const grafo = hub.sessions.graph(started.session.rootId);
    assert.ok(Math.abs((grafo[0]?.usd ?? 0) - 0.1378276) < 1e-9, 'grafo com o mesmo número');
  });

  test('Copilot: créditos viram custo (0,53 créditos = US$ 0,0053) e o resume cobra só o incremento', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Custo Copilot');
    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId: 'copilot-fake',
      brief: brief('copilot-fake', 1),
    });
    const sessionId = started.session.id;
    await esperar(() => {
      const t = hub.store.tasks.get(started.task.id);
      return !!t && TERMINAIS.has(t.state) && !hub.sessions.isLive(sessionId);
    });

    let custo = hub.store.events.costOf(sessionId);
    assert.ok(Math.abs(custo.usd - 0.005298219) < 1e-9, `1º turno: US$ ${custo.usd}`);
    assert.equal(custo.tokens, 322, 'tokens de saída da mensagem');
    const fechamento = hub.sessions
      .listEvents(sessionId)
      .find((e) => e.payload['kind'] === 'custo.turno.fechado');
    assert.ok(fechamento, 'o turno sem custo final fecha a conta num evento próprio');
    assert.ok(Math.abs((fechamento.cost?.credits ?? 0) - 0.5298219) < 1e-9);
    assert.equal(
      hub.store.sessions.get(sessionId)?.nativeSessionId,
      '3b14c0e2-bab4-4fc0-85e4-5367868c2838',
    );

    const budget = hub.sessions.budget(started.session.rootId);
    assert.ok(Math.abs(budget.consumed.usd - 0.005298219) < 1e-9, `orçamento: ${budget.consumed.usd}`);

    // Próximo turno na MESMA sessão nativa (retomada por aprovação/retry): a
    // base sai do fechamento gravado, e o checkpoint de 1,06 acumulado cobra
    // só os 0,53 novos.
    const sessao = hub.store.sessions.get(sessionId);
    assert.ok(sessao);
    const base = baseDoAcumulado(hub.store, sessao);
    assert.ok(Math.abs(base.usd - 0.005298219) < 1e-9, `base US$ ${base.usd}`);
    const custos = new TurnCostTracker(base);
    for (const linha of copilotStream('3b14c0e2-bab4-4fc0-85e4-5367868c2838', 1059643800)) {
      for (const m of resolveMapper('copilot')(linha)) if (m.cost) custos.observe(m.cost);
    }
    const segundo = custos.flush();
    assert.ok(Math.abs((segundo?.usd ?? 0) - 0.005298219) < 1e-9, `2º turno: US$ ${segundo?.usd}`);
    custo = hub.store.events.costOf(sessionId);
    assert.ok(custo.usd > 0);
  });
});
