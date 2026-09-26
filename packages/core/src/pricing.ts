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

/**
 * Data (ISO, UTC) em que os preços desta tabela foram conferidos nas fontes.
 *
 * Revisão de 2026-09-26 (Fase 3.4 do goal, vistoria 2026-09-25): todas as
 * linhas conferidas nas páginas OFICIAIS de cada provedor (URL em `source`).
 * Correções: leitura de cache do Kimi K2.6 (0,19 → 0,16, publicada); fontes
 * de agregador trocadas por primárias (Codex → páginas de modelo da OpenAI;
 * Kimi → platform.kimi.ai); entraram Opus 5.5 (padrão do Claude Code), Fable
 * 5.1, GPT-6, Gemini 3.8 Flash/2.5 Flash, MiMo V2.6, Grok 4.7 e os `-pro` da
 * OpenAI — antes o casamento por prefixo dava a eles o preço do irmão errado
 * (Opus 5.5 saía como Opus 5; GPT-5.5 Pro ~6x abaixo).
 * NÃO verificados (fora da página oficial hoje): `kimi-k2-5` e `kimi-k2`,
 * mantidos com os valores de 2026-08-27.
 */
export const PRICING_COLLECTED_AT = '2026-09-26';

/**
 * Copilot fatura em AI Credits, e 1 AI Credit = US$ 0,01 (docs.github.com,
 * "Models and pricing for GitHub Copilot" e "GitHub Copilot billing",
 * conferidos em 2026-09-26; os premium requests foram substituídos por AI
 * Credits em 01/06/2026). Sanidade no caso real da vistoria: 0,53 créditos =
 * US$ 0,0053, e o mesmo uso (gpt-5.6-luna: 19k escrita de cache, 37k leitura,
 * 322 saída) dá US$ 0,0059 pela tabela da OpenAI.
 */
export const COPILOT_USD_PER_AI_CREDIT = 0.01;

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
   * Escrita de cache (janela curta), quando o provedor cobra separado. Usado
   * quando o agente reporta `cacheWriteTokens` (o Claude reporta
   * `cache_creation_input_tokens`); ausente, a escrita é cobrada como entrada.
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
/** Codex fora da página de pricing: o preço está na página de cada modelo. */
const OPENAI_MODEL_SRC = (modelo: string): string =>
  `https://developers.openai.com/api/docs/models/${modelo}`;
