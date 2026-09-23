import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parseWorkflow,
  runWorkflow,
  validateWorkflow,
  type WorkflowRunDeps,
} from './workflow.js';
import type { UpstreamResult } from './brief.js';
import { HubError } from './errors.js';

describe('Workflow DAG Validation & Execution Ordering', () => {
  test('valida workflow linear simples e ordena topologicamente', () => {
    const wf = parseWorkflow({
      name: 'Pipeline Linear',
      steps: [
        {
          id: 'step1',
          agent: 'claude',
          objective: 'Escrever código',
        },
        {
          id: 'step2',
          agent: 'codex',
          objective: 'Escrever testes unitários',
          dependsOn: ['step1'],
        },
      ],
    });

    const res = validateWorkflow(wf);
    assert.equal(res.valid, true);
    assert.deepEqual(res.executionOrder, [['step1'], ['step2']]);
  });

  test('identifica batches paralelos para fan-out', () => {
    const wf = parseWorkflow({
      name: 'Fan-out e Fan-in',
      steps: [
        {
          id: 'root',
          agent: 'claude',
          objective: 'Planejar tarefas',
        },
        {
          id: 'task_backend',
          agent: 'codex',
          objective: 'Construir API',
          dependsOn: ['root'],
        },
        {
          id: 'task_frontend',
          agent: 'opencode',
          objective: 'Construir Telas',
          dependsOn: ['root'],
        },
        {
          id: 'review',
          agent: 'claude',
          objective: 'Revisão e integração final',
          dependsOn: ['task_backend', 'task_frontend'],
        },
      ],
    });

    const res = validateWorkflow(wf);
    assert.equal(res.valid, true);
    assert.equal(res.executionOrder.length, 3);
    assert.deepEqual(res.executionOrder[0], ['root']);
    // Segundo nível: backend e frontend em paralelo
    assert.deepEqual(res.executionOrder[1]?.sort(), ['task_backend', 'task_frontend'].sort());
    // Terceiro nível: revisão final
    assert.deepEqual(res.executionOrder[2], ['review']);
  });

  test('detecta ciclos e rejeita workflow com deadlock', () => {
    const wf = parseWorkflow({
      name: 'Pipeline com Ciclo',
      steps: [
        {
          id: 'a',
          agent: 'claude',
          objective: 'A depende de B',
          dependsOn: ['b'],
        },
        {
          id: 'b',
          agent: 'codex',
          objective: 'B depende de A',
          dependsOn: ['a'],
        },
      ],
    });

    const res = validateWorkflow(wf);
    assert.equal(res.valid, false);
    assert.match(res.errors[0] ?? '', /Ciclo detectado/);
  });

  test('rejeita dependência de step inexistente', () => {
    const wf = parseWorkflow({
      name: 'Step Fantasma',
      steps: [
        {
          id: 'step1',
          agent: 'claude',
          objective: 'Objetivo',
          dependsOn: ['nao_existe'],
        },
      ],
    });

    const res = validateWorkflow(wf);
    assert.equal(res.valid, false);
    assert.match(res.errors[0] ?? '', /depende de step inexistente/);
  });
});

