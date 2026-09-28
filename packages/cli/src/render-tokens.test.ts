import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GraphSummary } from '@agents-hub/client';
import { renderGraph, rotuloDeTokens, tokensCompactos, tokensDesconhecidos } from './render.js';

describe('tokens desconhecidos não viram "0 tokens" na CLI', () => {
  test('custo sem token contado = o agente não informou (Copilot >= 1.0.81)', () => {
    assert.equal(tokensDesconhecidos(0, 0.0037), true);
    assert.equal(rotuloDeTokens(0, 0.0037), 'sem contagem de tokens');
    assert.equal(tokensCompactos(0, 0.0037), '—');
  });

  test('zero sem custo é zero de verdade; tokens contados seguem como antes', () => {
    assert.equal(rotuloDeTokens(0, 0), '0 tokens');
    assert.equal(rotuloDeTokens(14_800, 0.0348, 'tok'), '14.8k tok');
    assert.equal(tokensCompactos(2800, 0), '2.8k');
  });

  test('hub graph: nó do Copilot mostra a ausência, não "0 tok"', () => {
    const no: GraphSummary = {
      sessionId: 'ses_1',
      parentId: null,
      agentId: 'copilot',
      title: 'OK',
      state: 'completed',
      depth: 0,
      usd: 0.0037,
      tokens: 0,
      startedAt: '2026-09-26T23:41:00.000Z',
      endedAt: '2026-09-26T23:41:30.000Z',
      children: [],
    };
    const [linha] = renderGraph([no]);
    assert.match(linha ?? '', /sem contagem de tokens/);
    assert.doesNotMatch(linha ?? '', /\b0 tok/);
  });
});
