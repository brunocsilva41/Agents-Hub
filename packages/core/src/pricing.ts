import type { EventCost } from './events.js';

/**
 * Tabela de preços por modelo e estimativa de custo em USD.
 *
 * Existe porque o orçamento do Hub é em dólares e só o Claude Code informa
 * dólares. O Codex reporta apenas tokens no `turn.completed`, e os demais
 * agentes não reportam nem isso — sem esta tabela, metade do fluxo aparece
 * como "US$ 0,0000" e o teto de gasto vira decorativo.
 *
 * A regra que organiza o módulo inteiro: **um número estimado nunca pode se
 * passar por medido**. Por isso todo retorno carrega `basis` e `confidence`,
 * e um modelo desconhecido devolve `unknown` em vez de zero silencioso ou
 * exceção.
 *
 * Preços coletados em {@link PRICING_COLLECTED_AT}; cada linha cita a fonte.
 * Tabela desatualizada ainda é melhor que estimativa nenhuma, mas a UI deve
 * mostrar a data — ver `docs/referencias/precos-modelos.md`.
 */

/** Data (ISO, UTC) em que os preços desta tabela foram conferidos nas fontes. */
export const PRICING_COLLECTED_AT = '2026-08-27';

/**
 * Como o agente contabiliza tokens lidos de cache em relação aos de entrada.
 *
 * - `disjoint`: `inputTokens` já exclui o que veio do cache (Anthropic).
 * - `subset`: `cachedTokens` está DENTRO de `inputTokens` (OpenAI e os demais
 *   provedores compatíveis com a API da OpenAI).
 *
 * Ignorar essa diferença cobra o cache duas vezes num dos dois lados, e como
 * cache costuma ser a maior fatia de uma sessão longa, o erro não é marginal.
 */
export type CacheAccounting = 'disjoint' | 'subset';

export interface ModelPrice {
  /** Id canônico dentro do Hub — é o que volta em `CostEstimate.model`. */
  id: string;
  label: string;
  vendor: string;
  /**
   * Grafias aceitas, já normalizadas. O casamento é por prefixo, então
   * `claude-opus-5` cobre `claude-opus-5-20260101` e `claude-opus-5-v1`.
   */
  aliases: readonly string[];
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /**
   * Escrita de cache (janela curta), quando o provedor cobra separado.
   * Nenhum adapter reporta tokens de escrita de cache hoje, então o
   * estimador NÃO usa este campo — ele está aqui como referência e como
   * lembrete de que a estimativa subestima sessões com cache novo.
   */
  cacheWritePerMTok?: number;
  cacheAccounting: CacheAccounting;
  /** URL de onde o preço foi lido. */
  source: string;
  /** Data de coleta desta linha (normalmente igual a PRICING_COLLECTED_AT). */
  collectedAt: string;
  note?: string;
}

const ANTHROPIC_SRC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI_SRC = 'https://developers.openai.com/api/docs/pricing';
const OPENAI_CODEX_SRC = 'https://pricepertoken.com/pricing-page/model/openai-gpt-5-codex';
const GOOGLE_SRC = 'https://ai.google.dev/gemini-api/docs/pricing';
const MOONSHOT_SRC = 'https://benchlm.ai/moonshot/api-pricing';
const XIAOMI_SRC = 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go';
const CURSOR_SRC = 'https://cursor.com/docs/account/pricing';

const D = PRICING_COLLECTED_AT;

