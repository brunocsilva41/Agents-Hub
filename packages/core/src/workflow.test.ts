import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseWorkflow, validateWorkflow } from './workflow.js';

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
