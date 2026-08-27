import type { EventCost } from '@agents-hub/core';
import type { MappedEvent } from '../types.js';

/**
 * Tradução do vocabulário de eventos do `opencode serve` (v2, `GET /api/event`)
 * para o `MappedEvent` do Hub.
 *
 * Está isolado do transporte de propósito: é uma função pura de payload bruto
 * para eventos do Hub, então dá para testar o mapeamento inteiro sem servidor,
 * sem rede e sem gastar um token sequer. O formato confirmado contra o binário
 * real está em `docs/referencias/opencode-api.md`.
 */

/** Decodificador incremental de `text/event-stream`. */
export class SseDecoder {
  #buffer = '';

  /**
   * Recebe um pedaço arbitrário do corpo da resposta e devolve os JSONs
   * completos que já dá para extrair. Um chunk TCP não respeita fronteira de
   * evento — sem este acúmulo, um evento partido ao meio viraria JSON inválido
   * e sumiria da timeline.
   */
  push(chunk: string): unknown[] {
    this.#buffer += chunk.replace(/\r\n/g, '\n');
    const out: unknown[] = [];

    let cut = this.#buffer.indexOf('\n\n');
    while (cut >= 0) {
      const block = this.#buffer.slice(0, cut);
      this.#buffer = this.#buffer.slice(cut + 2);
      const parsed = decodeBlock(block);
      if (parsed !== undefined) out.push(parsed);
      cut = this.#buffer.indexOf('\n\n');
    }

    return out;
  }
}

