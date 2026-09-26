import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { HubClient } from './client.js';
import { workflowCommand } from './workflow-cmd.js';

/**
 * `hub workflow validate|run` contra um cliente falso (item 7.1 do GOAL: o
 * comando não tinha teste). O executor do DAG (`core/workflow.ts`) tem os
 * testes dele; aqui o que se mede é a costura da CLI: o que ela manda ao
 * daemon para cada passo, como traduz o estado da tarefa em desfecho do passo
 * e o código de saída — o que um script de CI que chama `hub workflow run`
 * de fato enxerga.
 */

interface Chamada {
  agent: string;
  budgetUsd: number | undefined;
  upstream: unknown[];
  title: string;
}

type EstadoDaTarefa = 'completed' | 'failed' | 'input_required';

function clienteFalso(desfechos: Record<string, { state: EstadoDaTarefa; summary?: string; error?: string }>) {
  const iniciados: Chamada[] = [];
  const projetosPedidos: string[] = [];
  const passoDaSessao = new Map<string, string>();
  let n = 0;
  const client = {
    addProject: async (p: string) => {
      projetosPedidos.push(p);
      return { project: { id: 'prj_1', name: 'proj', path: p } };
    },
    startSession: async (req: {
      brief: { agent: string; objective: string; upstream: unknown[]; budget: { usd?: number } };
      title: string;
    }) => {
      n += 1;
      const passo = /Step: (\S+)$/.exec(req.title)?.[1] ?? '?';
      passoDaSessao.set(`ses_${n}`, passo);
      iniciados.push({
        agent: req.brief.agent,
        budgetUsd: req.brief.budget.usd,
        upstream: req.brief.upstream,
        title: req.title,
      });
      return { session: { id: `ses_${n}` }, task: { id: `tsk_${n}` } };
    },
    tasks: async (sessionId: string) => {
      const d = desfechos[passoDaSessao.get(sessionId) ?? ''] ?? { state: 'completed' as const };
      return {
        tasks: [
          {
            state: d.state,
            result: d.summary ? { summary: d.summary } : null,
            attempts: d.error ? [{ error: d.error }] : [],
          },
        ],
      };
    },
    approvals: async () => ({ approvals: [{ id: 'apv_1', action: 'Bash: git push' }] }),
    budget: async () => ({ budget: { consumed: { usd: 0.25 } } }),
  } as unknown as HubClient;
  return { client, iniciados, projetosPedidos };
}