describe('execução do workflow', () => {
  /**
   * Agente falso: registra a ordem real dos acontecimentos e o que recebeu de
   * fan-in. É o suficiente para provar as garantias do executor sem daemon.
   */
  function fabrica(
    desfechos: Record<string, { state?: 'completed' | 'failed' | 'blocked'; usd?: number; summary?: string }> = {},
  ) {
    const linhaDoTempo: string[] = [];
    const recebido = new Map<string, UpstreamResult[]>();
    const tetos = new Map<string, number | null>();
    let n = 0;

    const deps: WorkflowRunDeps = {
      start: async ({ step, upstream, capUsd }) => {
        linhaDoTempo.push(`start:${step.id}`);
        recebido.set(step.id, upstream);
        tetos.set(step.id, capUsd);
        n += 1;
        return { sessionId: `ses_${n}`, taskId: `tsk_${n}` };
      },
      settle: async ({ step }) => {
        // Um tick de event loop: sem isto, um `start` que não espera nada
        // passaria no teste de ordem por acidente.
        await new Promise((r) => setTimeout(r, 5));
        linhaDoTempo.push(`fim:${step.id}`);
        const d = desfechos[step.id] ?? {};
        return {
          state: d.state ?? 'completed',
          summary: d.summary ?? `resumo de ${step.id}`,
          detail: d.state && d.state !== 'completed' ? `falhou em ${step.id}` : null,
          usd: d.usd ?? 0,
        };
      },
    };

    return { deps, linhaDoTempo, recebido, tetos };
  }

  const linear = parseWorkflow({
    name: 'Linear',
    steps: [
      { id: 'plan', agent: 'claude', objective: 'Planejar a refatoração' },
      { id: 'refactor', agent: 'codex', objective: 'Refatorar conforme o plano', dependsOn: ['plan'] },
    ],
  });

  test('o passo dependente só COMEÇA depois de o anterior TERMINAR', async () => {
    const { deps, linhaDoTempo } = fabrica();
    const ordem = validateWorkflow(linear).executionOrder;

    const res = await runWorkflow(linear, ordem, deps);

    // O defeito que isto tranca: antes, o `await` era sobre `startSession`,
    // que devolve quando a sessão nasce. A linha do tempo saía
    // start,start,fim,fim — o refactor começava antes de o plano existir.
    assert.deepEqual(linhaDoTempo, ['start:plan', 'fim:plan', 'start:refactor', 'fim:refactor']);
    assert.equal(res.ok, true);
  });

  test('o resultado do passo anterior chega ao brief do seguinte (fan-in)', async () => {
    const { deps, recebido } = fabrica({ plan: { summary: 'O plano é extrair o módulo de billing' } });
    const ordem = validateWorkflow(linear).executionOrder;

    await runWorkflow(linear, ordem, deps);

    assert.deepEqual(recebido.get('plan'), []);
    assert.deepEqual(recebido.get('refactor'), [
      {
        step: 'plan',
        agent: 'claude',
        summary: 'O plano é extrair o módulo de billing',
        sessionRef: 'session:ses_1',
      },
    ]);
  });

  test('dependência que falha pula o dependente, e o efeito é transitivo', async () => {
    const wf = parseWorkflow({
      name: 'Cadeia',
      steps: [
        { id: 'a', agent: 'claude', objective: 'Primeiro passo da cadeia' },
        { id: 'b', agent: 'codex', objective: 'Segundo passo da cadeia', dependsOn: ['a'] },
        { id: 'c', agent: 'opencode', objective: 'Terceiro passo da cadeia', dependsOn: ['b'] },
      ],
    });
    const { deps, linhaDoTempo } = fabrica({ a: { state: 'failed' } });

    const res = await runWorkflow(wf, validateWorkflow(wf).executionOrder, deps);

    assert.equal(res.ok, false);
    assert.equal(linhaDoTempo.filter((l) => l.startsWith('start')).length, 1);
    const estados = Object.fromEntries(res.steps.map((s) => [s.stepId, s.state]));
    assert.deepEqual(estados, { a: 'failed', b: 'skipped', c: 'skipped' });
    // `c` nunca viu `a`: quem o pulou foi `b`, que também não concluiu.
    assert.match(res.steps[2]!.detail!, /b \(skipped\)/);
  });

  test('passo bloqueado em aprovação não libera quem depende dele', async () => {
    const { deps } = fabrica({ plan: { state: 'blocked' } });

    const res = await runWorkflow(linear, validateWorkflow(linear).executionOrder, deps);

    assert.equal(res.ok, false);
    assert.equal(res.steps[0]!.state, 'blocked');
    assert.equal(res.steps[1]!.state, 'skipped');
  });

  test('a soma dos tetos de um lote paralelo não passa do saldo do workflow', async () => {
    const wf = parseWorkflow({
      name: 'Fan-out',
      steps: [
        { id: 'x', agent: 'claude', objective: 'Um dos dois passos paralelos' },
        { id: 'y', agent: 'codex', objective: 'O outro passo paralelo' },
      ],
    });
    const { deps, tetos } = fabrica();

    await runWorkflow(wf, validateWorkflow(wf).executionOrder, deps, { budgetUsd: 3 });

    // Antes, `--budget-usd` era documentado no `--help` e nunca lido: cada
    // passo era uma raiz com ledger próprio e o teto global não existia.
    const soma = (tetos.get('x') ?? 0) + (tetos.get('y') ?? 0);
    assert.equal(soma, 3);
  });

  test('o orçamento global esgotado pula o que ainda não rodou', async () => {
    const wf = parseWorkflow({
      name: 'Sequência cara',
      steps: [
        { id: 'caro', agent: 'claude', objective: 'Gastar o orçamento inteiro' },
        { id: 'depois', agent: 'codex', objective: 'Passo que não deveria rodar', dependsOn: ['caro'] },
      ],
    });
    const { deps, linhaDoTempo } = fabrica({ caro: { usd: 2 } });

    const res = await runWorkflow(wf, validateWorkflow(wf).executionOrder, deps, { budgetUsd: 2 });

    assert.equal(linhaDoTempo.includes('start:depois'), false);
    assert.equal(res.steps[1]!.state, 'skipped');
    assert.match(res.steps[1]!.detail!, /orçamento do workflow esgotado/);
    assert.equal(res.totalUsd, 2);
  });

  test('sem --budget-usd nenhum teto é imposto ao passo', async () => {
    const { deps, tetos } = fabrica();
    await runWorkflow(linear, validateWorkflow(linear).executionOrder, deps);
    assert.equal(tetos.get('plan'), null);
  });

  test('falha ao iniciar não derruba o workflow inteiro, mas reprova o passo', async () => {
    const wf = parseWorkflow({
      name: 'Agente ausente',
      steps: [
        { id: 'p', agent: 'fantasma', objective: 'Passo com agente que não existe' },
        { id: 'q', agent: 'codex', objective: 'Passo independente do anterior' },
      ],
    });
    const { deps } = fabrica();
    const original = deps.start;
    deps.start = async (input) => {
      if (input.step.id === 'p') throw new Error('AGENT_NOT_FOUND: fantasma');
      return original(input);
    };

    const res = await runWorkflow(wf, validateWorkflow(wf).executionOrder, deps);

    assert.equal(res.steps[0]!.state, 'failed');
    assert.match(res.steps[0]!.detail!, /AGENT_NOT_FOUND/);
    assert.equal(res.steps[1]!.state, 'completed');
  });

  test('CONCURRENCY_EXCEEDED na primeira chamada de deps.start é transitório: reservou de novo e o passo termina completed', async () => {
    const wf = parseWorkflow({
      name: 'Concorrência libera',
      steps: [{ id: 'p', agent: 'codex', objective: 'Passo que disputa vaga de concorrência' }],
    });
    const { deps } = fabrica();
    const original = deps.start;
    let chamadas = 0;
    const sleeps: number[] = [];

    deps.start = async (input) => {
      chamadas += 1;
      if (chamadas === 1) {
        throw new HubError('CONCURRENCY_EXCEEDED', 'vaga ocupada por outro passo do lote');
      }
      return original(input);
    };
    deps.sleep = async (ms) => {
      sleeps.push(ms);
      // sem espera real: o teste controla o tempo, não o relógio.
    };

    const res = await runWorkflow(wf, validateWorkflow(wf).executionOrder, deps);

    assert.equal(chamadas, 2, 'deps.start deveria ter sido chamado de novo depois da primeira recusa');
    assert.equal(sleeps.length, 1, 'deveria ter esperado uma vez entre as duas tentativas');
    assert.equal(res.steps[0]!.state, 'completed');
    assert.equal(res.steps[0]!.detail, null);
  });

  test('CONCURRENCY_EXCEEDED que nunca libera esgota as tentativas e falha com mensagem distinta', async () => {
    const wf = parseWorkflow({
      name: 'Concorrência nunca libera',
      steps: [{ id: 'p', agent: 'codex', objective: 'Passo que nunca ganha a vaga' }],
    });
    const { deps } = fabrica();
    let chamadas = 0;
    const sleeps: number[] = [];

    deps.start = async () => {
      chamadas += 1;
      throw new HubError('CONCURRENCY_EXCEEDED', 'vaga ocupada — nunca libera neste teste');
    };
    deps.sleep = async (ms) => {
      sleeps.push(ms);
    };

    const res = await runWorkflow(wf, validateWorkflow(wf).executionOrder, deps, {
      concurrencyRetryMaxAttempts: 3,
      concurrencyRetryBackoffMs: 10,
    });

    // 1 tentativa inicial + 3 retries = 4 chamadas, 3 esperas entre elas.
    assert.equal(chamadas, 4);
    assert.equal(sleeps.length, 3);
    assert.equal(res.steps[0]!.state, 'failed');
    assert.match(res.steps[0]!.detail!, /esgotou tentativas de concorrência/);
    assert.doesNotMatch(res.steps[0]!.detail!, /não foi possível iniciar/);
  });
});