function decodeBlock(block: string): unknown {
  const data: string[] = [];
  for (const line of block.split('\n')) {
    // `: heartbeat` é comentário SSE: mantém a conexão viva e não carrega evento.
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;

  try {
    return JSON.parse(data.join('\n')) as unknown;
  } catch {
    return undefined;
  }
}

/** `sessionID` do evento, quando ele pertence a alguma sessão. */
export function openCodeSessionId(raw: unknown): string | null {
  const data = record(record(raw)?.['data']);
  return data ? text(data, 'sessionID') : null;
}

/**
 * O loop do agente ficou ocioso — caminho rápido de fim de turno.
 *
 * Não é o único: uma execução real mostrou turno falhando sem nunca emitir
 * idle, por isso o adapter também vigia `GET /api/session/active`.
 */
export function openCodeIdleSignal(raw: unknown): boolean {
  const event = record(raw);
  const type = event ? text(event, 'type') : null;
  if (type === 'session.idle') return true;
  if (type !== 'session.status') return false;
  const status = record(record(event?.['data'])?.['status']);
  return status !== null && text(status, 'type') === 'idle';
}

export function translateOpenCodeEvent(raw: unknown): MappedEvent[] {
  const event = record(raw);
  if (!event) return [];

  const type = text(event, 'type');
  if (!type) return [];

  const data = record(event['data']) ?? {};
  const sessionId = text(data, 'sessionID');
  const emit = (
    hubType: MappedEvent['type'],
    payload: Record<string, unknown>,
    cost?: EventCost,
  ): MappedEvent => {
    const mapped: MappedEvent = { type: hubType, payload, raw };
    // Qualquer evento de sessão serve para revelar o id nativo: é ele que faz
    // o resume nativo funcionar, e quanto antes o domínio o conhecer, menor a
    // janela em que um crash perderia a sessão.
    if (sessionId) mapped.nativeSessionId = sessionId;
    if (cost) mapped.cost = cost;
    return mapped;
  };

  switch (type) {
    case 'session.created':
      return [emit('session.started', { sessionId, info: data['info'] })];

    case 'session.idle':
      return [emit('session.ended', { reason: 'idle' })];

    case 'session.status': {
      const status = record(data['status']);
      const kind = status ? text(status, 'type') : null;
      if (kind === 'idle') return [emit('session.ended', { reason: 'idle' })];
      return [emit('log', { opencodeType: type, status: kind, detail: status })];
    }

    case 'session.error': {
      const error = record(data['error']);
      const detail = record(error?.['data']);
      return [
        emit('error', {
          message: (detail ? text(detail, 'message') : null) ?? text(error ?? {}, 'name') ?? 'erro desconhecido do OpenCode',
          name: error ? text(error, 'name') : null,
        }),
      ];
    }

    case 'session.next.prompt.admitted':
    case 'session.next.prompted':
      return [
        emit('log', {
          opencodeType: type,
          messageId: text(data, 'messageID'),
          delivery: text(data, 'delivery'),
          text: text(record(data['prompt']) ?? {}, 'text'),
        }),
      ];

    case 'session.next.step.started':
      return [
        emit('turn.started', {
          messageId: text(data, 'assistantMessageID'),
          agent: text(data, 'agent'),
          model: record(data['model']),
        }),
      ];

    case 'session.next.step.ended': {
      const files = list(data['files']).filter((f): f is string => typeof f === 'string');
      const changed = files.map((file) => emit('file.changed', { path: file }));
      return [
        ...changed,
        emit(
          'turn.completed',
          {
            messageId: text(data, 'assistantMessageID'),
            finish: text(data, 'finish'),
            files,
          },
          stepCost(data),
        ),
      ];
    }

    case 'session.next.step.failed':
      return [
        emit('error', {
          messageId: text(data, 'assistantMessageID'),
          message: text(record(data['error']) ?? {}, 'message') ?? 'passo falhou sem mensagem',
        }),
      ];

    case 'session.next.text.delta':
      return [emit('message.delta', { text: text(data, 'delta'), textId: text(data, 'textID') })];

    case 'session.next.text.ended':
      return [
        emit('message', {
          role: 'assistant',
          text: text(data, 'text'),
          messageId: text(data, 'assistantMessageID'),
        }),
      ];

    case 'session.next.reasoning.ended':
      return [emit('reasoning', { text: text(data, 'text') })];

    case 'session.next.tool.called':
      return [
        emit('tool.call', {
          callId: text(data, 'callID'),
          name: text(data, 'tool'),
          input: record(data['input']),
        }),
      ];

    case 'session.next.tool.success':
      return [
        emit('tool.result', {
          callId: text(data, 'callID'),
          ok: true,
          content: data['content'] ?? null,
          outputPaths: list(data['outputPaths']),
        }),
      ];

    case 'session.next.tool.failed':
      return [
        emit('tool.result', {
          callId: text(data, 'callID'),
          ok: false,
          message: text(record(data['error']) ?? {}, 'message'),
        }),
      ];

    case 'session.next.shell.started':
      return [
        emit('command.executed', {
          callId: text(data, 'callID'),
          command: text(data, 'command'),
          kind: 'shell',
        }),
      ];

    case 'session.next.shell.ended':
      return [emit('tool.result', { callId: text(data, 'callID'), ok: true, output: text(data, 'output') })];

    case 'command.executed':
      return [
        emit('command.executed', {
          command: text(data, 'name'),
          arguments: text(data, 'arguments'),
          kind: 'slash',
        }),
      ];

    case 'session.next.retried':
      return [
        emit('log', {
          opencodeType: type,
          attempt: number(data, 'attempt'),
          message: text(record(data['error']) ?? {}, 'message'),
        }),
      ];

    case 'permission.asked':
    case 'permission.v2.asked':
      return [
        emit('approval.requested', {
          requestId: text(data, 'id'),
          action: text(data, 'action') ?? text(data, 'permission'),
          resources: list(data['resources']),
          tool: text(data, 'tool'),
        }),
      ];

    case 'permission.replied':
    case 'permission.v2.replied':
      return [
        emit('approval.resolved', {
          requestId: text(data, 'requestID'),
          reply: data['reply'] ?? null,
        }),
      ];

    // `file.edited` traz só `{ file }`, sem `sessionID`. Num servidor com várias
    // sessões do Hub, atribuí-lo a uma delas seria chute — os arquivos alterados
    // vêm de `step.ended.files`, que é por sessão.
    case 'file.edited':
      return [];

    default:
      // Só o que pertence a uma sessão vira log: o stream é global e carrega
      // ruído de servidor (pty, lsp, watcher, upgrade) que não é da run.
      return sessionId ? [emit('log', { opencodeType: type, data })] : [];
  }
}

/**
 * Custo por passo — o que a CLI headless simplesmente não entrega.
 *
 * `reasoning` entra em `outputTokens` porque é token gerado e cobrado como
 * saída; separá-lo faria o total do Hub não bater com a fatura do provedor.
 */
function stepCost(data: Record<string, unknown>): EventCost | undefined {
  const tokens = record(data['tokens']);
  const usd = number(data, 'cost');
  if (!tokens && usd === null) return undefined;

  const cache = record(tokens?.['cache']);
  const input = tokens ? number(tokens, 'input') : null;
  const output = tokens ? number(tokens, 'output') : null;
  const reasoning = tokens ? number(tokens, 'reasoning') : null;
  const cachedRead = cache ? number(cache, 'read') : null;
  const cachedWrite = cache ? number(cache, 'write') : null;

  const cost: EventCost = {};
  if (usd !== null) cost.usd = usd;
  if (input !== null) cost.inputTokens = input;
  if (output !== null) cost.outputTokens = output + (reasoning ?? 0);
  if (cachedRead !== null || cachedWrite !== null) {
    cost.cachedTokens = (cachedRead ?? 0) + (cachedWrite ?? 0);
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function number(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
