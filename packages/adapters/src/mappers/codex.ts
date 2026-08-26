import type { MappedEvent } from '../types.js';
import { firstString, numberOf } from './generic.js';

/**
 * Mapper do Codex CLI — `codex exec --json`, saída JSONL.
 *
 * Eventos documentados: `thread.started`, `turn.started`, `turn.completed`,
 * `turn.failed`, `item.started` / `item.updated` / `item.completed`, `error`.
 * Tipos de item: agent_message, reasoning, command_execution, file_change,
 * mcp_tool_call, web_search, todo_list.
 */
export function codexMapper(line: unknown): MappedEvent[] {
  if (line === null || typeof line !== 'object') return [];
  const obj = line as Record<string, unknown>;
  const type = obj['type'];

  switch (type) {
    case 'thread.started': {
      const threadId = firstString(obj['thread_id']);
      const event: MappedEvent = {
        type: 'session.started',
        payload: { threadId },
        raw: line,
      };
      if (threadId) event.nativeSessionId = threadId;
      return [event];
    }

    case 'turn.started':
      return [{ type: 'turn.started', payload: {}, raw: line }];

    case 'turn.completed': {
      const usage = obj['usage'] as Record<string, unknown> | undefined;
      return [
        {
          type: 'turn.completed',
          payload: { summary: firstString(obj['summary']) },
          cost: {
            inputTokens: numberOf(usage?.['input_tokens']),
            outputTokens: numberOf(usage?.['output_tokens']),
            cachedTokens: numberOf(usage?.['cached_input_tokens']),
          },
          raw: line,
        },
      ];
    }

    case 'turn.failed':
      return [
        {
          type: 'error',
          payload: { message: describeError(obj['error']) ?? 'turno falhou' },
          raw: line,
        },
      ];

    case 'error':
      return [
        {
          type: 'error',
          payload: { message: firstString(obj['message']) ?? describeError(obj) ?? 'erro' },
          raw: line,
        },
      ];

    // Só o item completo interessa para a timeline; started/updated viram ruído.
    case 'item.completed':
    case 'item.started':
    case 'item.updated': {
      if (type !== 'item.completed') return [];
      return mapItem(obj['item'], line);
    }

    default:
      return [{ type: 'log', payload: { data: obj }, raw: line }];
  }
}

function mapItem(item: unknown, raw: unknown): MappedEvent[] {
  if (item === null || typeof item !== 'object') return [];
  const i = item as Record<string, unknown>;

  switch (i['type']) {
    case 'agent_message':
      return [{ type: 'message', payload: { text: firstString(i['text']) ?? '' }, raw }];

    case 'reasoning':
      return [{ type: 'reasoning', payload: { text: firstString(i['text']) ?? '' }, raw }];

    case 'command_execution':
      return [
        {
          type: 'command.executed',
          payload: {
            command: firstString(i['command']),
            exitCode: numberOf(i['exit_code']),
            output: firstString(i['aggregated_output']),
            status: i['status'],
          },
          raw,
        },
      ];

    case 'file_change': {
      const changes = Array.isArray(i['changes']) ? i['changes'] : [];
      return [
        {
          type: 'file.changed',
          payload: {
            status: i['status'],
            files: (changes as Array<Record<string, unknown>>).map((c) => ({
              path: firstString(c['path']),
              kind: c['kind'],
            })),
          },
          raw,
        },
      ];
    }

    case 'mcp_tool_call':
      return [
        {
          type: 'tool.call',
          payload: { server: i['server'], tool: i['tool'], status: i['status'] },
          raw,
        },
      ];

    case 'web_search':
      return [{ type: 'tool.call', payload: { tool: 'web_search', query: i['query'] }, raw }];

    case 'todo_list':
      return [{ type: 'log', payload: { todos: i['items'] }, raw }];

    default:
      return [{ type: 'log', payload: { item: i }, raw }];
  }
}

function describeError(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return firstString(v['message']) ?? JSON.stringify(v).slice(0, 500);
  }
  return undefined;
}
