import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventEnvelope } from '@agents-hub/core';
import { deveExibir, renderEvent } from './render.js';

/**
 * Ruído no `hub start`/`hub watch` (teste real de 2026-09-26): linhas vazias,
 * `rate_limit_event` cru, `message.delta` junto do texto final. Na saída
 * padrão só o que uma pessoa lê; o resto com `--verbose`.
 */

function ev(type: EventEnvelope['type'], payload: Record<string, unknown>): EventEnvelope {
  return {
    id: 'evt_1',
    seq: 1,
    ts: '2026-09-26T23:40:00.000Z',
    sessionId: 'ses_1',
    rootId: 'ses_1',
    taskId: null,
    agentId: 'claude',
    type,
    payload,
    cost: null,
    raw: null,
  } as unknown as EventEnvelope;
}

test('padrão esconde delta, texto vazio, log técnico e JSON cru; --verbose mostra', () => {
  const ocultos = [
    ev('message.delta', { text: 'OK' }),
    ev('message', { text: '   ' }),
    ev('reasoning', { text: '' }),
    ev('log', { kind: 'tecnico', text: 'Claude: limite de taxa allowed' }),
    ev('log', { data: { type: 'rate_limit_event', rate_limit_info: {} } }),
  ];
  for (const e of ocultos) {
    assert.equal(deveExibir(e), false, `${e.type} ${JSON.stringify(e.payload)} deveria sumir`);
    assert.equal(deveExibir(e, { verbose: true }), true);
  }
  for (const e of [
    ev('message', { text: 'OK' }),
    ev('log', { stream: 'stderr', text: 'erro de verdade' }),
    ev('turn.completed', {}),
    ev('error', { message: 'x' }),
  ]) {
    assert.equal(deveExibir(e), true, `${e.type} deveria aparecer`);
  }
});

test('aviso de fallback aparece destacado, com o agente substituto', () => {
  const linha = renderEvent(
    ev('log', { kind: 'fallback', level: 'warn', toAgentId: 'claude', text: 'fallback: codex → claude — cota esgotada' }),
  );
  assert.match(linha, /⚠ fallback: codex → claude/);
});
