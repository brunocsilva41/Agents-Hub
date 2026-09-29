import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMapper } from './claude.js';

/**
 * Teste real de 2026-09-29 (claude 2.1.285): o turno foi interrompido 4,7 s
 * depois de subir, quando só tinham saído os `system/hook_*` do hook
 * `SessionStart` do usuário — com `session_id`, mas antes de o Claude gravar a
 * conversa. O Hub guardou esse id como sessão nativa, o `send` seguinte fez
 * `--resume` de uma conversa que não existia e a tarefa terminou `failed`.
 */

const SID = 'cb8f904e-1abd-41d8-a15d-78075a22b01f';

test('hook_started/hook_response com session_id NÃO definem a sessão nativa', () => {
  for (const subtype of ['hook_started', 'hook_response']) {
    const [ev] = claudeMapper({
      type: 'system',
      subtype,
      hook_name: 'SessionStart:startup',
      session_id: SID,
    });
    assert.equal(ev?.type, 'log');
    assert.equal(ev?.nativeSessionId, undefined, subtype);
  }
});

test('system/init define a sessão nativa (caminho comum)', () => {
  const [ev] = claudeMapper({ type: 'system', subtype: 'init', session_id: SID, tools: [], model: 'x' });
  assert.equal(ev?.type, 'session.started');
  assert.equal(ev?.nativeSessionId, SID);
});

test('result de um turno que rodou continua carregando a sessão nativa', () => {
  const [ev] = claudeMapper({
    type: 'result',
    subtype: 'success',
    session_id: SID,
    num_turns: 1,
    total_cost_usd: 0.01,
  });
  assert.equal(ev?.nativeSessionId, SID);
});
