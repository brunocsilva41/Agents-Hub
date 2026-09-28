import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatTokens, rotuloDeTokens, tokensCompactos, tokensDesconhecidos } from './tokens.js';

describe('tokens desconhecidos não viram "0 tokens"', () => {
  test('custo sem nenhum token contado = o agente não informou (Copilot >= 1.0.81)', () => {
    assert.equal(tokensDesconhecidos(0, 0.0037), true);
    assert.equal(rotuloDeTokens(0, 0.0037), 'sem contagem de tokens');
    assert.equal(tokensCompactos(0, 0.0037), '—');
  });

  test('sem custo e sem tokens é zero de verdade (nada rodou ou modelo grátis sem uso)', () => {
    assert.equal(tokensDesconhecidos(0, 0), false);
    assert.equal(rotuloDeTokens(0, 0), '0 tokens');
    assert.equal(tokensCompactos(0, 0), '0');
  });

  test('tokens contados aparecem como sempre, com ou sem custo', () => {
    assert.equal(rotuloDeTokens(2800, 0), '2.8k tokens');
    assert.equal(rotuloDeTokens(14_800, 0.0348), '14.8k tokens');
    assert.equal(tokensCompactos(1_500_000, 1), '1.5M');
  });

  test('formato curto', () => {
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1000), '1.0k');
  });
});