const GOOGLE_SRC = 'https://ai.google.dev/gemini-api/docs/pricing';
const MOONSHOT_SRC = 'https://platform.kimi.ai/docs/pricing/chat';
const XIAOMI_SRC = 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go';
const CURSOR_SRC = 'https://cursor.com/docs/models-and-pricing';

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
  // Escrita de cache aqui é a de 5 min (1,25x); a de 1 h custa 2x e não é
  // distinguível pelo `usage` do stream. Fast mode (Opus 5.5: 8/40; Opus 5 e
  // 4.8: 10/50) e o multiplicador de 1,1x de `inference_geo: us` também não.
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    vendor: 'Anthropic',
    aliases: ['claude-opus-5-5', 'claude-5-5-opus'],
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
    note: 'Padrão do Claude Code desde a v2.1.280 (code.claude.com/docs/en/model-config).',
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    vendor: 'Anthropic',
    aliases: ['claude-fable-5-1', 'fable-5-1', 'claude-mythos-5-1'],
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 12.5,
    cacheAccounting: 'disjoint',
    source: ANTHROPIC_SRC,
    collectedAt: D,
    note: 'Leitura de cache a 0,025x da entrada (não 0,1x). Mythos 5.1 tem o mesmo preço.',
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    vendor: 'Anthropic',
    aliases: ['claude-fable-5', 'fable-5', 'claude-mythos-5'],
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
    note: 'Fast mode (research preview) cobra 10/50 — não modelado aqui (variante `-fast` casa como família).',
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
    note: 'Aposentado na API de primeira parte; ainda servido em Bedrock/Vertex.',
  },

  // ─── OpenAI (família do Codex) ────────────────────────────────────────────
  // Regras gerais que NÃO estão modeladas: fast mode (ex-"priority") 2x;
  // Batch/Flex 50%; acima de 272k de entrada, 2x na entrada/cache e 1,5x na
  // saída (GPT-5.4 em diante).
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    vendor: 'OpenAI',
    aliases: ['gpt-6-sol', 'gpt-6'],
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
    note: 'Modelo recomendado pelo Codex hoje (developers.openai.com/codex/models).',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    vendor: 'OpenAI',
    aliases: ['gpt-6-luna'],
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0.125,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    vendor: 'OpenAI',
    aliases: ['gpt-6-astra'],
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheWritePerMTok: 12.5,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-5-pro',
    label: 'GPT-5.5 Pro',
    vendor: 'OpenAI',
    aliases: ['gpt-5-5-pro'],
    inputPerMTok: 30,
    outputPerMTok: 180,
    // Sem desconto de cache publicado para os `-pro`: cache cobra como entrada.
    cacheReadPerMTok: 30,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-4-pro',
    label: 'GPT-5.4 Pro',
    vendor: 'OpenAI',
    aliases: ['gpt-5-4-pro'],
    inputPerMTok: 30,
    outputPerMTok: 180,
    cacheReadPerMTok: 30,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-2-pro',
    label: 'GPT-5.2 Pro',
    vendor: 'OpenAI',
    aliases: ['gpt-5-2-pro'],
    inputPerMTok: 21,
    outputPerMTok: 168,
    cacheReadPerMTok: 21,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-pro',
    label: 'GPT-5 Pro',
    vendor: 'OpenAI',
    aliases: ['gpt-5-pro'],
    inputPerMTok: 15,
    outputPerMTok: 120,
    cacheReadPerMTok: 15,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
  },
  {
    id: 'gpt-5-1-codex-max',
    label: 'GPT-5.1-Codex-Max',
    vendor: 'OpenAI',
    aliases: ['gpt-5-1-codex-max'],
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheAccounting: 'subset',
    source: OPENAI_MODEL_SRC('gpt-5.1-codex-max'),
    collectedAt: D,
  },
  {
    id: 'gpt-5-1-codex',
    label: 'GPT-5.1-Codex',
    vendor: 'OpenAI',
    aliases: ['gpt-5-1-codex'],
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheAccounting: 'subset',
    source: OPENAI_MODEL_SRC('gpt-5.1-codex'),
    collectedAt: D,
  },
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
    note: 'Deprecated no Codex com login ChatGPT (developers.openai.com/codex/models). Fast mode 3,50/28.',
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
    source: OPENAI_MODEL_SRC('gpt-5.2-codex'),
    collectedAt: D,
    note: 'Fora da página de pricing; o preço está na página do modelo.',
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
    source: OPENAI_MODEL_SRC('gpt-5-codex'),
    collectedAt: D,
    note: 'Fora da página de pricing; o preço está na página do modelo.',
  },
  {
    id: 'gpt-5-6-sol',
    label: 'GPT-5.6 Sol',
    vendor: 'OpenAI',
    aliases: ['gpt-5-6-sol'],
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.4,
    cacheWritePerMTok: 5,
    cacheAccounting: 'subset',
    source: OPENAI_SRC,
    collectedAt: D,
    note: 'Preço promocional "at least through November 21, 2026".',
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
    cacheWritePerMTok: 2.5,
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
    cacheWritePerMTok: 0.25,
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
    // Sem o alias genérico `gemini-3`: ele casava `gemini-3-8-flash` e
    // `gemini-3-flash-preview` e cobrava deles o preço do Pro.
    aliases: ['gemini-3-1-pro', 'gemini-3-pro'],
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
    note: 'Nome oficial `gemini-3.1-pro-preview`. Acima de 200k tokens vira 4,00/18,00/0,40 — não modelado aqui.',
  },
  {
    id: 'gemini-3-8-flash',
    label: 'Gemini 3.8 Flash',
    vendor: 'Google',
    aliases: ['gemini-3-8-flash'],
    inputPerMTok: 0.75,
    outputPerMTok: 3.75,
    cacheReadPerMTok: 0.075,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
    note: 'Preço promocional até 31/12/2026; dobra em 01/01/2027.',
  },
  {
    id: 'gemini-3-flash',
    label: 'Gemini 3 Flash (preview)',
    vendor: 'Google',
    aliases: ['gemini-3-flash'],
    inputPerMTok: 0.5,
    outputPerMTok: 3,
    cacheReadPerMTok: 0.05,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
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
    note: 'Acima de 200k tokens vira 2,50/15/0,25 — não modelado aqui.',
  },
  {
    id: 'gemini-2-5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    vendor: 'Google',
    aliases: ['gemini-2-5-flash-lite'],
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.01,
    cacheAccounting: 'subset',
    source: GOOGLE_SRC,
    collectedAt: D,
  },
  {
    id: 'gemini-2-5-flash',
    label: 'Gemini 2.5 Flash',
    vendor: 'Google',
    aliases: ['gemini-2-5-flash'],
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.03,
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
    cacheWritePerMTok: 3,
    cacheAccounting: 'subset',
    source: MOONSHOT_SRC,
    collectedAt: D,
    note: 'Escrita de cache de 1 h custa 6,00 — não modelada.',
  },
  {
    id: 'kimi-k2-7-code-highspeed',
    label: 'Kimi K2.7 Code (highspeed)',
    vendor: 'Moonshot AI',
    aliases: ['kimi-k2-7-code-highspeed'],
    inputPerMTok: 1.9,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.38,
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
    // Era 0,19 ("não publicado, assumido"); a página oficial publica 0,16.
    cacheReadPerMTok: 0.16,
    cacheAccounting: 'subset',
    source: MOONSHOT_SRC,
    collectedAt: D,
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
    source: 'https://benchlm.ai/moonshot/api-pricing',
    collectedAt: '2026-08-27',
    note: 'NÃO VERIFICADO: saiu da página oficial (2026-09-26); valores da coleta anterior, por agregador.',
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
    source: 'https://benchlm.ai/moonshot/api-pricing',
    collectedAt: '2026-08-27',
    note: 'NÃO VERIFICADO: saiu da página oficial (2026-09-26); valores da coleta anterior, por agregador.',
  },

  // ─── Xiaomi (MiMo Code) ───────────────────────────────────────────────────
  // Tarifa internacional em USD. A tarifa doméstica (CNY) é bem diferente e
  // NÃO está modelada: quem roda o MiMo na conta chinesa vai ver estimativa
  // errada para mais.
  {
    id: 'mimo-v2-6-pro-ultraspeed',
    label: 'MiMo-V2.6-Pro (ultraspeed)',
    vendor: 'Xiaomi',
    aliases: ['mimo-v2-6-pro-ultraspeed'],
    inputPerMTok: 4.35,
    outputPerMTok: 8.7,
    cacheReadPerMTok: 0.036,
    cacheAccounting: 'subset',
    source: XIAOMI_SRC,
    collectedAt: D,
  },
  {
    id: 'mimo-v2-6-pro',
    label: 'MiMo-V2.6-Pro',
    vendor: 'Xiaomi',
    aliases: ['mimo-v2-6-pro'],
    inputPerMTok: 0.435,
    outputPerMTok: 0.87,
    cacheReadPerMTok: 0.0036,
    cacheAccounting: 'subset',
    source: XIAOMI_SRC,
    collectedAt: D,
  },
  {
    id: 'mimo-v2-6-flash',
    label: 'MiMo-V2.6-Flash',
    vendor: 'Xiaomi',
    aliases: ['mimo-v2-6-flash', 'mimo-v2-6'],
    inputPerMTok: 0.14,
    outputPerMTok: 0.28,
    cacheReadPerMTok: 0.0028,
    cacheAccounting: 'subset',
    source: XIAOMI_SRC,
    collectedAt: D,
  },
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
    note: 'Descontinuado às 10:00 (Pequim) de 21/10/2026; sucessor V2.6-Pro, mesmo preço.',
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
    note: 'Descontinuado em 21/10/2026; sucessor V2.6-Flash, mesmo preço.',
  },

  // ─── Cursor (modelos próprios) ────────────────────────────────────────────
  // Os modelos de terceiros que o Cursor revende já estão acima, com o mesmo
  // preço de tabela. Nos planos Teams/Enterprise o Cursor cobra ainda
  // US$ 0,25/MTok de "Cursor Token Rate" sobre terceiros (Grok e Composer são
  // isentos) — taxa NÃO aplicada aqui, então nesses planos a estimativa com
  // modelo de terceiro sai levemente para baixo.
  {
    id: 'cursor-composer-2-5',
    label: 'Cursor Composer 2.5',
    vendor: 'Anysphere',
    // Sem o alias genérico `composer`: uma versão nova do Composer herdaria o
    // preço desta como se fosse "modelo exato". `composer` sozinho cai no
    // fallback do agente `cursor`, marcado como `agent-default`.
    aliases: ['composer-2-5', 'cursor-composer-2-5'],
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
    id: 'grok-4-7-500k-fast',
    label: 'Grok 4.7 500k (Fast)',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-7-500k-fast'],
    inputPerMTok: 6,
    outputPerMTok: 18,
    cacheReadPerMTok: 1.5,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'grok-4-7-500k',
    label: 'Grok 4.7 500k',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-7-500k'],
    inputPerMTok: 4,
    outputPerMTok: 12,
    cacheReadPerMTok: 1,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'grok-4-7-fast',
    label: 'Grok 4.7 (Fast)',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-7-fast'],
    inputPerMTok: 4,
    outputPerMTok: 12,
    cacheReadPerMTok: 1,
    cacheAccounting: 'subset',
    source: CURSOR_SRC,
    collectedAt: D,
  },
  {
    id: 'grok-4-7',
    label: 'Grok 4.7',
    vendor: 'xAI (via Cursor)',
    aliases: ['grok-4-7'],
    inputPerMTok: 2,
    outputPerMTok: 6,
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
  // Padrão do Claude Code desde a v2.1.280 (code.claude.com/docs/en/model-config).
  claude: 'claude-opus-5-5',
  // Recomendado hoje pelo Codex; o gpt-5.3-codex está deprecated no Codex.
  codex: 'gpt-6-sol',
  // Padrão do Antigravity NÃO confirmado em fonte oficial (há indício de
  // gemini-3.8-flash); fica o Pro, que é o mais caro dos candidatos.
  antigravity: 'gemini-3-1-pro',
  // Padrão do Kimi Code CLI não é documentado (usuário escolhe na lista).
  kimi: 'kimi-k2-7-code',
  // V2.5-Pro sai do ar em 21/10/2026; o sucessor tem o mesmo preço.
  mimo: 'mimo-v2-6-pro',
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
  /**
   * Tabela, mas por uma VARIANTE que não está na tabela (`gpt-5-3-codex-spark`
   * pelo preço do `gpt-5-3-codex`, `claude-opus-5-fast` pelo do Opus 5):
   * mesma família, preço possivelmente diferente.
   */
  | 'family'
  /** Tabela, mas pelo modelo padrão do agente — estimativa grosseira. */
  | 'agent-default'
  /** Soma com parcela de custo desconhecido: o real é PELO MENOS isto. */
  | 'partial'
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
  /** Tokens escritos no cache; ver `ModelPrice.cacheWritePerMTok`. */
  cacheWriteTokens?: number;
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
    .replace(/\[[^\]]*\]$/, '') // janela de contexto do Claude Code: `claude-opus-5-5[1m]`
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
  return matchModelPrice(raw)?.price ?? null;
}

