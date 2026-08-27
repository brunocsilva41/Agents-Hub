import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { copilotMapper } from './copilot.js';
import { kimiMapper } from './kimi.js';

/**
 * Amostras capturadas da execução real de cada binário — não inventadas.
 * Se o formato mudar, é aqui que o teste avisa antes da timeline quebrar.
 */

describe('mapper do Copilot', () => {
  test('revela o modelo escolhido, que é a única base para estimar custo', () => {
    const [mapped] = copilotMapper({
      type: 'session.auto_mode_resolved',
      data: { chosenModel: 'gpt-5-mini', reasoningBucket: 'low' },
    });
    assert.equal(mapped?.payload['model'], 'gpt-5-mini');
  });

  test('mensagem do agente vira message com tokens de saída', () => {
    const [mapped] = copilotMapper({
      type: 'assistant.message',
      data: { content: 'OK', model: 'gpt-5-mini', outputTokens: 159, toolRequests: [] },
    });
    assert.equal(mapped?.type, 'message');
    assert.equal(mapped?.payload['text'], 'OK');
    assert.equal(mapped?.cost?.outputTokens, 159);
  });

  test('pedido de shell dentro da mensagem vira comando, não tool genérica', () => {
    const eventos = copilotMapper({
      type: 'assistant.message',
      data: {
        content: 'rodando',
        toolRequests: [{ id: 't1', name: 'bash', arguments: { command: 'npm test' } }],
      },
    });
    const comando = eventos.find((e) => e.type === 'command.executed');
    assert.equal(comando?.payload['command'], 'npm test');
  });

  test('o evento final traz o id da sessão, que habilita o resume', () => {
    const [mapped] = copilotMapper({
      type: 'result',
      sessionId: 'fea11bdf-462d-4a60-8709-fc40079aa830',
      exitCode: 0,
      usage: { premiumRequests: 0, codeChanges: { linesAdded: 0, filesModified: [] } },
    });
    assert.equal(mapped?.type, 'turn.completed');
    assert.equal(mapped?.nativeSessionId, 'fea11bdf-462d-4a60-8709-fc40079aa830');
  });

  test('saída diferente de zero vira erro, não turno concluído', () => {
    const [mapped] = copilotMapper({ type: 'result', sessionId: 's', exitCode: 1, usage: {} });
    assert.equal(mapped?.type, 'error');
  });

  test('bastidor efêmero é descartado para a timeline não virar despejo de infra', () => {
    assert.deepEqual(
      copilotMapper({ type: 'session.mcp_servers_loaded', data: { servers: [] }, ephemeral: true }),
      [],
    );
  });

  test('o prompt ecoado de volta não polui a timeline', () => {
    assert.deepEqual(copilotMapper({ type: 'user.message', data: { content: 'oi' } }), []);
  });

  test('tipo desconhecido não-efêmero vira log, nunca some', () => {
    const [mapped] = copilotMapper({ type: 'algo.novo', data: { x: 1 } });
    assert.equal(mapped?.type, 'log');
  });
});

describe('mapper do Kimi', () => {
  test('resposta do agente vira message', () => {
    const [mapped] = kimiMapper({ role: 'assistant', content: 'OK' });
    assert.equal(mapped?.type, 'message');
    assert.equal(mapped?.payload['text'], 'OK');
  });

  test('o resume_hint é a única fonte do id nativo', () => {
    const [mapped] = kimiMapper({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_89f4617a-cb89-44b0-a58d-2e5cfa135b3e',
      content: 'To resume this session: ...',
    });
    assert.equal(mapped?.nativeSessionId, 'session_89f4617a-cb89-44b0-a58d-2e5cfa135b3e');
  });

  test('o prompt ecoado de volta é descartado', () => {
    assert.deepEqual(kimiMapper({ role: 'user', content: 'oi' }), []);
  });

  test('ferramenta de shell é classificada como comando', () => {
    const [mapped] = kimiMapper({ role: 'tool', name: 'bash', input: { command: 'ls' } });
    assert.equal(mapped?.type, 'command.executed');
    assert.equal(mapped?.payload['command'], 'ls');
  });

  test('role desconhecido vira log em vez de sumir', () => {
    const [mapped] = kimiMapper({ role: 'algo', content: 'x' });
    assert.equal(mapped?.type, 'log');
  });

  test('entrada malformada não lança em nenhum dos dois', () => {
    for (const lixo of [null, undefined, 42, 'texto', [], {}]) {
      assert.doesNotThrow(() => copilotMapper(lixo));
      assert.doesNotThrow(() => kimiMapper(lixo));
    }
  });
});