/**
 * Preços em USD por milhão de tokens.
 *
 * Anthropic publica leitura de cache como 0,1x a entrada e escrita de 5min
 * como 1,25x; os valores abaixo já vêm expandidos para não depender do
 * multiplicador continuar valendo.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  // ─── Anthropic ────────────────────────────────────────────────────────────
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    vendor: 'Anthropic',
    aliases: ['claude-fable-5', 'fable-5'],
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheWritePerMTok: 12.5,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    vendor: 'Anthropic',
    aliases: ['claude-opus-5', 'claude-5-opus'],
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
    note: 'Fast mode (research preview) cobra 10/50 — não modelado aqui.',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    vendor: 'Anthropic',
    aliases: ['claude-opus-4-8', 'claude-4-8-opus'],
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    vendor: 'Anthropic',
    aliases: ['claude-opus-4-7', 'claude-4-7-opus'],
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    vendor: 'Anthropic',
    aliases: ['claude-opus-4-6', 'claude-4-6-opus'],
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    vendor: 'Anthropic',
    aliases: ['claude-opus-4-5', 'claude-4-5-opus'],
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-opus-4-1',
    label: 'Claude Opus 4.1',
    vendor: 'Anthropic',
    aliases: ['claude-opus-4-1', 'claude-4-1-opus'],
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
    note: 'Aposentado na API de primeira parte; ainda servido em Bedrock/Vertex.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    aliases: ['claude-sonnet-5', 'claude-5-sonnet'],
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    vendor: 'Anthropic',
    aliases: ['claude-sonnet-4-6', 'claude-4-6-sonnet'],
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    vendor: 'Anthropic',
    aliases: ['claude-sonnet-4-5', 'claude-4-5-sonnet'],
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    vendor: 'Anthropic',
    aliases: ['claude-haiku-4-5', 'claude-4-5-haiku'],
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },
  {
    id: 'claude-haiku-3-5',
    label: 'Claude Haiku 3.5',
    vendor: 'Anthropic',
    aliases: ['claude-haiku-3-5', 'claude-3-5-haiku'],
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
  },

  // ─── OpenAI (família do Codex) ────────────────────────────────────────────
  {
    id: 'gpt-5-3-codex',
    label: 'GPT-5.3-Codex',
    vendor: 'OpenAI',
    aliases: ['gpt-5-3-codex', 'gpt-5-3'],
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-2-codex',
    label: 'GPT-5.2-Codex',
    vendor: 'OpenAI',
    aliases: ['gpt-5-2-codex'],
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    cacheAccounting: 'subset',
    source: OPENAI_CODEX_SRC,
    collectedAt: D,
    note: 'Não listado na página oficial de preços; mesmo valor do gpt-5.2 base.',
  },
  {
    id: 'gpt-5-codex',
    label: 'GPT-5-Codex',
    vendor: 'OpenAI',
    aliases: ['gpt-5-codex'],
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheAccounting: 'subset',
    source: OPENAI_CODEX_SRC,
    collectedAt: D,
    note: 'Não listado na página oficial de preços; mesmo valor do gpt-5 base.',
  },
  {
    id: 'gpt-5-6-sol',
    label: 'GPT-5.6 Sol',
    vendor: 'OpenAI',
    aliases: ['gpt-5-6-sol'],
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.4,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-6-terra',
    label: 'GPT-5.6 Terra',
    vendor: 'OpenAI',
    // `gpt-5-6` sem sufixo cai aqui de propósito: é o tier intermediário da
    // família, então errar para o meio custa menos que errar para a ponta.
    aliases: ['gpt-5-6-terra', 'gpt-5-6'],
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-6-luna',
    label: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    aliases: ['gpt-5-6-luna'],
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cacheReadPerMTok: 0.02,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-5',
    label: 'GPT-5.5',
    vendor: 'OpenAI',
    aliases: ['gpt-5-5'],
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheReadPerMTok: 0.5,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
    note: 'Acima de 272k tokens de contexto a OpenAI cobra tarifa maior.',
  },
  {
    id: 'gpt-5-4',
    label: 'GPT-5.4',
    vendor: 'OpenAI',
    aliases: ['gpt-5-4'],
    inputPerMTok: 2.5,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.25,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-4-mini',
    label: 'GPT-5.4 mini',
    vendor: 'OpenAI',
    aliases: ['gpt-5-4-mini'],
    inputPerMTok: 0.75,
    outputPerMTok: 4.5,
    cacheReadPerMTok: 0.075,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-4-nano',
    label: 'GPT-5.4 nano',
    vendor: 'OpenAI',
    aliases: ['gpt-5-4-nano'],
    inputPerMTok: 0.2,
    outputPerMTok: 1.25,
    cacheReadPerMTok: 0.02,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-2',
    label: 'GPT-5.2',
    vendor: 'OpenAI',
    aliases: ['gpt-5-2'],
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-1',
    label: 'GPT-5.1',
    vendor: 'OpenAI',
    aliases: ['gpt-5-1'],
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini',
    vendor: 'OpenAI',
    aliases: ['gpt-5-mini'],
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.025,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-nano',
    label: 'GPT-5 nano',
    vendor: 'OpenAI',
    aliases: ['gpt-5-nano'],
    inputPerMTok: 0.05,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.005,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5',
    label: 'GPT-5',
    vendor: 'OpenAI',
    aliases: ['gpt-5'],
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },

  // ─── Google (Antigravity / Gemini) ────────────────────────────────────────
  {
    id: 'gemini-3-1-pro',
    label: 'Gemini 3.1 Pro',
    vendor: 'Google',
    aliases: ['gemini-3-1-pro', 'gemini-3-pro', 'gemini-3'],
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
    note: 'Acima de 200k tokens de contexto vira 4,00/18,00 — não modelado aqui.',
  },
  {
    id: 'gemini-3-7-flash',
    label: 'Gemini 3.7 Flash',
    vendor: 'Google',
    aliases: ['gemini-3-7-flash'],
    inputPerMTok: 0.75,
    outputPerMTok: 3.75,
    cacheReadPerMTok: 0.075,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
    note: 'Preço promocional até 31/12/2026; dobra em 01/01/2027.',
  },
  {
    id: 'gemini-3-6-flash',
    label: 'Gemini 3.6 Flash',
    vendor: 'Google',
    aliases: ['gemini-3-6-flash'],
    inputPerMTok: 0.75,
    outputPerMTok: 3.75,
    cacheReadPerMTok: 0.075,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
    note: 'Preço promocional até 31/12/2026; dobra em 01/01/2027.',
  },
  {
    id: 'gemini-3-5-flash',
    label: 'Gemini 3.5 Flash',
    vendor: 'Google',
    aliases: ['gemini-3-5-flash'],
    inputPerMTok: 1.5,
    outputPerMTok: 9,
    cacheReadPerMTok: 0.15,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
  },
  {
    id: 'gemini-3-5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    vendor: 'Google',
    aliases: ['gemini-3-5-flash-lite'],
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.03,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
  },
  {
    id: 'gemini-3-1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    vendor: 'Google',
    aliases: ['gemini-3-1-flash-lite'],
    inputPerMTok: 0.25,
    outputPerMTok: 1.5,
    cacheReadPerMTok: 0.025,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
    note: 'Entrada de áudio custa o dobro — o Hub não distingue modalidade.',
  },
  {
    id: 'gemini-2-5-pro',
    label: 'Gemini 2.5 Pro',
    vendor: 'Google',
    aliases: ['gemini-2-5-pro'],
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
  },

  // ─── Moonshot (Kimi Code) ─────────────────────────────────────────────────
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    vendor: 'Moonshot AI',
    aliases: ['kimi-k3', 'k3'],
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheAccounting: 'subset',
    source: MOONSHOT_SRC,
    collectedAt: D,
  },
  {
    id: 'kimi-k2-7-code',
    label: 'Kimi K2.7 Code',
    vendor: 'Moonshot AI',
    aliases: ['kimi-k2-7-code', 'kimi-k2-7'],
    inputPerMTok: 0.95,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.19,
    cacheAccounting: 'subset',
    source: MOONSHOT_SRC,
    collectedAt: D,
  },
  {
    id: 'kimi-k2-6',
    label: 'Kimi K2.6',
    vendor: 'Moonshot AI',
    aliases: ['kimi-k2-6'],
    inputPerMTok: 0.95,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.19,
    cacheAccounting: 'subset',
    source: MOONSHOT_SRC,
    collectedAt: D,
    note: 'Preço de cache-hit não publicado; assumido igual ao do K2.7 Code.',
  },
  {
    id: 'kimi-k2-5',
    label: 'Kimi K2.5',
    vendor: 'Moonshot AI',
    aliases: ['kimi-k2-5'],
    inputPerMTok: 0.6,
    outputPerMTok: 3,
    cacheReadPerMTok: 0.15,
    cacheAccounting: 'subset',
    source: MOONSHOT_SRC,
    collectedAt: D,
    note: 'Cache-hit não publicado; assumido igual ao do K2 original (0,15).',
  },
  {
    id: 'kimi-k2',
    label: 'Kimi K2',
    vendor: 'Moonshot AI',
    aliases: ['kimi-k2'],
    inputPerMTok: 0.6,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.15,
    cacheAccounting: 'subset',
    source: MOONSHOT_SRC,
    collectedAt: D,
  },

  // ─── Xiaomi (MiMo Code) ───────────────────────────────────────────────────
  // Tarifa internacional em USD. A tarifa doméstica (CNY) é bem diferente e
  // NÃO está modelada: quem roda o MiMo na conta chinesa vai ver estimativa
  // errada para mais.
  {
    id: 'mimo-v2-5-pro',
    label: 'MiMo-V2.5-Pro',
    vendor: 'Xiaomi',
    aliases: ['mimo-v2-5-pro'],
    inputPerMTok: 0.435,
    outputPerMTok: 0.87,
    cacheReadPerMTok: 0.0036,
    cacheAccounting: 'subset',
    source: XIAOMI_SRC,
    collectedAt: D,
  },
  {
    id: 'mimo-v2-5',
    label: 'MiMo-V2.5',
    vendor: 'Xiaomi',
    aliases: ['mimo-v2-5'],
    inputPerMTok: 0.14,
    outputPerMTok: 0.28,
    cacheReadPerMTok: 0.0028,
    cacheAccounting: 'subset',
    source: XIAOMI_SRC,
    collectedAt: D,
  },

  // ─── Cursor (modelos próprios) ────────────────────────────────────────────
  // Os modelos de terceiros que o Cursor revende já estão acima, com o mesmo
  // preço de tabela. O Cursor cobra ainda US$ 0,25/MTok de "token rate" sobre
  // terceiros — taxa NÃO aplicada aqui, então a estimativa do Cursor com
  // modelo de terceiro sai levemente para baixo.
  {
    id: 'cursor-composer-2-5',
    label: 'Cursor Composer 2.5',
    vendor: 'Anysphere',
    aliases: ['composer-2-5', 'cursor-composer-2-5', 'composer'],
    inputPerMTok: 0.5,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'cursor-composer-2-5-fast',
    label: 'Cursor Composer 2.5 (Fast)',
    vendor: 'Anysphere',
    aliases: ['composer-2-5-fast', 'cursor-composer-2-5-fast'],
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.5,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'grok-4-6',
    label: 'Grok 4.6',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-6'],
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.5,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'grok-4-6-fast',
    label: 'Grok 4.6 (Fast)',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-6-fast'],
    inputPerMTok: 4,
    outputPerMTok: 12,
    cacheReadPerMTok: 1,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'grok-4-5',
    label: 'Grok 4.5',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-5'],
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.5,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'grok-4-5-fast',
    label: 'Grok 4.5 (Fast)',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-5-fast'],
    inputPerMTok: 4,
    outputPerMTok: 18,
    cacheReadPerMTok: 1,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
];

/**
 * Modelo assumido quando o agente é conhecido mas o modelo não.
 *
 * Só existe entrada para agente cujo modelo padrão eu consegui apurar. Faltam
 * de propósito `copilot` (fatura em créditos, sem modelo padrão documentado) e
 * `opencode` (model-agnostic por construção) — para esses dois, chutar uma
 * família seria inventar número, e o módulo devolve `unknown`.
 *
 * Na dúvida entre dois tiers, a entrada aponta para o mais caro: estourar o
 * orçamento sem aviso é pior que reservar demais.
 */