/**
 * Sufixos que não mudam o preço: data (`-20251101`, `-2025-08-07`), versão de
 * publicação (`-v1`), `-latest`, `-preview`, `-exp`. Qualquer outro sufixo
 * (`-fast`, `-spark`, `-max`, `-pro`) pode ser outro produto com outro preço.
 */
const SUFIXO_NEUTRO = /^(?:-(?:\d{2,8}|v\d+|latest|preview|exp))+$/;

/** Casa o modelo e diz se foi exato (alias ou alias + sufixo neutro) ou por família. */
function matchModelPrice(
  raw: string | null | undefined,
): { price: ModelPrice; exact: boolean } | null {
  const id = normalizeModelId(raw);
  if (id === null) return null;
  for (const entry of ALIAS_INDEX) {
    if (id === entry.alias) return { price: entry.price, exact: true };
    if (id.startsWith(`${entry.alias}-`)) {
      return { price: entry.price, exact: SUFIXO_NEUTRO.test(id.slice(entry.alias.length)) };
    }
  }
  return null;
}

/** Descarta NaN, Infinity e negativos, que aparecem em payload malformado. */
function tokens(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function priceUsage(usage: TokenUsage, price: ModelPrice): number {
  const output = tokens(usage.outputTokens);
  const rawInput = tokens(usage.inputTokens);
  let cached = tokens(usage.cachedTokens);
  let written = tokens(usage.cacheWriteTokens);

  // Onde o cache está contido em `inputTokens` (OpenAI e compatíveis), cobrar
  // os dois cheios contaria o cache duas vezes. E cache MAIOR que a entrada é
  // payload incoerente: antes cobrava o cache cheio (US$ 0,175 por 100 tokens
  // de entrada); agora o cache nunca passa da entrada.
  let billableInput = rawInput;
  if (price.cacheAccounting === 'subset') {
    cached = Math.min(cached, rawInput);
    written = Math.min(written, rawInput - cached);
    billableInput = rawInput - cached - written;
  }

  const usd =
    (billableInput * price.inputPerMTok +
      output * price.outputPerMTok +
      cached * price.cacheReadPerMTok +
      written * (price.cacheWritePerMTok ?? price.inputPerMTok)) /
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
  const byModel = matchModelPrice(context.model);
  if (byModel) {
    return {
      usd: priceUsage(usage, byModel.price),
      basis: 'estimated',
      confidence: byModel.exact ? 'model' : 'family',
      model: byModel.price.id,
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
  // se sabe é que o gasto real é PELO MENOS isso — `partial`, não
  // `agent-default` (que dizia "veio do modelo padrão do agente" sem nenhum
  // agente-padrão envolvido). Sem desconhecida, vale a PIOR garantia das
  // parcelas estimadas.
  const pior = (['agent-default', 'family', 'model'] as const).find((c) =>
    known.some((p) => p.confidence === c),
  );
  const confidence: CostConfidence = hasUnknown
    ? 'partial'
    : allReported
      ? 'exact'
      : (pior ?? 'model');

  return {
    usd,
    basis: allReported && !hasUnknown ? 'reported' : 'estimated',
    confidence,
  };
}
