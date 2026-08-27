import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  AGENT_FALLBACK_MODEL,
  MODEL_PRICES,
  combineCostEstimates,
  estimateTokenCost,
  findModelPrice,
  normalizeModelId,
  resolveEventCost,
} from './pricing.js';

describe('normalização de modelo', () => {
  test('as quatro grafias do mesmo modelo caem no mesmo preço', () => {
    const grafias = [
      'claude-opus-5',
      'anthropic/claude-opus-5',
      'us.anthropic.claude-opus-5-v1:0',
      'claude-opus-5-20260101',
    ];

    const ids = grafias.map((g) => findModelPrice(g)?.id);
    assert.deepEqual(ids, Array(grafias.length).fill('claude-opus-5'), grafias.join(' | '));
  });

  test('ponto como separador de versão não atrapalha', () => {
    assert.equal(findModelPrice('gpt-5.3-codex')?.id, 'gpt-5-3-codex');
    assert.equal(findModelPrice('kimi-k2.7-code')?.id, 'kimi-k2-7-code');
    assert.equal(findModelPrice('MiMo-V2.5-Pro')?.id, 'mimo-v2-5-pro');
  });

  test('o modelo mais específico ganha do irmão de prefixo mais curto', () => {
    assert.equal(findModelPrice('gpt-5-codex')?.id, 'gpt-5-codex');
    assert.equal(findModelPrice('gpt-5')?.id, 'gpt-5');
    assert.equal(findModelPrice('composer-2-5-fast')?.id, 'cursor-composer-2-5-fast');
  });

  test('entrada vazia ou não-string vira null em vez de exceção', () => {
    assert.equal(normalizeModelId(null), null);
    assert.equal(normalizeModelId(undefined), null);
    assert.equal(normalizeModelId('   '), null);
    assert.equal(normalizeModelId(42 as unknown as string), null);
  });
});

describe('estimativa a partir de tokens', () => {
  test('cobra entrada, saída e leitura de cache pelo preço do modelo', () => {
    // Anthropic reporta entrada e cache separados: 1M × 5 + 1M × 25 + 1M × 0,50.
    const estimate = estimateTokenCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 },
      { model: 'claude-opus-5' },
    );

    assert.equal(estimate.basis, 'estimated');
    assert.equal(estimate.confidence, 'model');
    assert.equal(estimate.model, 'claude-opus-5');
    assert.equal(estimate.usd, 30.5);
  });

  test('onde o cache está dentro da entrada, ele não é cobrado duas vezes', () => {
    // Codex/OpenAI: cached_input_tokens é subconjunto de input_tokens.
    // 100k entrada com 80k de cache = 20k a US$1,75/M + 80k a US$0,175/M.
    const estimate = estimateTokenCost(
      { inputTokens: 100_000, cachedTokens: 80_000, outputTokens: 0 },
      { model: 'gpt-5-3-codex' },
    );

    assert.equal(Number(estimate.usd.toFixed(6)), 0.049);
  });

  test('tokens ausentes ou absurdos não contaminam a conta', () => {
    const estimate = estimateTokenCost(
      { inputTokens: -5, outputTokens: Number.NaN, cachedTokens: 1000 },
      { model: 'claude-sonnet-5' },
    );

    assert.equal(estimate.usd, 0.0002, 'só os 1000 tokens de cache deveriam contar');
  });

  test('modelo desconhecido devolve unknown, sem lançar', () => {
    const estimate = estimateTokenCost(
      { inputTokens: 50_000, outputTokens: 10_000 },
      { model: 'modelo-que-ninguem-conhece-v9' },
    );

    assert.equal(estimate.basis, 'unknown');
    assert.equal(estimate.confidence, 'none');
    assert.equal(estimate.usd, 0, 'zero aqui significa "não sei", e o basis diz isso');
    assert.equal(estimate.model, undefined);
  });

  test('sem modelo e sem agente também é unknown', () => {
    assert.equal(estimateTokenCost({ inputTokens: 1000 }).basis, 'unknown');
  });
});