export const AGENT_FALLBACK_MODEL: Readonly<Record<string, string>> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5-3-codex',
  antigravity: 'gemini-3-1-pro',
  kimi: 'kimi-k2-7-code',
  mimo: 'mimo-v2-5-pro',
  cursor: 'cursor-composer-2-5',
};

/** De onde veio o número em `usd`. */
export type CostBasis =
  /** O agente informou dólares. É o valor real cobrado. */
  | 'reported'
  /** Calculado a partir de tokens × tabela de preços. */
  | 'estimated'
  /** Não dá para saber: modelo fora da tabela e agente sem fallback. */
  | 'unknown';

/**
 * Quão firme é o número. Separado de `basis` porque uma estimativa pelo modelo
 * exato e uma estimativa pelo palpite de família são ambas `estimated`, e a UI
 * precisa poder mostrar as duas de formas diferentes.
 */
export type CostConfidence =
  /** Veio do agente. */
  | 'exact'
  /** Tabela, com o modelo identificado. */
  | 'model'
  /** Tabela, mas pelo modelo padrão do agente — estimativa grosseira. */
  | 'agent-default'
  /** Sem base nenhuma; `usd` é zero e não significa "de graça". */
  | 'none';

export interface CostEstimate {
  /** Sempre finito e >= 0. Quando `basis` é `unknown`, vale 0 e não quer dizer nada. */
  usd: number;
  basis: CostBasis;
  confidence: CostConfidence;
  /** Id canônico do modelo usado para precificar, quando houve um. */
  model?: string;
  /** Preenchido só quando o preço veio do fallback por agente. */
  agentId?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface CostContext {
  /** Como o agente nomeou o modelo. Qualquer grafia serve. */
  model?: string | null | undefined;
  /** Id do agente no Hub (`claude`, `codex`, ...), para o fallback. */
  agentId?: string | null | undefined;
}

const UNKNOWN_COST: CostEstimate = { usd: 0, basis: 'unknown', confidence: 'none' };

/**
 * Reduz qualquer grafia de modelo à forma canônica usada nos aliases.
 *
 * Cobre o que os agentes realmente emitem: rota de provedor
 * (`anthropic/claude-opus-5`), ARN do Bedrock com região e versão
 * (`us.anthropic.claude-opus-5-v1:0`), sufixo de data do Vertex
 * (`claude-opus-4-5@20251101`) e ponto como separador de versão
 * (`gpt-5.3-codex`). Nunca lança: entrada inválida vira `null`.
 */
export function normalizeModelId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let id = raw.trim().toLowerCase();
  if (id.length === 0) return null;

