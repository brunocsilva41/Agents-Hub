import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BudgetLedger, TurnCostTracker, resolveEventCost, usoDoCusto } from '@agents-hub/core';
import type { EventMapper } from '../types.js';
import { antigravityMapper } from './antigravity.js';
import { claudeMapper } from './claude.js';
import { copilotMapper } from './copilot.js';

/**
 * Fase 3.1 (vistoria 2026-09-25): stream → mapper → precificação → turno →
 * orçamento, com o formato das saídas reais da vistoria. A regra: o total do
 * turno informado pelo agente é a verdade; as parciais não somam.
 */
function contabilizar(
  mapper: EventMapper,
  linhas: unknown[],
  contexto: { model?: string; agentId: string },
): { usd: number; tokens: number; somaIngenua: number } {
  const ledger = new BudgetLedger('r', { usd: 100, tokens: 1e9, seconds: 1e6 });
  const custos = new TurnCostTracker();
  let somaIngenua = 0;
  for (const linha of linhas) {
    for (const mapped of mapper(linha)) {
      if (!mapped.cost) continue;
      // Mesmo passo do `#priceEvent` do daemon.
      const preco = resolveEventCost(mapped.cost, contexto);
      const cost = preco.basis === 'unknown' ? mapped.cost : { ...mapped.cost, usd: preco.usd };
      if (!cost.cumulative) somaIngenua += cost.usd ?? 0;
      const passo = custos.observe(cost);
      if (passo.kind === 'final') ledger.charge(usoDoCusto(passo.cost), 't');
      else ledger.estimate('t', usoDoCusto(passo.total));
    }
  }
  const aberto = custos.flush();
  if (aberto) ledger.charge(usoDoCusto(aberto), 't');
  const { consumed } = ledger.snapshot();
  return { usd: consumed.usd, tokens: consumed.tokens, somaIngenua };
}

// Relatório 11: mesma mensagem em duas linhas (thinking + text), cada uma com
// o `usage` completo, e o `result` com o total real.
const USAGE = {
  input_tokens: 2,
  output_tokens: 4,
  cache_read_input_tokens: 26158,
  cache_creation_input_tokens: 16256,
};
const CLAUDE_TURNO = [
  { type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', tools: [] },
  {
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'pensando' }], usage: USAGE },
  },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'OK' }], usage: USAGE } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.1378276, usage: USAGE, session_id: 's' },
];

