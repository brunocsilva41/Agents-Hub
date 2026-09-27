import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope } from '@agents-hub/core';
import { criarNotificadorDeAprovacao, type DepsDeNotificacao, type PermissaoDeNotificacao } from './approvalNotice.js';

/** R14-14: aprovação visível para quem não está olhando o painel. */
describe('notificação de aprovação no navegador', () => {
  function montar(permissao: PermissaoDeNotificacao, oculta: boolean) {
    const enviadas: Array<{ titulo: string; body: string; tag: string }> = [];
    let focos = 0;
    const deps: DepsDeNotificacao = {
      permissao: () => permissao,
      oculta: () => oculta,
      notificar: (titulo, o, aoClicar) => {
        enviadas.push({ titulo, ...o });
        aoClicar();
      },
      focar: () => {
        focos += 1;
      },
    };
    return { notificar: criarNotificadorDeAprovacao(deps), enviadas, focos: () => focos };
  }

  const evento = (id: string, type = 'approval.requested'): EventEnvelope =>
    ({ type, agentId: 'claude', sessionId: 'ses_1', payload: { approvalId: id, action: 'Bash: rm -rf build' } }) as unknown as EventEnvelope;

  test('aba em segundo plano + permissão: notifica com a ação e foca ao clicar', () => {
    const m = montar('granted', true);
    assert.equal(m.notificar(evento('apv_1')), true);
    assert.equal(m.enviadas.length, 1);
    assert.match(m.enviadas[0]!.titulo, /claude espera sua decisão/);
    assert.equal(m.enviadas[0]!.body, 'Bash: rm -rf build');
    assert.equal(m.enviadas[0]!.tag, 'apv_1');
    assert.equal(m.focos(), 1);
  });

  test('mesma aprovação repetida (reconexão do SSE) não notifica de novo', () => {
    const m = montar('granted', true);
    m.notificar(evento('apv_1'));
    m.notificar(evento('apv_1'));
    assert.equal(m.enviadas.length, 1);
  });

  test('sem permissão, com a aba visível ou em outro evento: nada', () => {
    assert.equal(montar('default', true).notificar(evento('apv_1')), false);
    assert.equal(montar('denied', true).notificar(evento('apv_1')), false);
    assert.equal(montar('granted', false).notificar(evento('apv_1')), false);
    assert.equal(montar('granted', true).notificar(evento('apv_1', 'message')), false);
  });
});