  // Em `openrouter/anthropic/claude-opus-5` e `models/gemini-3.1-pro` só o
  // último segmento identifica o modelo; o resto é rota do provedor.
  const lastSlash = id.lastIndexOf('/');
  if (lastSlash >= 0) id = id.slice(lastSlash + 1);

  // Prefixos de região e vendor vêm empilhados no Bedrock
  // (`us.anthropic.claude-...`), então o laço roda até não sobrar nenhum.
  for (;;) {
    const match = /^(us|eu|apac|global|anthropic|openai|google|xiaomi|moonshotai|moonshot|azure|bedrock|vertex)\./.exec(id);
    if (!match) break;
    id = id.slice(match[0].length);
  }

  id = id
    .replace(/:\d+$/, '') // versão do ARN do Bedrock: `...-v1:0`
    .replace(/[@_.]/g, '-') // `@20251101`, `gpt_5`, `gpt-5.3` → tudo vira hífen
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return id.length > 0 ? id : null;
}

// Alias mais longo primeiro: `gpt-5-3-codex` tem que ganhar de `gpt-5`, e
// `composer-2-5-fast` de `composer-2-5`, senão o preço sai do irmão errado.
const ALIAS_INDEX: ReadonlyArray<{ alias: string; price: ModelPrice }> = MODEL_PRICES.flatMap(
  (price) => price.aliases.map((alias) => ({ alias, price })),
).sort((a, b) => b.alias.length - a.alias.length);

