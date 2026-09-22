import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_POLICY, PolicyEngine, type GuardedAction, type WatchPolicy } from '@agents-hub/core';
import { avaliarVigilancia, describeAction, guardedActionsOf } from './guarded-actions.js';
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

/**
 * `avaliarVigilancia`, extraída de `session-manager.ts#watch` (dívida
 * arquitetural do arquivo grande). Achado crítico de segurança fechado nesta
 * mesma esteira (`mergePolicyLayer`) tornou este o mecanismo que decide se
 * uma ação `irreversible`/`escalate` pausa a sessão — vale o cuidado extra
 * de teste direto, sem depender só de integração.
 */

const engine = new PolicyEngine(DEFAULT_POLICY);
const watchPadrao: WatchPolicy = DEFAULT_POLICY.watch; // pauseOn: ['irreversible'], flagOn: [...]

test('avaliarVigilancia: sem ação vigiada (evento sem comando/arquivo) é "ok"', () => {
  const veredito = avaliarVigilancia(
    mapped('message', { text: 'oi' }),
    '/repo',
    'autonomous',
    engine,
    watchPadrao,
  );
  assert.deepEqual(veredito, { outcome: 'ok', flagged: [] });
});

test('avaliarVigilancia: escrita em .env é irreversible e pausa (pauseOn padrão)', () => {
  const veredito = avaliarVigilancia(
    mapped('file.changed', { path: '.env' }),
    '/repo',
    'autonomous',
    engine,
    watchPadrao,
  );
  assert.equal(veredito.outcome, 'paused');
  assert.equal(veredito.pausedBy?.risk, 'irreversible');
  assert.equal(veredito.pausedBy?.action.kind, 'file.write');
});

test('avaliarVigilancia: comando comum dentro do workdir não pausa nem alerta', () => {
  const veredito = avaliarVigilancia(
    mapped('file.changed', { path: 'src/index.ts' }),
    '/repo',
    'autonomous',
    engine,
    watchPadrao,
  );
  assert.equal(veredito.outcome, 'ok');
  assert.deepEqual(veredito.flagged, []);
});

test('avaliarVigilancia: watch customizado com flagOn pega risco que não pausa', () => {
  const watchComFlag: WatchPolicy = { pauseOn: ['irreversible'], flagOn: ['escalate'] };
  const veredito = avaliarVigilancia(
    // escrita fora do workdir é classificada 'escalate' quando allowWriteOutsideWorkdir=false
    mapped('file.changed', { path: '/fora-do-workdir/x.ts' }),
    '/repo',
    'autonomous',
    engine,
    watchComFlag,
  );
  assert.equal(veredito.outcome, 'flagged');
  assert.equal(veredito.flagged.length, 1);
  assert.equal(veredito.flagged[0]?.risk, 'escalate');
});

test('avaliarVigilancia: short-circuit na primeira ação que pausa — ações seguintes nem são classificadas', () => {
  const watchQuePausaEmEscrita: WatchPolicy = { pauseOn: ['write'], flagOn: [] };
  const veredito = avaliarVigilancia(
    mapped('file.changed', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }),
    '/repo',
    'autonomous',
    engine,
    watchQuePausaEmEscrita,
  );
  assert.equal(veredito.outcome, 'paused');
  // Pausou na PRIMEIRA ação (a.ts) — b.ts nunca chega a ser avaliado.
  assert.equal(veredito.pausedBy?.action.kind, 'file.write');
  assert.ok(
    String((veredito.pausedBy?.action as { path: string }).path).endsWith('a.ts'),
    'tem que pausar na primeira ação da lista, não na segunda',
  );
});

test('avaliarVigilancia: ações flagged ANTES da que pausa continuam presentes em flagged, na ordem', () => {
  // write é flagged, e a segunda escrita (fora do workdir) é escalate e pausa.
  const watch: WatchPolicy = { pauseOn: ['escalate'], flagOn: ['write'] };
  const veredito = avaliarVigilancia(
    mapped('file.changed', {
      files: [{ path: 'dentro.ts' }, { path: '/fora-do-workdir/x.ts' }],
    }),
    '/repo',
    'autonomous',
    engine,
    watch,
  );
  assert.equal(veredito.outcome, 'paused');
  assert.equal(veredito.flagged.length, 1);
  assert.equal(veredito.flagged[0]?.risk, 'write');
  assert.equal(veredito.pausedBy?.risk, 'escalate');
});
