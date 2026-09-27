import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validarWorkflowYaml, WorkflowRunner, type WorkflowHost } from './workflow-runs.js';

/**
 * Item 6.12: workflow pelo painel. O laço é o `runWorkflow` do core; aqui se
 * testa o que o daemon acrescenta — ler YAML, registrar o progresso por passo
 * e parar de acompanhar quando o daemon fecha.
 */

const DOIS_PASSOS = `
name: plano-e-execucao
description: planeja e depois executa
steps:
  - id: plano
    agent: claude
    objective: escrever o plano de refatoração do módulo
  - id: execucao
    agent: codex
    objective: executar o plano de refatoração do módulo
    dependsOn: [plano]
`;

describe('validarWorkflowYaml', () => {
  test('válido: lotes em ordem topológica e resumo dos passos', () => {
    const v = validarWorkflowYaml(DOIS_PASSOS);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.deepEqual(v.executionOrder, [['plano'], ['execucao']]);
    assert.equal(v.workflow?.name, 'plano-e-execucao');
    assert.deepEqual(
      v.workflow?.steps.map((s) => s.dependsOn),
      [[], ['plano']],
    );
  });

  test('YAML quebrado vira erro legível, não exceção', () => {
    const v = validarWorkflowYaml('name: x\nsteps: [\n');
    assert.equal(v.valid, false);
    assert.match(v.errors[0] ?? '', /YAML inválido/);
  });

  test('esquema: aponta o campo que falhou', () => {
    const v = validarWorkflowYaml('name: x\nsteps:\n  - id: a\n    agent: claude\n');
    assert.equal(v.valid, false);
    assert.ok(
      v.errors.some((e) => e.startsWith('steps.0.objective')),
      v.errors.join(' | '),
    );
  });

  test('ciclo e dependência inexistente são recusados', () => {
    const ciclo = validarWorkflowYaml(`
name: ciclo
steps:
  - { id: a, agent: claude, objective: fazer a, dependsOn: [b] }
  - { id: b, agent: claude, objective: fazer b, dependsOn: [a] }
`);
    assert.equal(ciclo.valid, false);
    assert.match(ciclo.errors.join(' '), /Ciclo/);

    const orfa = validarWorkflowYaml(`
name: orfa
steps:
  - { id: a, agent: claude, objective: fazer a, dependsOn: [zz] }
`);
    assert.equal(orfa.valid, false);
    assert.match(orfa.errors.join(' '), /inexistente/);
  });

  test('lista na raiz não é workflow', () => {
    assert.equal(validarWorkflowYaml('- a\n- b\n').valid, false);
  });
});

/** Host falso: cada sessão conclui depois de `ticks` consultas. */
function hostFalso(opts: { ticks?: number; bloquear?: string } = {}) {
  const tarefas = new Map<string, { agente: string; consultas: number }>();
  const inicios: string[] = [];
  const bases = new Map<string, string[] | undefined>();
  let n = 0;
  const host: WorkflowHost = {
    async start(input) {
      n += 1;
      const id = `ses_f${n}`;
      bases.set(String(input.brief['agent']), input.baseSessionIds);
      tarefas.set(id, { agente: String(input.brief['agent']), consultas: 0 });
      inicios.push(`${String(input.brief['agent'])}:${id}`);
      return { session: { id }, task: { id: `tsk_f${n}` } };
    },
    listTasks(sessionId) {
      const t = tarefas.get(sessionId)!;
      t.consultas += 1;
      if (opts.bloquear === t.agente) return [{ state: 'input_required', attempts: [], result: null }];
      const pronto = t.consultas > (opts.ticks ?? 1);
      return [
        {
          state: pronto ? 'completed' : 'working',
          attempts: [],
          result: pronto ? { summary: `feito por ${t.agente}` } : null,
        },
      ];
    },
    pendingApprovals: () => [{ id: 'apv_x', action: 'Bash: rm -rf build' }],
    budget: () => ({ consumed: { usd: 0.25 } }),
    getProject: () => ({}),
  };
  return { host, inicios, bases };
}