/**
 * Acha o preço de um modelo pela grafia crua. Casa por prefixo, então sufixo
 * de data, região ou variante (`-latest`, `-thinking`, `-20260101`) não
 * atrapalha. Devolve `null` — nunca lança — quando não reconhece.
 */
export function findModelPrice(raw: string | null | undefined): ModelPrice | null {
  const id = normalizeModelId(raw);
  if (id === null) return null;
  for (const entry of ALIAS_INDEX) {
    if (id === entry.alias || id.startsWith(`${entry.alias}-`)) return entry.price;
  }
  return null;
}

/** Descarta NaN, Infinity e negativos, que aparecem em payload malformado. */
function tokens(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function priceUsage(usage: TokenUsage, price: ModelPrice): number {
  const output = tokens(usage.outputTokens);
  const cached = tokens(usage.cachedTokens);
  const rawInput = tokens(usage.inputTokens);

  // Onde `cachedTokens` está contido em `inputTokens` (OpenAI e compatíveis),
  // cobrar os dois cheios contaria o cache duas vezes.
  const billableInput =
    price.cacheAccounting === 'subset' ? Math.max(0, rawInput - cached) : rawInput;

  const usd =
    (billableInput * price.inputPerMTok +
      output * price.outputPerMTok +
      cached * price.cacheReadPerMTok) /
    1_000_000;

  return Number.isFinite(usd) ? usd : 0;
}

/**
 * Estima o custo em dólares a partir de tokens.
 *
 * Tenta o modelo informado; não achando, cai para o modelo padrão do agente
 * (marcado como `agent-default`); não havendo nem isso, devolve `unknown` com
 * `usd: 0` — que o consumidor precisa tratar como "não sei", não como "grátis".
 */
export function estimateTokenCost(usage: TokenUsage, context: CostContext = {}): CostEstimate {
  const byModel = findModelPrice(context.model);
  if (byModel) {
    return {
      usd: priceUsage(usage, byModel),
      basis: 'estimated',
      confidence: 'model',
      model: byModel.id,
    };
  }

  const agentId = typeof context.agentId === 'string' ? context.agentId : null;
  const fallbackId = agentId ? AGENT_FALLBACK_MODEL[agentId] : undefined;
  const byAgent = fallbackId ? findModelPrice(fallbackId) : null;
  if (byAgent && agentId) {
    return {
      usd: priceUsage(usage, byAgent),
      basis: 'estimated',
      confidence: 'agent-default',
      model: byAgent.id,
      agentId,
    };
  }

  return UNKNOWN_COST;
}

/**
 * Resolve o custo de um `EventCost` do Hub: o dólar informado pelo agente
 * ganha sempre; só na ausência dele a tabela entra.
 *
 * `usd: 0` NÃO conta como reportado. Um turno com dezenas de milhares de
 * tokens e custo zero é, na prática, campo ausente — foi exatamente assim que
 * o painel passou a mostrar "US$ 0,0000 · 17,2k tok" para o Codex.
 */
export function resolveEventCost(
  cost: EventCost | null | undefined,
  context: CostContext = {},
): CostEstimate {
  const reported = cost?.usd;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) {
    const price = findModelPrice(context.model);
    const estimate: CostEstimate = { usd: reported, basis: 'reported', confidence: 'exact' };
    if (price) estimate.model = price.id;
    return estimate;
  }
  return estimateTokenCost(cost ?? {}, context);
}

