import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motivoDaFalha, ultimaLinhaDeErro } from './failure-reason.js';
import { claudeMapper } from './mappers/claude.js';

/**
 * Motivo de falha (teste real de 2026-09-26, Codex): o erro registrado era a
 * 1ª linha do stderr — um aviso "failed to load skill ... SKILL.md" — e não o
 * evento `error` do agente ("You've hit your usage limit").
 */

const AVISO = 'failed to load skill C:\\x\\universal-agent-guide\\SKILL.md: missing YAML frontmatter';

test('evento error do agente vence o stderr', () => {
  const m = motivoDaFalha(1, ["You've hit your usage limit. Try again later."], [AVISO, 'ERROR: stream ended']);
  assert.match(m, /usage limit/);
  assert.doesNotMatch(m, /SKILL/);
});

test('sem evento do agente: última linha de ERRO do stderr, nunca um aviso', () => {
  assert.equal(
    ultimaLinhaDeErro([AVISO, 'Error: 401 Unauthorized', 'WARN: something failed later']),
    'Error: 401 Unauthorized',
  );
  const soAviso = motivoDaFalha(2, [], [AVISO]);
  assert.doesNotMatch(soAviso, /SKILL/);
  assert.match(soAviso, /código 2/);
});

test('mapper do Claude: rate_limit_event e raciocínio vazio não viram ruído', () => {
  const [rl] = claudeMapper({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.equal(rl?.payload['kind'], 'tecnico');
  assert.equal(typeof rl?.payload['text'], 'string');
  const vazio = claudeMapper({
    type: 'assistant',
    message: { id: 'm', content: [{ type: 'thinking', thinking: '' }] },
  });
  assert.equal(vazio.length, 0);
});
