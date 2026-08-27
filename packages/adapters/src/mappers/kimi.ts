import type { MappedEvent } from '../types.js';
import { firstString, numberOf } from './generic.js';

/**
 * Mapper do Kimi Code CLI — `kimi -p "<texto>" --output-format stream-json`.
 *
 * Formato capturado do binário real: um JSON por linha, orientado a `role` em
 * vez de `type` como os demais. Confirmado:
 *
 *   {"role":"assistant","content":"OK"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_...", ...}
 *
 * O `session.resume_hint` é a única fonte do id nativo, e vem no fim — é ele
 * que autoriza `session.strategy: native` no manifesto.
 */
export function kimiMapper(line: unknown): MappedEvent[] {
  if (line === null || typeof line !== 'object') return [];
  const obj = line as Record<string, unknown>;

  const role = firstString(obj['role']);
  const content = firstString(obj['content']);

  switch (role) {
    case 'assistant':
      return content ? [{ type: 'message', payload: { text: content }, raw: line }] : [];

    case 'user':
      // É o nosso próprio prompt ecoado de volta.
      return [];

    case 'thinking':
    case 'reasoning':
      return content ? [{ type: 'reasoning', payload: { text: content }, raw: line }] : [];

    case 'tool': {
      const nome = firstString(obj['name']) ?? firstString(obj['tool']);
      const entrada = obj['input'] ?? obj['arguments'];
      return [
        {
          type: classificarFerramenta(nome),
          payload: {
            tool: nome,
            input: entrada,
            ...descrever(entrada),
            ...(content ? { output: content } : {}),
          },
          raw: line,
        },
      ];
    }

    case 'meta': {
      const tipo = firstString(obj['type']);
      const sessionId = firstString(obj['session_id']);

      const event: MappedEvent = {
        type: 'log',
        payload: { kimiType: tipo, text: content },
        raw: line,
      };
      if (sessionId) event.nativeSessionId = sessionId;

      const uso = obj['usage'];
      if (uso && typeof uso === 'object') {
        const u = uso as Record<string, unknown>;
        event.cost = {
          inputTokens: numberOf(u['input_tokens'] ?? u['prompt_tokens']),
          outputTokens: numberOf(u['output_tokens'] ?? u['completion_tokens']),
        };
      }

      return [event];
    }

    case 'error':
      return [
        { type: 'error', payload: { message: content ?? 'erro do Kimi' }, raw: line },
      ];

    default:
      // Sem `role` conhecido: preservamos como log em vez de descartar, porque
      // o projeto está migrando de Python para Bun+TS e o formato pode mudar.
      return [{ type: 'log', payload: { data: obj }, raw: line }];
  }
}

function classificarFerramenta(nome: string | undefined): MappedEvent['type'] {
  const n = (nome ?? '').toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) return 'command.executed';
  if (n.includes('write') || n.includes('edit')) return 'file.changed';
  return 'tool.call';
}

function descrever(entrada: unknown): Record<string, unknown> {
  if (entrada === null || typeof entrada !== 'object') return {};
  const e = entrada as Record<string, unknown>;
  const command = firstString(e['command']);
  const path = firstString(e['path']) ?? firstString(e['file_path']);
  return { ...(command ? { command } : {}), ...(path ? { path } : {}) };
}