/**
 * Soma estimativas preservando a pior garantia do conjunto.
 *
 * Um total só é `reported` se cada parcela for; basta uma estimativa para o
 * agregado inteiro virar estimativa. É o que impede o custo de uma sessão
 * mista (Claude com USD real + Codex estimado) de aparecer no grafo como se
 * fosse medido.
 */
export function combineCostEstimates(parts: readonly CostEstimate[]): CostEstimate {
  // Conjunto vazio é custo zero de fato — nada foi gasto porque nada rodou.
  if (parts.length === 0) return { usd: 0, basis: 'reported', confidence: 'exact' };

  const known = parts.filter((p) => p.basis !== 'unknown');
  if (known.length === 0) return UNKNOWN_COST;

  const usd = known.reduce((acc, p) => acc + p.usd, 0);
  const allReported = known.every((p) => p.basis === 'reported');
  const hasUnknown = known.length < parts.length;

  // Uma parcela desconhecida não zera o total, mas rebaixa a garantia: o que
  // se sabe é que o gasto real é PELO MENOS isso.
  const confidence: CostConfidence = allReported && !hasUnknown
    ? 'exact'
    : known.some((p) => p.confidence === 'agent-default') || hasUnknown
      ? 'agent-default'
      : 'model';

  return {
    usd,
    basis: allReported && !hasUnknown ? 'reported' : 'estimated',
    confidence,
  };
}
