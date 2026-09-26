import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeEvent } from './eventView.js';
import { buildFlowTree, treeKeyTarget } from './flowTree.js';
import { isStructural, patchSessionsFromEvent } from './hubEvents.js';
import {
  delegationFeedback,
  deriveControls,
  interruptFeedback,
} from './sessionControls.js';
import { olderAction, sliceWindow } from './timelineWindow.js';
import { capToasts, toastTtlMs } from './toastPolicy.js';

describe('controles da sessão (6.4)', () => {
  const semAlvo = { busy: false, hasHandoffTarget: false };
  const comAlvo = { busy: false, hasHandoffTarget: true };

  test('pausada continua podendo ser ENCERRADA e TRANSFERIDA', () => {
    const c = deriveControls({ state: 'paused', ...comAlvo });
    assert.equal(c.cancel.enabled, true);
    assert.equal(c.handoff.enabled, true);
    assert.equal(c.pause.enabled, false);
    assert.equal(c.interrupt.enabled, false);
    assert.match(c.resumeHint ?? '', /mensagem/);
  });

  test('ociosa pode ser encerrada', () => {
    assert.equal(deriveControls({ state: 'idle', ...semAlvo }).cancel.enabled, true);
  });

  test('rodando: tudo habilitado; transferir depende de haver outro agente', () => {
    const c = deriveControls({ state: 'running', ...semAlvo });
    assert.equal(c.interrupt.enabled, true);
    assert.equal(c.pause.enabled, true);
    assert.equal(c.cancel.enabled, true);
    assert.equal(c.handoff.enabled, false);
    assert.match(c.handoff.reason ?? '', /agente/);
  });

  test('terminal: nada habilitado', () => {
    for (const state of ['completed', 'failed', 'killed']) {
      const c = deriveControls({ state, ...comAlvo });
      assert.deepEqual(
        [c.interrupt.enabled, c.pause.enabled, c.handoff.enabled, c.cancel.enabled],
        [false, false, false, false],
        state,
      );
    }
  });

  test('ação em andamento segura todos os botões', () => {
    const c = deriveControls({ state: 'running', busy: true, hasHandoffTarget: true });
    assert.equal(c.cancel.enabled, false);
    assert.equal(c.handoff.enabled, false);
  });
});

describe('avisos honestos (6.9)', () => {
  test('interromper sem turno NÃO diz "interrompido"', () => {
    const f = interruptFeedback({ interrupted: false });
    assert.equal(f.kind, 'warn');
    assert.doesNotMatch(f.title, /^Turno interrompido/);
  });

  test('delegação retida NÃO diz "iniciada"', () => {
    const f = delegationFeedback({ approval: { id: 'apv_1', action: 'delegar' }, agentId: 'codex' });
    assert.equal(f.kind, 'warn');
    assert.doesNotMatch(f.title, /iniciada/);
    assert.equal(delegationFeedback({ approval: null, agentId: 'codex' }).kind, 'ok');
  });

  test('todo aviso some sozinho, erro por último, e a fila tem teto', () => {
    assert.ok(toastTtlMs('error') > toastTtlMs('ok'));
    assert.ok(Number.isFinite(toastTtlMs('error')));
    assert.deepEqual(capToasts([1, 2, 3, 4, 5], 3), [3, 4, 5]);
  });
});

