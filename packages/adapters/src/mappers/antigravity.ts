import type { MappedEvent } from '../types.js';
import { firstString, numberOf } from './generic.js';

/**
 * Mapper do Antigravity CLI (`agy -p <prompt> --output-format stream-json`).
 *
 * Formato verificado contra o binário real (agy 1.1.22):
 *   {"event":"init","conversation_id":"...","init":{"cwd":"...","tools":[...],"permission_mode":"..."}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":0,"state":"DONE","step_type":"user_input"}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"...","usage":{...}}}
 *   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS"|"ERROR","response":"...","duration_seconds":1.2,"num_turns":1,"usage":{...}}}
 */
export function antigravityMapper(line: unknown): MappedEvent[] {
  if (line === null || typeof line !== 'object') return [];
  const obj = line as Record<string, unknown>;
  const event = obj['event'];
  const conversationId = firstString(obj['conversation_id']);

  switch (event) {
    case 'init': {
      const init = (obj['init'] ?? {}) as Record<string, unknown>;
      const initConvId = firstString(init['conversation_id']) ?? conversationId;
      const mapped: MappedEvent = {
        type: 'session.started',
        payload: {
          cwd: firstString(init['cwd']),
          tools: init['tools'],
          permissionMode: firstString(init['permission_mode']),
        },
        raw: line,
      };
      if (initConvId) mapped.nativeSessionId = initConvId;
      return [mapped];
    }

    case 'step_update': {
      const step = (obj['step_update'] ?? {}) as Record<string, unknown>;
      const stepConvId = firstString(step['conversation_id']) ?? conversationId;
      const stepType = firstString(step['step_type']);

      if (stepType === 'user_input') {
        // Prompt do usuário ecoado: descartado para não duplicar na timeline
        return [];
      }

      if (stepType === 'agent_response') {
        const text = firstString(step['text_delta']) ?? firstString(step['text']) ?? firstString(step['response']);
        const usage = step['usage'] as Record<string, unknown> | undefined;
        
        if (!text && !usage) return [];

        const events: MappedEvent[] = [];
        if (text && text.trim().length > 0) {
          const isReasoning = step['is_thinking'] === true || step['thought'] === true;
          events.push({
            type: isReasoning ? 'reasoning' : 'message',
            payload: { text },
            raw: line,
          });
        }

        if (usage && events.length > 0) {
          const last = events[events.length - 1];
          if (last) {
            last.cost = {
              inputTokens: numberOf(usage['input_tokens']),
              outputTokens: numberOf(usage['output_tokens']),
              cachedTokens: numberOf(usage['cache_read_tokens']),
            };
          }
        }
        if (stepConvId && events.length > 0) {
          events[0]!.nativeSessionId = stepConvId;
        }
        return events;
      }

      if (stepType === 'error_message' || step['state'] === 'ERROR') {
        const msg = firstString(step['error']) ?? firstString(step['message']) ?? firstString(step['error_message']) ?? 'erro na etapa';
        const mapped: MappedEvent = {
          type: 'error',
          payload: { message: msg, stepIndex: numberOf(step['step_index']) },
          raw: line,
        };
        if (stepConvId) mapped.nativeSessionId = stepConvId;
        return [mapped];
      }

      if (stepType === 'tool_call' || stepType === 'tool_use' || step['tool_call']) {
        const toolData = (step['tool_call'] ?? step) as Record<string, unknown>;
        const name = firstString(toolData['name']) ?? firstString(toolData['tool']);
        const input = (toolData['input'] ?? toolData['arguments'] ?? {}) as Record<string, unknown>;
        
        return [mapToolCall(name, input, line, stepConvId)];
      }

      if (stepType === 'tool_result') {
        const mapped: MappedEvent = {
          type: 'tool.result',
          payload: {
            content: step['content'] ?? step['output'] ?? step['result'],
            isError: step['is_error'] === true || step['state'] === 'ERROR',
          },
          raw: line,
        };
        if (stepConvId) mapped.nativeSessionId = stepConvId;
        return [mapped];
      }

      return [{ type: 'log', payload: { step }, raw: line }];
    }

    case 'result': {
      const res = (obj['result'] ?? {}) as Record<string, unknown>;
      const resConvId = firstString(res['conversation_id']) ?? conversationId;
      const status = firstString(res['status']);
      const isError = status === 'ERROR' || Boolean(res['error']);
      const usage = res['usage'] as Record<string, unknown> | undefined;

      const eventType = isError ? 'error' : 'turn.completed';
      const mapped: MappedEvent = {
        type: eventType,
        payload: {
          status: status ?? (isError ? 'ERROR' : 'SUCCESS'),
          summary: firstString(res['response']),
          error: firstString(res['error']),
          message: firstString(res['error']) ?? firstString(res['response']),
          durationSeconds: numberOf(res['duration_seconds']),
          numTurns: numberOf(res['num_turns']),
        },
        cost: {
          inputTokens: numberOf(usage?.['input_tokens']),
          outputTokens: numberOf(usage?.['output_tokens']),
          cachedTokens: numberOf(usage?.['cache_read_tokens']),
        },
        raw: line,
      };
      if (resConvId) mapped.nativeSessionId = resConvId;
      return [mapped];
    }

    default:
      return [{ type: 'log', payload: { data: obj }, raw: line }];
  }
}

function mapToolCall(
  name: string | undefined,
  input: Record<string, unknown>,
  raw: unknown,
  nativeSessionId?: string,
): MappedEvent {
  if (name === 'run_command' || name === 'bash' || name === 'shell') {
    const cmd = firstString(input['CommandLine']) ?? firstString(input['command']) ?? firstString(input['cmd']);
    const event: MappedEvent = {
      type: 'command.executed',
      payload: { command: cmd, cwd: input['Cwd'] },
      raw,
    };
    if (nativeSessionId) event.nativeSessionId = nativeSessionId;
    return event;
  }

  if (
    name === 'write_to_file' ||
    name === 'replace_file_content' ||
    name === 'sed_file' ||
    name === 'multi_replace_file_content'
  ) {
    const p = firstString(input['TargetFile']) ?? firstString(input['AbsolutePath']) ?? firstString(input['path']);
    const event: MappedEvent = {
      type: 'file.changed',
      payload: { path: p, tool: name },
      raw,
    };
    if (nativeSessionId) event.nativeSessionId = nativeSessionId;
    return event;
  }

  const event: MappedEvent = {
    type: 'tool.call',
    payload: { tool: name, input },
    raw,
  };
  if (nativeSessionId) event.nativeSessionId = nativeSessionId;
  return event;
}
