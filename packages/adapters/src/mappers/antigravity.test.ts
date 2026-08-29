import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { antigravityMapper } from './antigravity.js';

describe('mapper do Antigravity CLI (agy)', () => {
  test('evento init extrai conversation_id e metadados da sessão', () => {
    const [mapped] = antigravityMapper({
      event: 'init',
      conversation_id: '30077937-4cf4-44cb-a349-1f05165b5865',
      init: {
        cwd: 'C:\\Users\\workspace',
        tools: ['run_command', 'write_to_file'],
        permission_mode: 'request-review',
      },
    });

    assert.equal(mapped?.type, 'session.started');
    assert.equal(mapped?.nativeSessionId, '30077937-4cf4-44cb-a349-1f05165b5865');
    assert.equal(mapped?.payload['cwd'], 'C:\\Users\\workspace');
  });

  test('prompt ecoado em user_input é descartado', () => {
    assert.deepEqual(
      antigravityMapper({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 0,
          state: 'DONE',
          step_type: 'user_input',
        },
      }),
      [],
    );
  });

  test('resposta do agente vira message com custo de tokens', () => {
    const [mapped] = antigravityMapper({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-123',
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'Olá, mundo!',
        duration_seconds: 1.5,
        usage: {
          input_tokens: 1200,
          output_tokens: 45,
          cache_read_tokens: 200,
          total_tokens: 1245,
        },
      },
    });

    assert.equal(mapped?.type, 'message');
    assert.equal(mapped?.payload['text'], 'Olá, mundo!');
    assert.equal(mapped?.cost?.inputTokens, 1200);
    assert.equal(mapped?.cost?.outputTokens, 45);
    assert.equal(mapped?.cost?.cachedTokens, 200);
    assert.equal(mapped?.nativeSessionId, 'conv-123');
  });

  test('ferramenta de comando vira command.executed', () => {
    const [mapped] = antigravityMapper({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-123',
        step_type: 'tool_call',
        tool_call: {
          name: 'run_command',
          input: { CommandLine: 'npm test', Cwd: 'C:\\repo' },
        },
      },
    });

    assert.equal(mapped?.type, 'command.executed');
    assert.equal(mapped?.payload['command'], 'npm test');
    assert.equal(mapped?.payload['cwd'], 'C:\\repo');
  });

  test('ferramenta de arquivo vira file.changed', () => {
    const [mapped] = antigravityMapper({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-123',
        step_type: 'tool_call',
        tool_call: {
          name: 'write_to_file',
          input: { TargetFile: 'C:\\repo\\file.ts' },
        },
      },
    });

    assert.equal(mapped?.type, 'file.changed');
    assert.equal(mapped?.payload['path'], 'C:\\repo\\file.ts');
  });

  test('resultado final com sucesso vira turn.completed', () => {
    const [mapped] = antigravityMapper({
      event: 'result',
      result: {
        conversation_id: 'conv-123',
        status: 'SUCCESS',
        response: 'Tarefa concluída com sucesso.',
        duration_seconds: 3.2,
        num_turns: 1,
        usage: {
          input_tokens: 5000,
          output_tokens: 200,
          cache_read_tokens: 1000,
          total_tokens: 5200,
        },
      },
    });

    assert.equal(mapped?.type, 'turn.completed');
    assert.equal(mapped?.payload['summary'], 'Tarefa concluída com sucesso.');
    assert.equal(mapped?.nativeSessionId, 'conv-123');
    assert.equal(mapped?.cost?.inputTokens, 5000);
    assert.equal(mapped?.cost?.outputTokens, 200);
  });

  test('resultado com erro vira error', () => {
    const [mapped] = antigravityMapper({
      event: 'result',
      result: {
        conversation_id: 'conv-123',
        status: 'ERROR',
        error: 'Quota esgotada',
        duration_seconds: 0.5,
        num_turns: 1,
      },
    });

    assert.equal(mapped?.type, 'error');
    assert.equal(mapped?.payload['message'], 'Quota esgotada');
    assert.equal(mapped?.nativeSessionId, 'conv-123');
  });

  test('entrada inválida não lança exceção', () => {
    for (const lixo of [null, undefined, 123, 'string', [], {}]) {
      assert.doesNotThrow(() => antigravityMapper(lixo));
    }
  });
});
