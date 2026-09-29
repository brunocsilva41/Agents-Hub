import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mensagemDoEventoDeErro,
  motivoDaFalha,
  sessaoNativaInexistente,
  ultimaLinhaDeErro,
} from './failure-reason.js';
import { loadManifestDir } from './registry.js';
import { AgentManifestSchema } from './types.js';
import { claudeMapper } from './mappers/claude.js';

/**
 * Motivo de falha (teste real de 2026-09-26, Codex): o erro registrado era a
 * 1ª linha do stderr — um aviso "failed to load skill ... SKILL.md" — e não o
 * evento `error` do agente ("You've hit your usage limit").
 */

const AVISO = 'failed to load skill C:\\x\\universal-agent-guide\\SKILL.md: missing YAML frontmatter';

test('evento error do agente vence o stderr', () => {
  const m = motivoDaFalha(
    1,
    ["You've hit your usage limit. Try again later."],
    [AVISO, 'ERROR: stream ended'],
  );
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

/**
 * Teste real de 2026-09-29 (Claude, `--resume` de sessão inexistente): o
 * motivo ficou "o agente não emitiu mensagem de erro", mas o Claude tinha
 * escrito o motivo no stderr — numa linha sem palavra de "erro" — e o
 * `result` veio sem texto.
 */
const CODEX_RUIDO =
  'ERROR codex_core::session::session: failed to load skill C:/x/SKILL.md: missing YAML frontmatter';
const SEM_CONVERSA = 'No conversation found with session ID: cb8f904e-1abd-41d8-a15d-78075a22b01f';

test('stderr sem cara de erro: vale a última linha útil, não "não emitiu mensagem"', () => {
  const [resultado] = claudeMapper({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    total_cost_usd: 0,
  });
  assert.ok(resultado);
  // O `result` de erro não traz texto: não há motivo do agente para preferir.
  assert.equal(mensagemDoEventoDeErro(resultado), null);
  const m = motivoDaFalha(1, [], [SEM_CONVERSA]);
  assert.match(m, /No conversation found with session ID/);
  assert.doesNotMatch(m, /não emitiu/);
});

test('ruído de SKILL.md do Codex antes da linha útil não vira motivo', () => {
  const m = motivoDaFalha(1, [], [CODEX_RUIDO, SEM_CONVERSA]);
  assert.match(m, /No conversation found/);
  assert.doesNotMatch(m, /SKILL/);
  // E o ruído DEPOIS da linha útil também não a esconde.
  assert.match(motivoDaFalha(1, [], [SEM_CONVERSA, CODEX_RUIDO]), /No conversation found/);
  // Linha com cara de erro continua preferida à última linha qualquer.
  assert.match(motivoDaFalha(1, [], ['Error: 401 Unauthorized', 'tentando de novo em 3s']), /401/);
});

test('sessão nativa inexistente: padrão do manifesto casa stderr ou motivo, sem padrão nunca casa', () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const claude = loadManifestDir(path.join(raiz, 'manifests')).find((m) => m.id === 'claude');
  const padroes = claude?.session.nativeSessionMissing ?? [];
  assert.ok(padroes.length > 0, 'manifesto do Claude declara o padrão');
  const stderr = ['aviso qualquer', SEM_CONVERSA].join('\n');
  assert.equal(sessaoNativaInexistente(padroes, stderr, null), true);
  assert.equal(
    sessaoNativaInexistente(padroes, '', `processo terminou com código 1: ${SEM_CONVERSA}`),
    true,
  );
  assert.equal(sessaoNativaInexistente(padroes, 'Error: 401 Unauthorized', 'código 1'), false);
  assert.equal(sessaoNativaInexistente([], SEM_CONVERSA, SEM_CONVERSA), false);
});

test('schema: session.nativeSessionMissing com regex que não compila é recusado', () => {
  const base = { id: 'x', name: 'X', bin: 'x', invoke: { oneShot: ['-p'] } };
  assert.deepEqual(AgentManifestSchema.parse(base).session.nativeSessionMissing, []);
  assert.equal(
    AgentManifestSchema.safeParse({ ...base, session: { nativeSessionMissing: ['(sem fechar'] } })
      .success,
    false,
  );
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
