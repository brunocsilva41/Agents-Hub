import type { MappedEvent } from '../types.js';

/**
 * Fallback textual: cada linha de stdout vira uma mensagem.
 *
 * Não é elegante, mas é o que permite plugar um agente novo hoje e ainda ter
 * timeline, custo manual e controles ao vivo — em vez de esperar alguém
 * escrever um mapper dedicado.
 */
export function genericTextMapper(line: unknown): MappedEvent[] {
  const text = typeof line === 'string' ? line : String(line ?? '');
  if (text.trim().length === 0) return [];

  const lowered = text.toLowerCase();
  const looksLikeError =
    lowered.includes('error:') || lowered.includes('fatal:') || lowered.startsWith('error ');

  return [
    {
      type: looksLikeError ? 'error' : 'message',
      payload: { text },
      raw: line,
    },
  ];
}

/**
 * Fallback estruturado: JSON desconhecido preservado como `log`, com uma
 * tentativa de achar campos comuns (`text`, `message`, `content`, `usage`).
 */
export function genericJsonMapper(line: unknown): MappedEvent[] {
  if (typeof line === 'string') return genericTextMapper(line);
  if (line === null || typeof line !== 'object') return [];

  const obj = line as Record<string, unknown>;
  const text =
    firstString(obj['text']) ?? firstString(obj['message']) ?? firstString(obj['content']);
  const usage = obj['usage'];

  const event: MappedEvent = {
    type: text ? 'message' : 'log',
    payload: text ? { text } : { data: obj },
    raw: line,
  };

  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    event.cost = {
      inputTokens: numberOf(u['input_tokens'] ?? u['prompt_tokens'] ?? u['inputTokens']),
      outputTokens: numberOf(u['output_tokens'] ?? u['completion_tokens'] ?? u['outputTokens']),
    };
  }

  return [event];
}

export function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