async function ate(cond: () => boolean, ms = 3000): Promise<void> {
  const limite = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > limite) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('WorkflowRunner', () => {
  test('dispara, respeita a dependência e registra o desfecho de cada passo', async () => {
    const { host, inicios } = hostFalso({ ticks: 2 });
    const runner = new WorkflowRunner(host, { intervaloMs: 1 });
    const run = runner.start({ yaml: DOIS_PASSOS, projectId: 'prj_a', budgetUsd: 3 });

    assert.equal(run.state, 'running');
    assert.deepEqual(
      run.steps.map((s) => s.state),
      ['pending', 'pending'],
    );
    assert.match(run.id, /^wfr_[a-f0-9]{24}$/);

    await ate(() => runner.get(run.id).state !== 'running');
    const fim = runner.get(run.id);
    assert.equal(fim.state, 'completed', JSON.stringify(fim));
    assert.deepEqual(
      fim.steps.map((s) => s.state),
      ['completed', 'completed'],
    );
    assert.equal(fim.steps[0]?.summary, 'feito por claude');
    assert.equal(fim.totalUsd, 0.5);
    assert.ok(fim.endedAt);
    // A execução só começa depois de o plano concluir.
    assert.deepEqual(inicios, ['claude:ses_f1', 'codex:ses_f2']);
    // Teto repartido: o plano leva o saldo inteiro do seu lote.
    assert.equal(fim.steps[0]?.capUsd, 3);
    assert.deepEqual(
      runner.list().map((r) => r.id),
      [run.id],
    );
  });

  test('passo dependente em worktree parte do branch hub/<id> da dependência (baseSessionIds)', async () => {
    // Vistoria 2026-09-25, demo ampliada (8.3): pelo painel/API o segundo
    // passo nascia do HEAD do projeto — só o resumo chegava, o código não.
    const { host, bases } = hostFalso();
    const runner = new WorkflowRunner(host, { intervaloMs: 1 });
    const yaml = DOIS_PASSOS.replace(/(objective: [^\n]+)/g, '$1\n    isolation: worktree');
    const run = runner.start({ yaml, projectId: 'prj_a' });
    await ate(() => runner.get(run.id).state !== 'running');
    assert.equal(runner.get(run.id).state, 'completed');
    assert.equal(bases.get('claude'), undefined, 'o primeiro passo não tem de onde partir');
    assert.deepEqual(bases.get('codex'), ['ses_f1']);
  });

  test('passo parado em aprovação fica `blocked` e o dependente é pulado', async () => {
    const { host } = hostFalso({ bloquear: 'claude' });
    const runner = new WorkflowRunner(host, { intervaloMs: 1 });
    const run = runner.start({ yaml: DOIS_PASSOS, projectId: 'prj_a' });
    await ate(() => runner.get(run.id).state !== 'running');
    const fim = runner.get(run.id);
    assert.equal(fim.state, 'failed');
    assert.equal(fim.steps[0]?.state, 'blocked');
    assert.match(fim.steps[0]?.detail ?? '', /rm -rf build/);
    assert.equal(fim.steps[1]?.state, 'skipped');
  });

  test('YAML inválido não registra execução nenhuma', () => {
    const { host } = hostFalso();
    const runner = new WorkflowRunner(host);
    assert.throws(() => runner.start({ yaml: 'name: x', projectId: 'prj_a' }), /workflow inválido/);
    assert.deepEqual(runner.list(), []);
  });

  test('close() acorda quem espera e encerra a execução como interrompida', async () => {
    const { host } = hostFalso({ ticks: 1_000_000 });
    const runner = new WorkflowRunner(host, { intervaloMs: 60_000 });
    const run = runner.start({ yaml: DOIS_PASSOS, projectId: 'prj_a' });
    await ate(() => runner.get(run.id).steps[0]?.state === 'running');
    runner.close();
    await ate(() => runner.get(run.id).state !== 'running');
    assert.equal(runner.get(run.id).state, 'interrupted');
    assert.throws(() => runner.start({ yaml: DOIS_PASSOS, projectId: 'prj_a' }), /encerrando/);
  });

  test('id desconhecido: erro que diz que o registro é em memória', () => {
    const runner = new WorkflowRunner(hostFalso().host);
    assert.throws(() => runner.get('wfr_naoexiste'), /em memória/);
  });
});
