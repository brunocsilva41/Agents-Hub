import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBrief } from './brief.js';
import { rebuildConversation } from './conversation.js';
import { makeEvent, type EventEnvelope } from './events.js';

const brief = parseBrief({
  agent: 'copilot',
  objective: 'refatorar o módulo de pagamentos',
  acceptanceCriteria: ['os testes continuam passando'],
});

function evento(
  type: EventEnvelope['type'],
  payload: Record<string, unknown>,
  seq = 1,
): EventEnvelope {
  return makeEvent({ sessionId: 'ses_x', agentId: 'copilot', type, payload }, seq);
}

/**
 * Estes testes cobrem um bug de COMUNICAÇÃO, não de execução: antes, falar com
 * um agente sem sessão nativa mandava só a mensagem nova, e ele recebia um
 * "faça também X" sem saber qual era a tarefa nem o que já tinha tentado.
 */
describe('reconstrução de contexto', () => {
  test('a tarefa original vai junto — sem ela o agente não sabe o que está fazendo', () => {
    const texto = rebuildConversation({ brief, history: [], message: 'agora ajuste os testes' });
    assert.match(texto, /refatorar o módulo de pagamentos/);
    assert.match(texto, /os testes continuam passando/);
  });

  test('a mensagem nova aparece claramente separada do resto', () => {
    const texto = rebuildConversation({ brief, history: [], message: 'agora ajuste os testes' });
    assert.match(texto, /## Nova mensagem/);
    assert.match(texto, /agora ajuste os testes/);
  });

  test('o que já aconteceu é resumido para o agente não repetir o caminho', () => {
    const texto = rebuildConversation({
      brief,
      history: [
        evento('message', { text: 'Extraí a lógica para PaymentService.' }, 1),
        evento('command.executed', { command: 'npm test', exitCode: 1 }, 2),
        evento('file.changed', { files: [{ path: 'src/payment.ts' }] }, 3),
        evento('error', { message: 'teste de reembolso quebrou' }, 4),
      ],
      message: 'conserte o teste',
    });

    assert.match(texto, /PaymentService/);
    assert.match(texto, /npm test/);
    assert.match(texto, /falhou: 1/, 'o desfecho do comando importa tanto quanto o comando');
    assert.match(texto, /src\/payment\.ts/);
    assert.match(texto, /teste de reembolso quebrou/);
  });

  test('ruído de infraestrutura fica de fora', () => {
    const texto = rebuildConversation({
      brief,
      history: [
        evento('log', { text: 'carregando MCP servers' }, 1),
        evento('reasoning', { text: 'pensando em voz alta' }, 2),
        evento('turn.started', {}, 3),
      ],
      message: 'siga',
    });

    assert.doesNotMatch(texto, /MCP servers/);
    assert.doesNotMatch(texto, /pensando em voz alta/);
    assert.doesNotMatch(texto, /O que já aconteceu/, 'sem nada narrativo, a seção nem aparece');
  });

  test('histórico longo é cortado pelo COMEÇO, preservando o fim', () => {
    const history = Array.from({ length: 200 }, (_, i) =>
      evento('command.executed', { command: `comando-numero-${i}`, exitCode: 0 }, i + 1),
    );

    const texto = rebuildConversation({ brief, history, message: 'siga', maxHistoryChars: 500 });

    assert.match(texto, /comando-numero-199/, 'o passo mais recente é o mais útil');
    assert.doesNotMatch(texto, /comando-numero-0\b/);
    assert.match(texto, /passo\(s\) anteriores omitidos/, 'o corte precisa ser visível');
  });

  test('delegação aparece no histórico — é parte do que o agente fez', () => {
    const texto = rebuildConversation({
      brief,
      history: [
        evento('delegation.requested', { targetAgent: 'codex', objective: 'escrever testes' }, 1),
        evento('delegation.completed', { agentId: 'codex', state: 'completed' }, 2),
      ],
      message: 'e agora?',
    });

    assert.match(texto, /delegou para codex/);
    assert.match(texto, /terminou como "completed"/);
  });

  test('payload torto não derruba a reconstrução', () => {
    const texto = rebuildConversation({
      brief,
      history: [
        evento('message', { text: null }, 1),
        evento('command.executed', {}, 2),
        evento('file.changed', { files: 'não é lista' }, 3),
      ],
      message: 'siga',
    });
    assert.match(texto, /## Nova mensagem/);
  });
});