describe('fallback por agente', () => {
  test('modelo desconhecido com agente conhecido estima e se declara grosseiro', () => {
    const estimate = estimateTokenCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      { model: 'algum-modelo-novo-do-codex', agentId: 'codex' },
    );

    assert.equal(estimate.basis, 'estimated');
    assert.equal(estimate.confidence, 'agent-default', 'a UI precisa saber que foi chute');
    assert.equal(estimate.agentId, 'codex');
    assert.equal(estimate.model, AGENT_FALLBACK_MODEL['codex']);
    assert.equal(estimate.usd, 1.75);
  });

  test('agente sem modelo padrão apurado continua unknown', () => {
    // opencode é model-agnostic: assumir uma família seria inventar número.
    const estimate = estimateTokenCost({ inputTokens: 1_000_000 }, { agentId: 'opencode' });
    assert.equal(estimate.basis, 'unknown');
  });

  test('modelo reconhecido tem precedência sobre o fallback do agente', () => {
    const estimate = estimateTokenCost(
      { inputTokens: 1_000_000 },
      { model: 'gpt-5-nano', agentId: 'codex' },
    );

    assert.equal(estimate.confidence, 'model');
    assert.equal(estimate.model, 'gpt-5-nano');
  });
});

describe('custo reportado pelo agente', () => {
  test('o dólar informado vence a estimativa, mesmo se divergir da tabela', () => {
    const estimate = resolveEventCost(
      { usd: 0.42, inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { model: 'claude-opus-5' },
    );

    assert.equal(estimate.basis, 'reported');
    assert.equal(estimate.confidence, 'exact');
    assert.equal(estimate.usd, 0.42, 'quem cobra é o provedor, não a nossa tabela');
  });

  test('custo zero com tokens gastos é campo ausente, não sessão gratuita', () => {
    // É literalmente o caso do Codex no painel: "US$ 0,0000 · 17,2k tok".
    const estimate = resolveEventCost(
      { usd: 0, inputTokens: 17_200, outputTokens: 0 },
      { agentId: 'codex' },
    );

    assert.equal(estimate.basis, 'estimated');
    assert.ok(estimate.usd > 0, 'a sessão custou dinheiro e o painel precisa dizer isso');
  });

  test('evento sem custo nenhum não quebra', () => {
    assert.equal(resolveEventCost(null).basis, 'unknown');
    assert.equal(resolveEventCost(undefined, { agentId: 'claude' }).basis, 'estimated');
  });
});

describe('agregação de custo do fluxo', () => {
  test('uma estimativa no meio rebaixa o total inteiro', () => {
    const total = combineCostEstimates([
      { usd: 1, basis: 'reported', confidence: 'exact' },
      { usd: 0.5, basis: 'estimated', confidence: 'model' },
    ]);

    assert.equal(total.usd, 1.5);
    assert.equal(total.basis, 'estimated', 'o grafo não pode exibir isso como medido');
  });

  test('só é reportado quando toda parcela é reportada', () => {
    const total = combineCostEstimates([
      { usd: 1, basis: 'reported', confidence: 'exact' },
      { usd: 2, basis: 'reported', confidence: 'exact' },
    ]);

    assert.equal(total.basis, 'reported');
    assert.equal(total.usd, 3);
  });

  test('parcela desconhecida não zera o total, mas derruba a confiança', () => {
    const total = combineCostEstimates([
      { usd: 1, basis: 'reported', confidence: 'exact' },
      { usd: 0, basis: 'unknown', confidence: 'none' },
    ]);

    assert.equal(total.usd, 1, 'o gasto real é pelo menos isso');
    assert.equal(total.basis, 'estimated');
    assert.equal(total.confidence, 'agent-default');
  });

  test('tudo desconhecido continua desconhecido', () => {
    const total = combineCostEstimates([
      { usd: 0, basis: 'unknown', confidence: 'none' },
      { usd: 0, basis: 'unknown', confidence: 'none' },
    ]);

    assert.equal(total.basis, 'unknown');
  });
});

describe('integridade da tabela', () => {
  test('nenhum id se repete e todo preço tem fonte e data', () => {
    const ids = new Set<string>();
    for (const price of MODEL_PRICES) {
      assert.ok(!ids.has(price.id), `id duplicado: ${price.id}`);
      ids.add(price.id);
      assert.match(price.source, /^https:\/\//, `${price.id} sem fonte`);
      assert.match(price.collectedAt, /^\d{4}-\d{2}-\d{2}$/, `${price.id} sem data`);
      assert.ok(price.outputPerMTok >= price.inputPerMTok, `${price.id}: saída barata demais`);
      assert.ok(price.cacheReadPerMTok < price.inputPerMTok, `${price.id}: cache caro demais`);
    }
  });

  test('todo fallback por agente aponta para um modelo que existe na tabela', () => {
    for (const [agentId, modelId] of Object.entries(AGENT_FALLBACK_MODEL)) {
      assert.ok(findModelPrice(modelId), `${agentId} aponta para ${modelId}, que não existe`);
    }
  });
});
