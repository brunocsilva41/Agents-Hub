import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { isHubError } from './errors.js';
import { buildGraph, checkDelegation, pathKey, rollupCost } from './graph.js';

describe('checkDelegation', () => {
  test('aceita delegação dentro da profundidade', () => {
    const verdict = checkDelegation({
      parentPath: [pathKey('claude', 'implementar login')],
      parentDepth: 0,
      maxDepth: 3,
      target: { agentId: 'codex', objective: 'escrever testes do login' },
    });
    assert.equal(verdict.depth, 1);
    assert.equal(verdict.path.length, 2);
  });

  test('barra ao exceder a profundidade máxima', () => {
    assert.throws(
      () =>
        checkDelegation({
          parentPath: ['a', 'b', 'c'],
          parentDepth: 3,
          maxDepth: 3,
          target: { agentId: 'codex', objective: 'mais um nível' },
        }),
      (err: unknown) => isHubError(err) && err.code === 'DEPTH_EXCEEDED',
    );
  });

  test('detecta ciclo semântico: mesmo agente com o mesmo objetivo', () => {
    const objective = 'refatorar o módulo de pagamentos';
    assert.throws(
      () =>
        checkDelegation({
          parentPath: [pathKey('claude', objective), pathKey('codex', 'escrever testes')],
          parentDepth: 1,
          maxDepth: 5,
          target: { agentId: 'claude', objective },
        }),
      (err: unknown) => isHubError(err) && err.code === 'CYCLE_DETECTED',
    );
  });

  test('mesmo agente com objetivo diferente é permitido', () => {
    assert.doesNotThrow(() =>
      checkDelegation({
        parentPath: [pathKey('claude', 'refatorar pagamentos')],
        parentDepth: 0,
        maxDepth: 3,
        target: { agentId: 'claude', objective: 'documentar a API' },
      }),
    );
  });

  test('normalização pega o mesmo objetivo escrito diferente', () => {
    assert.equal(pathKey('claude', 'Refatorar  o  Módulo'), pathKey('claude', 'refatorar o módulo'));
  });
});

describe('buildGraph', () => {
  const rows = [
    node('ses_a', null, 'claude', 0, 1.0),
    node('ses_b', 'ses_a', 'codex', 1, 0.5),
    node('ses_c', 'ses_a', 'opencode', 1, 0.25),
    node('ses_d', 'ses_b', 'mimo', 2, 0.1),
  ];

  test('monta a árvore a partir da lista plana', () => {
    const graph = buildGraph(rows);
    assert.equal(graph.length, 1);
    assert.equal(graph[0]?.children.length, 2);
    assert.equal(graph[0]?.children[0]?.children[0]?.agentId, 'mimo');
  });

  test('rollupCost soma a subárvore inteira', () => {
    const [root] = buildGraph(rows);
    assert.ok(root);
    assert.equal(rollupCost(root).usd, 1.85);
  });
});

function node(
  sessionId: string,
  parentId: string | null,
  agentId: string,
  depth: number,
  usd: number,
): Parameters<typeof buildGraph>[0][number] {
  return {
    sessionId,
    parentId,
    agentId,
    title: null,
    state: 'completed',
    depth,
    usd,
    tokens: 1000,
    startedAt: `2026-08-26T10:0${depth}:00.000Z`,
    endedAt: null,
  };
}
