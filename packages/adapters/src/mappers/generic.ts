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
 *
 * Também entende, sem precisar de mapper próprio, os dois envelopes que caem
 * aqui hoje:
 *
 * - `run --format json` da família OpenCode (MiMo 0.1.14, conferido no bundle
 *   do `mimo.exe`): `{type, timestamp, sessionID, part}` com `type` em
 *   `step_start | text | reasoning | tool_use | step_finish | error`; custo e
 *   tokens vêm em `part.cost`/`part.tokens` do `step_finish`.
 * - stream-json no estilo Claude (Cursor): `session_id` no topo,
 *   `message.content[]` com blocos `text`, `usage` no `result`.
 *
 * Sem `nativeSessionId` o resume nativo desses agentes nunca acontecia (todo
 * turno caía em replay) — por isso o id é extraído de qualquer linha que o
 * traga (`sessionID`, `session_id`, `sessionId`).
 */
export function genericJsonMapper(line: unknown): MappedEvent[] {
  if (typeof line === 'string') return genericTextMapper(line);
  if (line === null || typeof line !== 'object') return [];

  const obj = line as Record<string, unknown>;
  const tipo = firstString(obj['type']);
  const part = objeto(obj['part']);

  const event = eventoDe(obj, tipo, part, line);

  const sessionId =
    firstString(obj['sessionID']) ?? firstString(obj['session_id']) ?? firstString(obj['sessionId']);
  if (sessionId) event.nativeSessionId = sessionId;

  const cost = custoDe(obj, part);
  if (cost) event.cost = cost;

  return [event];
}

function eventoDe(
  obj: Record<string, unknown>,
  tipo: string | undefined,
  part: Record<string, unknown> | null,
  line: unknown,
): MappedEvent {
  // Envelope OpenCode (`run --format json`).
  if (part) {
    switch (tipo) {
      case 'text': {
        const text = firstString(part['text']);
        if (text) return { type: 'message', payload: { text }, raw: line };
        break;
      }
      case 'reasoning': {
        const text = firstString(part['text']);
        if (text) return { type: 'reasoning', payload: { text }, raw: line };
        break;
      }
      case 'tool_use':
        return ferramentaOpenCode(part, line);
      case 'step_start':
        return { type: 'turn.started', payload: {}, raw: line };
      case 'step_finish':
        return {
          type: 'log',
          payload: { text: `passo concluído (${firstString(part['reason']) ?? 'sem motivo'})`, reason: part['reason'] ?? null },
          raw: line,
        };
      default:
        break;
    }
  }

  if (tipo === 'error') {
    const erro = objeto(obj['error']);
    const dados = objeto(erro?.['data']);
    const message =
      firstString(dados?.['message']) ??
      firstString(erro?.['message']) ??
      firstString(obj['error']) ??
      firstString(erro?.['name']) ??
      firstString(obj['message']) ??
      'erro sem mensagem';
    return { type: 'error', payload: { message }, raw: line };
  }

  // stream-json no estilo Claude: `message.content[]` com blocos de texto.
  const mensagem = objeto(obj['message']);
  if (mensagem && Array.isArray(mensagem['content'])) {
    const text = (mensagem['content'] as unknown[])
      .map((b) => objeto(b))
      .filter((b): b is Record<string, unknown> => b !== null && b['type'] === 'text')
      .map((b) => firstString(b['text']) ?? '')
      .join('');
    if (text) return { type: 'message', payload: { text }, raw: line };
  }

  const text =
    firstString(obj['text']) ?? firstString(obj['message']) ?? firstString(obj['content']);
  return {
    type: text ? 'message' : 'log',
    payload: text ? { text } : { data: obj },
    raw: line,
  };
}

/** Ferramenta concluída do envelope OpenCode — shell e escrita viram eventos vigiáveis. */
function ferramentaOpenCode(part: Record<string, unknown>, line: unknown): MappedEvent {
  const tool = firstString(part['tool']);
  const state = objeto(part['state']);
  const input = objeto(state?.['input']);
  const status = firstString(state?.['status']);
  const n = (tool ?? '').toLowerCase();

  const command = firstString(input?.['command']);
  if (command && (n.includes('bash') || n.includes('shell'))) {
    return { type: 'command.executed', payload: { tool, command, status }, raw: line };
  }
  const path = firstString(input?.['filePath']) ?? firstString(input?.['file_path']) ?? firstString(input?.['path']);
  if (path && (n.includes('write') || n.includes('edit') || n.includes('patch'))) {
    return { type: 'file.changed', payload: { tool, path, status }, raw: line };
  }
  return { type: 'tool.call', payload: { tool, input: input ?? null, status }, raw: line };
}

/**
 * Uso do evento, onde quer que o envelope o coloque: `usage` (convenção
 * OpenAI/Anthropic, em snake ou camel case) ou `part.tokens` + `part.cost`
 * (OpenCode: reasoning conta como saída; cache lido+escrito em `cachedTokens`).
 */
function custoDe(
  obj: Record<string, unknown>,
  part: Record<string, unknown> | null,
): MappedEvent['cost'] | undefined {
  const tokens = objeto(part?.['tokens']) ?? objeto(obj['tokens']);
  if (tokens) {
    const cache = objeto(tokens['cache']);
    const input = numberOf(tokens['input']);
    const output = numberOf(tokens['output']);
    const reasoning = numberOf(tokens['reasoning']);
    const cached =
      cache && (numberOf(cache['read']) !== undefined || numberOf(cache['write']) !== undefined)
        ? (numberOf(cache['read']) ?? 0) + (numberOf(cache['write']) ?? 0)
        : undefined;
    const usd = numberOf(part?.['cost']) ?? numberOf(obj['cost']);
    const cost: NonNullable<MappedEvent['cost']> = {};
    if (usd !== undefined) cost.usd = usd;
    if (input !== undefined) cost.inputTokens = input;
    if (output !== undefined) cost.outputTokens = output + (reasoning ?? 0);
    if (cached !== undefined) cost.cachedTokens = cached;
    return Object.keys(cost).length > 0 ? cost : undefined;
  }

  const usage = objeto(obj['usage']);
  if (!usage) return undefined;
  return {
    inputTokens: numberOf(usage['input_tokens'] ?? usage['prompt_tokens'] ?? usage['inputTokens']),
    outputTokens: numberOf(
      usage['output_tokens'] ?? usage['completion_tokens'] ?? usage['outputTokens'],
    ),
  };
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
