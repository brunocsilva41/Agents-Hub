import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { EventEnvelope } from '@agents-hub/core';
import { criarAlertaDeAprovacao, sinalDeAprovacao } from './approval-alert.js';
import { capturar, comTeto, montarHubDeTeste, type HubDeTeste } from './hub-de-teste.js';
import { startCommand } from './start-cmd.js';

const args = (positional: string[], flags: Record<string, string | boolean>) => ({ command: 'start', positional, flags });

/**
 * R11-05: `send` numa sessão concluída é recusado e a recusa aponta
 * `hub start --from <id>` — que precisa existir e levar o que a anterior
 * deixou (resumo, ponteiro de contexto, branch), no MESMO projeto.
 */
describe('hub start --from (continuar sessão terminada)', () => {
  let h: HubDeTeste;

  before(async () => {
    h = await montarHubDeTeste([{ id: 'ok', modo: 'ok' }]);
    h.hub.sessions.registerProject(h.projeto, 'projeto-from');
  });

  after(async () => {
    await h.encerrar();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  test('a sessão nova leva resumo, contexto e base da anterior', async () => {
    const c1 = capturar();
    const primeira = await comTeto(
      startCommand(h.client, args(['primeira tarefa do teste de continuação'], { agent: 'ok', project: h.projeto, isolation: 'none' }), { log: c1.log, logErro: c1.logErro, pollMs: 100 }),
      30_000,
      'primeira sessão',
    );
    assert.equal(primeira?.estado, 'completed', c1.texto());
    const anterior = primeira!.sessionId;

    const c2 = capturar();
    const segunda = await comTeto(
      startCommand(h.client, args(['continue a partir do que foi feito'], { agent: 'ok', from: anterior, isolation: 'none' }), { log: c2.log, logErro: c2.logErro, pollMs: 100 }),
      30_000,
      'sessão de continuação',
    );
    assert.equal(segunda?.estado, 'completed', c2.texto() + c2.erros.join('\n'));

    const nova = h.hub.store.sessions.get(segunda!.sessionId);
    assert.ok(nova);
    assert.notEqual(nova.id, anterior);
    assert.equal(nova.projectId, h.hub.store.sessions.get(anterior)?.projectId);
    const task = h.hub.store.tasks.list({ sessionId: nova.id })[0];
    assert.deepEqual(task?.brief.contextRefs, [`session:${anterior}`]);
    assert.equal(task?.brief.upstream?.[0]?.sessionRef, `session:${anterior}`);
  });

  test('--from sem valor é recusado antes de abrir sessão', async () => {
    const antes = h.hub.store.sessions.list().length;
    const c = capturar();
    await startCommand(h.client, args(['objetivo descritivo o bastante'], { agent: 'ok', from: true }), { log: c.log, logErro: c.logErro });
    assert.match(c.erros.join('\n'), /--from precisa do id/);
    assert.equal(h.hub.store.sessions.list().length, antes);
  });

  test('o alerta de aprovação é repassado ao acompanhamento do start', async () => {
    const vistos: string[] = [];
    const c = capturar();
    await comTeto(
      startCommand(h.client, args(['tarefa para ver o alerta ligado'], { agent: 'ok', project: h.projeto, isolation: 'none' }), {
        log: c.log,
        logErro: c.logErro,
        pollMs: 100,
        alertar: (e) => vistos.push(e.type),
      }),
      30_000,
      'start com alerta',
    );
    assert.ok(vistos.length > 0, 'o alertador deveria ver os eventos do stream');
  });
});

/** R14-14: bipe + título do terminal quando surge aprovação. */
describe('alerta de aprovação no terminal', () => {
  const aprovacao = { type: 'approval.requested', payload: { approvalId: 'apv_abc123' } } as unknown as EventEnvelope;
  const outro = { type: 'message', payload: { text: 'oi' } } as unknown as EventEnvelope;

  test('em TTY: BEL e título com o id', () => {
    const s = sinalDeAprovacao(aprovacao, { tty: true, desligado: false });
    assert.ok(s?.startsWith('\u0007'));
    assert.match(String(s), /\u001b\]0;hub: aprovação pendente apv_abc123\u0007/);
  });

  test('fora de TTY, com --no-bell ou em outro evento: nada', () => {
    assert.equal(sinalDeAprovacao(aprovacao, { tty: false, desligado: false }), null);
    assert.equal(sinalDeAprovacao(aprovacao, { tty: true, desligado: true }), null);
    assert.equal(sinalDeAprovacao(outro, { tty: true, desligado: false }), null);
  });

  test('a mesma aprovação (replay) não bipa duas vezes; outra bipa', () => {
    const escritos: string[] = [];
    const alertar = criarAlertaDeAprovacao({ tty: true, escrever: (s) => escritos.push(s) });
    alertar(aprovacao);
    alertar(aprovacao);
    alertar({ type: 'approval.requested', payload: { approvalId: 'apv_outra' } } as unknown as EventEnvelope);
    assert.equal(escritos.length, 2);
  });

  test('id com caracteres de controle não injeta sequência no título', () => {
    const malicioso = { type: 'approval.requested', payload: { approvalId: 'apv_x\u001b]0;pwned\u0007' } } as unknown as EventEnvelope;
    const s = String(sinalDeAprovacao(malicioso, { tty: true, desligado: false }));
    assert.equal((s.match(/\u001b/g) ?? []).length, 1);
  });
});
