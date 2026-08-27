import type { MappedEvent } from '../types.js';
import { firstString, numberOf } from './generic.js';

/**
 * Mapper do GitHub Copilot CLI — `copilot -p "<texto>" --output-format json`.
 *
 * Formato capturado do binário real (1.0.70): um JSON por linha, cada um com
 * `{ type, data, id, timestamp, parentId, ephemeral? }`.
 *
 * `ephemeral: true` marca evento de bastidor — carga de MCP, skills, deltas de
 * streaming, idle. Sem esse filtro a timeline vira um despejo de infraestrutura
 * do Copilot, onde a mensagem do agente se perde no meio.
 */
export function copilotMapper(line: unknown): MappedEvent[] {
  if (line === null || typeof line !== 'object') return [];
  const obj = line as Record<string, unknown>;
  const type = firstString(obj['type']);
  if (!type) return [];

  const data = (obj['data'] ?? {}) as Record<string, unknown>;

  switch (type) {
    /**
     * O Copilot escolhe o modelo sozinho em modo `auto`. Este evento é a única
     * fonte de qual modelo realmente rodou — e sem ele o Hub não consegue
     * estimar custo, porque o Copilot fatura em créditos e não reporta dólares.
     */
    case 'session.auto_mode_resolved':
      return [
        {
          type: 'log',
          payload: {
            text: `modelo escolhido: ${firstString(data['chosenModel']) ?? '?'}`,
            model: firstString(data['chosenModel']),
            reasoningBucket: data['reasoningBucket'],
          },
          raw: line,
        },
      ];

    case 'user.message':
      // O prompt é nosso; ecoá-lo de volta na timeline é ruído puro.
      return [];

    case 'assistant.turn_start': {
      const model = firstString(data['model']);
      return [
        {
          type: 'turn.started',
          payload: { turnId: data['turnId'], ...(model ? { model } : {}) },
          raw: line,
        },
      ];
    }

    case 'assistant.message_delta': {
      const delta = firstString(data['deltaContent']);
      return delta ? [{ type: 'message.delta', payload: { text: delta }, raw: line }] : [];
    }

    case 'assistant.message': {
      const events: MappedEvent[] = [];
      const content = firstString(data['content']);
      const model = firstString(data['model']);

      if (content) {
        events.push({
          type: 'message',
          payload: { text: content, ...(model ? { model } : {}) },
          // `outputTokens` é o único número de uso que o Copilot expõe por
          // mensagem; entrada não vem, então a estimativa sai por baixo.
          cost: { outputTokens: numberOf(data['outputTokens']) },
          raw: line,
        });
      }

      // Ferramentas pedidas no mesmo evento da mensagem.
      const pedidos = Array.isArray(data['toolRequests']) ? data['toolRequests'] : [];
      for (const pedido of pedidos as Array<Record<string, unknown>>) {
        events.push({
          type: classificarFerramenta(pedido),
          payload: {
            tool: firstString(pedido['name']) ?? firstString(pedido['tool']),
            input: pedido['arguments'] ?? pedido['input'],
            toolUseId: firstString(pedido['id']),
            ...descreverFerramenta(pedido),
          },
          raw: pedido,
        });
      }

      return events;
    }

    case 'assistant.reasoning': {
      // Vem quase sempre vazio: o conteúdo do raciocínio é opaco e cifrado.
      const content = firstString(data['content']);
      return content ? [{ type: 'reasoning', payload: { text: content }, raw: line }] : [];
    }

    case 'assistant.turn_end':
      return [{ type: 'turn.completed', payload: { turnId: data['turnId'] }, raw: line }];

    /** Evento final da execução: traz o id da sessão e o código de saída. */
    case 'result': {
      const sessionId = firstString(obj['sessionId']);
      const exitCode = numberOf(obj['exitCode']);
      const usage = (obj['usage'] ?? {}) as Record<string, unknown>;
      const mudancas = (usage['codeChanges'] ?? {}) as Record<string, unknown>;

      const event: MappedEvent = {
        type: exitCode === 0 ? 'turn.completed' : 'error',
        payload: {
          exitCode,
          message: exitCode === 0 ? undefined : `copilot saiu com código ${String(exitCode)}`,
          premiumRequests: usage['premiumRequests'],
          linesAdded: mudancas['linesAdded'],
          linesRemoved: mudancas['linesRemoved'],
          filesModified: mudancas['filesModified'],
        },
        raw: line,
      };
      if (sessionId) event.nativeSessionId = sessionId;
      return [event];
    }

    case 'error':
      return [
        {
          type: 'error',
          payload: { message: firstString(data['message']) ?? 'erro do Copilot' },
          raw: line,
        },
      ];

    default:
      // Bastidor do Copilot (MCP, skills, idle) é descartado; o resto vira log
      // para não sumir em silêncio quando o formato mudar.
      return obj['ephemeral'] === true
        ? []
        : [{ type: 'log', payload: { copilotType: type, data }, raw: line }];
  }
}

/** Shell e escrita ganham tipo próprio: são eles que carregam risco. */
function classificarFerramenta(pedido: Record<string, unknown>): MappedEvent['type'] {
  const nome = (firstString(pedido['name']) ?? firstString(pedido['tool']) ?? '').toLowerCase();
  if (nome.includes('bash') || nome.includes('shell') || nome.includes('terminal')) {
    return 'command.executed';
  }
  if (nome.includes('write') || nome.includes('edit') || nome.includes('create')) {
    return 'file.changed';
  }
  return 'tool.call';
}

function descreverFerramenta(pedido: Record<string, unknown>): Record<string, unknown> {
  const args = pedido['arguments'] ?? pedido['input'];
  if (args === null || typeof args !== 'object') return {};
  const a = args as Record<string, unknown>;
  const command = firstString(a['command']);
  const path = firstString(a['path']) ?? firstString(a['file_path']) ?? firstString(a['filePath']);
  return { ...(command ? { command } : {}), ...(path ? { path } : {}) };
}
