import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { GuardedAction } from '@agents-hub/core';
import { describeAction, guardedActionsOf } from './guarded-actions.js';
import type { MappedEvent } from './types.js';

/**
 * `guardedActionsOf`/`describeAction`, extraídas de `session-manager.ts`
 * (dívida arquitetural do arquivo grande) — sem teste próprio antes disso,
 * cobertas só indiretamente via integração com adapter real.
 */

function mapped(type: MappedEvent['type'], payload: Record<string, unknown>): MappedEvent {
  return { type, payload, raw: null };
}

test('guardedActionsOf: comando executado vira ação "command"', () => {
  const acoes = guardedActionsOf(mapped('command.executed', { command: 'git push' }), '/repo');
  assert.deepEqual(acoes, [{ kind: 'command', command: 'git push' }]);
});

test('guardedActionsOf: comando vazio ou não-string não gera ação nenhuma', () => {
  assert.deepEqual(guardedActionsOf(mapped('command.executed', { command: '   ' }), '/repo'), []);
  assert.deepEqual(guardedActionsOf(mapped('command.executed', { command: 42 }), '/repo'), []);
  assert.deepEqual(guardedActionsOf(mapped('command.executed', {}), '/repo'), []);
});

test('guardedActionsOf: arquivo alterado (payload.path) resolve caminho relativo contra o workdir', () => {
  const acoes = guardedActionsOf(mapped('file.changed', { path: 'src/index.ts' }), '/repo');
  assert.deepEqual(acoes, [{ kind: 'file.write', path: path.resolve('/repo', 'src/index.ts') }]);
});

test('guardedActionsOf: arquivo alterado (payload.files[]) resolve cada caminho', () => {
  const acoes = guardedActionsOf(
    mapped('file.changed', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }),
    '/repo',
  );
  assert.deepEqual(acoes, [
    { kind: 'file.write', path: path.resolve('/repo', 'a.ts') },
    { kind: 'file.write', path: path.resolve('/repo', 'b.ts') },
  ]);
});

test('guardedActionsOf: files vazio cai para payload.path', () => {
  const acoes = guardedActionsOf(mapped('file.changed', { files: [], path: 'c.ts' }), '/repo');
  assert.deepEqual(acoes, [{ kind: 'file.write', path: path.resolve('/repo', 'c.ts') }]);
});

test('guardedActionsOf: caminhos vazios/não-string são filtrados', () => {
  const acoes = guardedActionsOf(
    mapped('file.changed', { files: [{ path: '' }, { path: 7 }, { path: 'd.ts' }] }),
    '/repo',
  );
  assert.deepEqual(acoes, [{ kind: 'file.write', path: path.resolve('/repo', 'd.ts') }]);
});

test('guardedActionsOf: outros tipos de evento não produzem ação vigiada', () => {
  assert.deepEqual(guardedActionsOf(mapped('message', { text: 'oi' }), '/repo'), []);
  assert.deepEqual(guardedActionsOf(mapped('turn.completed', {}), '/repo'), []);
});

test('describeAction: descreve cada tipo de ação em texto legível', () => {
  const casos: Array<[GuardedAction, RegExp]> = [
    [{ kind: 'command', command: 'npm test' }, /executou: npm test/],
    [{ kind: 'file.write', path: '/repo/x.ts' }, /escreveu em: \/repo\/x\.ts/],
    [{ kind: 'file.read', path: '/repo/y.ts' }, /leu: \/repo\/y\.ts/],
    [{ kind: 'network', url: 'https://evil.example' }, /acessou: https:\/\/evil\.example/],
    [{ kind: 'delegation', agent: 'codex' }, /delegou para: codex/],
    [{ kind: 'budget.overrun', detail: 'estourou US$10' }, /estourou US\$10/],
  ];
  for (const [action, esperado] of casos) {
    assert.match(describeAction(action), esperado);
  }
});
