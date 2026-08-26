import type { MappedEvent } from '../types.js';
import { numberOf } from './generic.js';

/**
 * Mapper do Claude Code — `claude -p --output-format stream-json --verbose`.
 *
 * Formato observado (uma linha JSON por evento):
 *   {"type":"system","subtype":"init","session_id":"...","tools":[...]}
 *   {"type":"assistant","message":{"content":[{"type":"text",...},{"type":"tool_use",...}],"usage":{...}}}
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
 *   {"type":"result","subtype":"success","total_cost_usd":0.01,"usage":{...},"session_id":"..."}
 */
export function claudeMapper(line: unknown): MappedEvent[] {
  if (line === null || typeof line !== 'object') return [];
  const obj = line as Record<string, unknown>;
  const type = obj['type'];
  const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id'] : undefined;

  switch (type) {
    case 'system': {
      const event: MappedEvent = {
        type: obj['subtype'] === 'init' ? 'session.started' : 'log',
        payload: { subtype: obj['subtype'], tools: obj['tools'], model: obj['model'] },
        raw: line,
      };
      if (sessionId) event.nativeSessionId = sessionId;
      return [event];
    }

    case 'assistant': {
      const message = obj['message'] as Record<string, unknown> | undefined;
      const blocks = Array.isArray(message?.['content']) ? message['content'] : [];
      const events: MappedEvent[] = [];

      for (const block of blocks as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          events.push({ type: 'message', payload: { text: block['text'] }, raw: block });
        } else if (block['type'] === 'thinking') {
          events.push({
            type: 'reasoning',
            payload: { text: block['thinking'] ?? '' },
            raw: block,
          });
        } else if (block['type'] === 'tool_use') {
          events.push({
            type: classifyToolCall(block['name']),
            payload: {
              tool: block['name'],
              input: block['input'],
              toolUseId: block['id'],
              ...describeTool(block['name'], block['input']),
            },
            raw: block,
          });
        }
      }

      const usage = message?.['usage'] as Record<string, unknown> | undefined;
      if (usage && events.length > 0) {
        const last = events[events.length - 1];
        if (last) {
          last.cost = {
            inputTokens: numberOf(usage['input_tokens']),
            outputTokens: numberOf(usage['output_tokens']),
            cachedTokens: numberOf(usage['cache_read_input_tokens']),
          };
        }
      }

      return events;
    }

    case 'user': {
      const message = obj['message'] as Record<string, unknown> | undefined;
      const blocks = Array.isArray(message?.['content']) ? message['content'] : [];
      return (blocks as Array<Record<string, unknown>>)
        .filter((b) => b['type'] === 'tool_result')
        .map((b) => ({
          type: 'tool.result' as const,
          payload: {
            toolUseId: b['tool_use_id'],
            isError: b['is_error'] === true,
            content: truncate(b['content']),
          },
          raw: b,
        }));
    }

    case 'result': {
      const usage = obj['usage'] as Record<string, unknown> | undefined;
      const isError = obj['subtype'] !== 'success' || obj['is_error'] === true;
      const event: MappedEvent = {
        type: isError ? 'error' : 'turn.completed',
        payload: {
          subtype: obj['subtype'],
          summary: obj['result'],
          durationMs: obj['duration_ms'],
          numTurns: obj['num_turns'],
        },
        cost: {
          usd: numberOf(obj['total_cost_usd']),
          inputTokens: numberOf(usage?.['input_tokens']),
          outputTokens: numberOf(usage?.['output_tokens']),
          cachedTokens: numberOf(usage?.['cache_read_input_tokens']),
        },
        raw: line,
      };
      if (sessionId) event.nativeSessionId = sessionId;
      return [event];
    }

    default:
      return [{ type: 'log', payload: { data: obj }, raw: line }];
  }
}

/**
 * Ferramentas de execução e escrita ganham tipos próprios porque a UI e o
 * motor de política tratam esses eventos de forma diferente de um tool call
 * qualquer — são eles que carregam risco.
 */
function classifyToolCall(name: unknown): MappedEvent['type'] {
  if (name === 'Bash' || name === 'PowerShell') return 'command.executed';
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') return 'file.changed';
  return 'tool.call';
}

function describeTool(name: unknown, input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {};
  const i = input as Record<string, unknown>;
  if (name === 'Bash' || name === 'PowerShell') return { command: i['command'] };
  if (name === 'Write' || name === 'Edit') return { path: i['file_path'] };
  return {};
}

function truncate(value: unknown, max = 4000): unknown {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}… [${value.length} chars]` : value;
}