describe('hub workflow', () => {
  let raiz: string;
  let saida: string[];
  let erros: string[];
  const log = console.log;
  const err = console.error;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-workflow-cmd-'));
  });

  after(() => {
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  beforeEach(() => {
    saida = [];
    erros = [];
    console.log = (...a: unknown[]) => void saida.push(a.join(' '));
    console.error = (...a: unknown[]) => void erros.push(a.join(' '));
    process.exitCode = undefined;
  });

  afterEach(() => {
    console.log = log;
    console.error = err;
    process.exitCode = undefined;
  });

  function arquivo(nome: string, yaml: string): string {
    const f = path.join(raiz, nome);
    writeFileSync(f, yaml, 'utf8');
    return f;
  }

  const DOIS_PASSOS = `
name: pipeline
steps:
  - id: plano
    agent: claude
    objective: planejar
  - id: codigo
    agent: codex
    objective: implementar
    dependsOn: [plano]
`;

  const args = (positional: string[], flags: Record<string, string | boolean> = {}) => ({
    command: 'workflow',
    positional,
    flags,
  });

  test('sem subcomando mostra a ajuda e não falha', async () => {
    await workflowCommand(clienteFalso({}).client, args([]));
    assert.ok(saida.join('\n').includes('hub workflow validate'));
    assert.equal(process.exitCode, undefined);
  });

  test('subcomando desconhecido sai com 1', async () => {
    await workflowCommand(clienteFalso({}).client, args(['voar']));
    assert.equal(process.exitCode, 1);
    assert.match(erros.join('\n'), /desconhecido: voar/);
  });

  test('validate: arquivo ausente, inexistente e com ciclo saem com 1', async () => {
    await workflowCommand(clienteFalso({}).client, args(['validate']));
    assert.equal(process.exitCode, 1);

    process.exitCode = undefined;
    await workflowCommand(clienteFalso({}).client, args(['validate', path.join(raiz, 'nao-existe.yaml')]));
    assert.equal(process.exitCode, 1);
    assert.match(erros.join('\n'), /não encontrado/);

    process.exitCode = undefined;
    const ciclo = arquivo(
      'ciclo.yaml',
      `name: c\nsteps:\n  - {id: a, agent: x, objective: o, dependsOn: [b]}\n  - {id: b, agent: x, objective: o, dependsOn: [a]}\n`,
    );
    await workflowCommand(clienteFalso({}).client, args(['validate', ciclo]));
    assert.equal(process.exitCode, 1);
  });

  test('validate: válido mostra os lotes na ordem de dependência', async () => {
    await workflowCommand(clienteFalso({}).client, args(['validate', arquivo('ok.yaml', DOIS_PASSOS)]));
    assert.equal(process.exitCode, undefined);
    const texto = saida.join('\n');
    assert.match(texto, /2 níveis/);
    assert.ok(texto.indexOf('plano') < texto.indexOf('codigo'));
  });

  test('run: --budget-usd inválido falha ANTES de tocar no daemon', async () => {
    const f = clienteFalso({});
    for (const valor of ['abc', '0', '-1', true] as const) {
      process.exitCode = undefined;
      await workflowCommand(f.client, args(['run', arquivo('b.yaml', DOIS_PASSOS)], { 'budget-usd': valor }));
      assert.equal(process.exitCode, 1, `--budget-usd ${String(valor)}`);
    }
    assert.deepEqual(f.projetosPedidos, []);
    assert.deepEqual(f.iniciados, []);
  });

  test('run: passos em ordem, upstream do anterior, teto do orçamento repartido; sai 0', async () => {
    const f = clienteFalso({ plano: { state: 'completed', summary: 'plano pronto' } });
    const proj = path.join(raiz, 'projeto');
    await workflowCommand(
      f.client,
      args(['run', arquivo('r.yaml', DOIS_PASSOS)], { project: proj, 'budget-usd': '2' }),
    );
    assert.equal(process.exitCode, undefined, erros.join('\n'));
    assert.deepEqual(f.projetosPedidos, [proj]);
    assert.deepEqual(
      f.iniciados.map((c) => c.agent),
      ['claude', 'codex'],
    );
    assert.equal(f.iniciados[0]?.upstream.length, 0);
    assert.equal(f.iniciados[1]?.upstream.length, 1, 'o passo dependente recebe o resultado do anterior');
    for (const c of f.iniciados) {
      assert.ok(c.budgetUsd !== undefined && c.budgetUsd > 0 && c.budgetUsd <= 2, `teto ${c.budgetUsd}`);
    }
    assert.match(saida.join('\n'), /2\/2 passos concluídos/);
  });

  test('run: passo esperando aprovação vira "blocked", o dependente é pulado e sai 1', async () => {
    const f = clienteFalso({ plano: { state: 'input_required' } });
    await workflowCommand(f.client, args(['run', arquivo('bl.yaml', DOIS_PASSOS)], { project: raiz }));
    assert.equal(process.exitCode, 1);
    assert.equal(f.iniciados.length, 1, 'o dependente não chega a iniciar');
    const texto = saida.join('\n');
    assert.match(texto, /hub approve apv_1/);
    assert.match(texto, /pulado/);
    assert.match(texto, /ainda vivas no daemon: ses_1/);
  });

  test('run: passo que falha mostra o erro da última tentativa e sai 1', async () => {
    const f = clienteFalso({ plano: { state: 'failed', error: 'o agente caiu' } });
    await workflowCommand(f.client, args(['run', arquivo('f.yaml', DOIS_PASSOS)], { project: raiz }));
    assert.equal(process.exitCode, 1);
    assert.match(saida.join('\n'), /o agente caiu/);
  });
});