describe('índice a partir do evento (6.10 / 6.4)', () => {
  const sessoes = [
    { id: 'ses_a', state: 'paused', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'ses_b', state: 'running', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];

  test('user.message é estrutural: retomada implícita recarrega o estado', () => {
    assert.equal(isStructural({ type: 'user.message' }), true);
    assert.equal(isStructural({ type: 'message.delta' }), false);
  });

  test('session.ended aplica o estado terminal que o evento declara', () => {
    const next = patchSessionsFromEvent(sessoes, {
      type: 'session.ended',
      sessionId: 'ses_b',
      ts: '2026-01-01T00:01:00.000Z',
      payload: { state: 'killed' },
    });
    assert.equal(next[1]?.state, 'killed');
    assert.equal(next[0], sessoes[0]);
  });

  test('não inventa estado: user.message não troca "pausada" por palpite', () => {
    const next = patchSessionsFromEvent(sessoes, {
      type: 'user.message',
      sessionId: 'ses_a',
      ts: '2026-01-01T00:00:00.000Z',
      payload: { text: 'oi' },
    });
    assert.equal(next, sessoes);
  });
});

describe('grafo do fluxo (6.9)', () => {
  const s = (id: string, parentId: string | null, createdAt: string) => ({
    id,
    rootId: 'r',
    parentId,
    createdAt,
  });

  test('A→B→C fica em cadeia, não numa faixa só', () => {
    const rows = buildFlowTree('r', [
      s('c', 'b', '3'),
      s('b', 'r', '2'),
      s('r', null, '1'),
      s('d', 'r', '4'),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.session.id, r.depth, r.edge, r.fromId]),
      [
        ['r', 0, 'root', null],
        ['b', 1, 'delegation', 'r'],
        ['c', 2, 'delegation', 'b'],
        ['d', 1, 'delegation', 'r'],
      ],
    );
  });

  test('sessão irmã sem pai (transferência) pendura na raiz como handoff', () => {
    const rows = buildFlowTree('r', [s('r', null, '1'), s('h', null, '2')]);
    assert.deepEqual(rows.map((r) => [r.session.id, r.edge]), [
      ['r', 'root'],
      ['h', 'handoff'],
    ]);
  });

  test('teclado: ↓/↑ percorrem, → vai ao filho, ← volta ao pai', () => {
    const rows = buildFlowTree('r', [s('r', null, '1'), s('b', 'r', '2'), s('c', 'b', '3')]);
    assert.equal(treeKeyTarget(rows, 0, 'ArrowDown'), 1);
    assert.equal(treeKeyTarget(rows, 0, 'ArrowRight'), 1);
    assert.equal(treeKeyTarget(rows, 2, 'ArrowLeft'), 1);
    assert.equal(treeKeyTarget(rows, 2, 'Home'), 0);
    assert.equal(treeKeyTarget(rows, 0, 'End'), 2);
    assert.equal(treeKeyTarget(rows, 0, 'a'), null);
  });
});

describe('fala do usuário na timeline (6.3)', () => {
  test('user.message aparece no modo resumido, como fala do usuário', () => {
    const view = describeEvent({
      id: 'evt_u',
      seq: 3,
      ts: '2026-01-01T00:00:00.000Z',
      sessionId: 'ses_a',
      taskId: null,
      agentId: 'claude',
      type: 'user.message',
      payload: { text: 'faça também o X' },
      cost: null,
      raw: null,
    });
    assert.equal(view.kind, 'user');
    assert.equal(view.verbose, false);
    assert.equal(view.text, 'faça também o X');
  });
});

describe('janela da timeline (6.3)', () => {
  const linhas = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}` }));

  test('com a janela cheia, evento novo MUDA a chave de acompanhamento', () => {
    const a = sliceWindow(linhas(450), 400);
    const b = sliceWindow(linhas(451), 400);
    assert.equal(a.shown.length, b.shown.length);
    assert.notEqual(a.followKey, b.followKey);
  });

  test('página antiga carregada no topo NÃO muda a chave (não puxa a tela para o fim)', () => {
    const antes = linhas(10).slice(5);
    const depois = linhas(10);
    assert.equal(sliceWindow(antes, 400).followKey, sliceWindow(depois, 400).followKey);
  });

  test('rolar ao topo revela o local antes de pedir ao daemon', () => {
    assert.equal(olderAction({ scrollTop: 0, hidden: 10, hasMoreBefore: true, loadingOlder: false }), 'expand');
    assert.equal(olderAction({ scrollTop: 0, hidden: 0, hasMoreBefore: true, loadingOlder: false }), 'fetch');
    assert.equal(olderAction({ scrollTop: 0, hidden: 0, hasMoreBefore: true, loadingOlder: true }), null);
    assert.equal(olderAction({ scrollTop: 500, hidden: 10, hasMoreBefore: true, loadingOlder: false }), null);
  });
});