describe('custo do turno com streams reais (Fase 3.1)', () => {
  test('Claude: total == total_cost_usd do result (antes: 2 parciais + result)', () => {
    const r = contabilizar(claudeMapper, CLAUDE_TURNO, { model: 'claude-opus-5-5', agentId: 'claude' });
    assert.ok(Math.abs(r.usd - 0.1378276) < 1e-12, `US$ ${r.usd}`);
    assert.equal(r.tokens, 6, '2 in + 4 out, uma vez');
    assert.ok(r.somaIngenua > 0.1378276, 'a soma ingênua (o bug) passaria do real');
  });

  test('Claude: linhas da mesma message.id se substituem na estimativa ao vivo', () => {
    const ledger = new BudgetLedger('r', { usd: 100, tokens: 1e9, seconds: 1e6 });
    const custos = new TurnCostTracker();
    const estimativas: number[] = [];
    for (const linha of CLAUDE_TURNO.slice(0, 3)) {
      for (const m of claudeMapper(linha)) {
        if (!m.cost) continue;
        const preco = resolveEventCost(m.cost, { model: 'claude-opus-5-5' });
        const passo = custos.observe({ ...m.cost, usd: preco.usd });
        assert.equal(passo.kind, 'estimate');
        if (passo.kind === 'estimate') {
          estimativas.push(ledger.estimate('t', usoDoCusto(passo.total)).consumed.usd);
        }
      }
    }
    assert.equal(estimativas.length, 2);
    assert.equal(estimativas[0], estimativas[1], 'a segunda linha da mesma mensagem não soma');
  });

  test('Claude: mensagens diferentes somam na estimativa, e o result substitui tudo', () => {
    const linhas = [
      { type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'x' }], usage: USAGE } },
      { type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: 'y' }], usage: USAGE } },
      { type: 'result', subtype: 'success', total_cost_usd: 0.05, usage: USAGE, session_id: 's' },
    ];
    const r = contabilizar(claudeMapper, linhas, { model: 'claude-opus-5-5', agentId: 'claude' });
    assert.ok(Math.abs(r.usd - 0.05) < 1e-12);
  });

  test('Claude: turno morto antes do result ainda custa (a estimativa é cobrada no fechamento)', () => {
    const r = contabilizar(claudeMapper, CLAUDE_TURNO.slice(0, 3), {
      model: 'claude-opus-5-5',
      agentId: 'claude',
    });
    assert.ok(r.usd > 0, 'custo não some quando o processo é morto no meio');
  });

  test('Antigravity: uso por etapa + result conta os tokens uma vez só', () => {
    const linhas = [
      { event: 'init', conversation_id: 'c', init: {} },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'c',
          step_index: 1,
          step_type: 'agent_response',
          text_delta: 'OK',
          usage: { input_tokens: 15000, output_tokens: 5, cache_read_tokens: 0, total_tokens: 15005 },
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: 'c',
          status: 'SUCCESS',
          response: 'OK\n',
          usage: { input_tokens: 15300, output_tokens: 5, total_tokens: 15305 },
        },
      },
    ];
    const r = contabilizar(antigravityMapper, linhas, { agentId: 'antigravity' });
    assert.equal(r.tokens, 15305);
  });

  test('Antigravity: result sem números não apaga a estimativa das etapas', () => {
    const linhas = [
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          step_type: 'agent_response',
          text_delta: 'OK',
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      },
      { event: 'result', result: { status: 'SUCCESS', response: 'OK', usage: { total_tokens: 105 } } },
    ];
    const r = contabilizar(antigravityMapper, linhas, { agentId: 'antigravity' });
    assert.equal(r.tokens, 105);
  });

  test('Copilot: créditos do usage_checkpoint viram dólar e tokens de saída contam (antes: US$ 0, 0 tokens)', () => {
    const linhas = [
      { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-luna' } },
      {
        type: 'assistant.message',
        data: {
          messageId: 'm1',
          model: 'gpt-5.6-luna',
          content: 'Não há uma descrição da tarefa.',
          toolRequests: [],
          outputTokens: 322,
        },
      },
      { type: 'assistant.turn_end', data: { turnId: '0' } },
      { type: 'session.usage_checkpoint', data: { totalNanoAiu: 529821900, totalPremiumRequests: 1 } },
      { type: 'result', sessionId: 's', exitCode: 0, usage: { premiumRequests: 1 } },
    ];
    const r = contabilizar(copilotMapper, linhas, { model: 'gpt-5.6-luna', agentId: 'copilot' });
    assert.ok(Math.abs(r.usd - 0.005298219) < 1e-12, `US$ ${r.usd} (0,53 créditos x US$ 0,01)`);
    assert.equal(r.tokens, 322);
  });

  test('Copilot: acumulado de sessão retomada desconta a base do turno anterior', () => {
    const custos = new TurnCostTracker({ usd: 0.005298219, credits: 0.5298219 });
    const [evento] = copilotMapper({
      type: 'session.usage_checkpoint',
      data: { totalNanoAiu: 1059643800 },
    });
    assert.ok(evento?.cost);
    custos.observe(evento.cost);
    const aberto = custos.flush();
    assert.ok(Math.abs((aberto?.usd ?? 0) - 0.005298219) < 1e-12, 'só o incremento deste turno');
    assert.ok(Math.abs((aberto?.credits ?? 0) - 0.5298219) < 1e-12);
  });
});
