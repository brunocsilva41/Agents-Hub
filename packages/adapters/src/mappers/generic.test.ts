import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { genericJsonMapper } from './generic.js';

/**
 * Item 4.4 do GOAL — `generic-json` (MiMo, Cursor) não extraía sessão nem uso:
 * sem `nativeSessionId` todo turno caía em replay e o custo ficava zerado.
 *
 * O envelope do MiMo é o `run --format json` da família OpenCode, conferido no
 * bundle do `mimo.exe` 0.1.14: `{type, timestamp, sessionID, part}`.
 */

const SES = 'ses_mimo123';

describe('genericJsonMapper — envelope `run --format json` (MiMo)', () => {
  test('qualquer linha com sessionID revela o id nativo', () => {
    const [e] = genericJsonMapper({ type: 'step_start', timestamp: 1, sessionID: SES, part: { type: 'step-start' } });
    assert.equal(e?.nativeSessionId, SES);
  });

  test('texto do agente vem em part.text', () => {
    const [e] = genericJsonMapper({
      type: 'text',
      sessionID: SES,
      part: { type: 'text', text: 'pronto', time: { start: 1, end: 2 } },
    });
    assert.equal(e?.type, 'message');
    assert.equal(e?.payload['text'], 'pronto');
  });

  test('step_finish traz custo e tokens (reasoning conta como saída; cache somado)', () => {
    const [e] = genericJsonMapper({
      type: 'step_finish',
      sessionID: SES,
      part: {
        type: 'step-finish',
        reason: 'stop',
        cost: 0.0123,
        tokens: { input: 1200, output: 300, reasoning: 40, cache: { read: 800, write: 10 } },
      },
    });
    assert.deepEqual(e?.cost, { usd: 0.0123, inputTokens: 1200, outputTokens: 340, cachedTokens: 810 });
    assert.equal(e?.nativeSessionId, SES);
  });

  test('tool_use de shell vira command.executed (vigiável pela política)', () => {
    const [e] = genericJsonMapper({
      type: 'tool_use',
      sessionID: SES,
      part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'git push' } } },
    });
    assert.equal(e?.type, 'command.executed');
    assert.equal(e?.payload['command'], 'git push');
  });

  test('tool_use de escrita vira file.changed', () => {
    const [e] = genericJsonMapper({
      type: 'tool_use',
      sessionID: SES,
      part: { type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: 'src/a.ts' } } },
    });
    assert.equal(e?.type, 'file.changed');
    assert.equal(e?.payload['path'], 'src/a.ts');
  });

  test('error traz a mensagem de error.data.message', () => {
    const [e] = genericJsonMapper({
      type: 'error',
      sessionID: SES,
      error: { name: 'APIError', data: { message: 'modelo inválido' } },
    });
    assert.equal(e?.type, 'error');
    assert.equal(e?.payload['message'], 'modelo inválido');
  });
});

describe('genericJsonMapper — stream-json estilo Claude (Cursor)', () => {
  test('session_id e texto de message.content[]', () => {
    const [e] = genericJsonMapper({
      type: 'assistant',
      session_id: 'c-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'oi' }] },
    });
    assert.equal(e?.type, 'message');
    assert.equal(e?.payload['text'], 'oi');
    assert.equal(e?.nativeSessionId, 'c-1');
  });

  test('usage no topo continua virando custo', () => {
    const [e] = genericJsonMapper({ type: 'result', session_id: 'c-1', usage: { input_tokens: 10, output_tokens: 5 } });
    assert.deepEqual(e?.cost, { inputTokens: 10, outputTokens: 5 });
  });
});
