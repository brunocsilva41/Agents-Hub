import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { montarInvocacao } from '../process-adapter.js';
import { loadManifestFile } from '../registry.js';
import { kimiMapper } from './kimi.js';

/**
 * Item 4.4 do GOAL — Kimi 2.0.0 (reescrita Bun/TS).
 *
 * Linhas abaixo: as de `meta` foram capturadas do binário real contra um
 * provedor morto (config e HOME temporários, sem custo); `assistant`/`tool`
 * seguem o `PromptJsonWriter` do bundle do `kimi.exe` 2.0.0.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const kimi = loadManifestFile(path.join(RAIZ, 'manifests', 'kimi.yaml'));

const CTX = { workdir: 'C:\\projeto', model: undefined, extraArgs: [] };

describe('manifesto do Kimi 2.0.0', () => {
  for (const mode of ['supervised', 'semi', 'autonomous'] as const) {
    test(`${mode}: nenhuma flag que o -p da 2.0.0 recusa (--yolo/-y/--auto/--plan)`, () => {
      for (const [template, id] of [
        [kimi.invoke.oneShot, null],
        [kimi.invoke.resume!, 'session_1'],
      ] as const) {
        const { args } = montarInvocacao(kimi, { ...CTX, mode }, template, 'oi', id);
        for (const proibida of ['-y', '--yolo', '--auto', '--plan']) {
          assert.ok(
            !args.includes(proibida),
            `${mode}: "${proibida}" faz o kimi 2.0.0 sair com "Cannot combine --prompt with ..."`,
          );
        }
      }
    });
  }

  test('supervised cria a sessão com o perfil só-leitura `plan`', () => {
    const { args } = montarInvocacao(
      kimi,
      { ...CTX, mode: 'supervised' },
      kimi.invoke.oneShot,
      'oi',
      null,
    );
    const i = args.indexOf('--agent');
    assert.ok(i >= 0 && args[i + 1] === 'plan', `argv: ${JSON.stringify(args)}`);
  });

  test('resume não repete --agent (a 2.0.0 recusa --agent junto de --session)', () => {
    const { args } = montarInvocacao(
      kimi,
      { ...CTX, mode: 'supervised' },
      kimi.invoke.resume!,
      'oi',
      'session_1',
    );
    assert.ok(args.includes('--session'));
    assert.ok(!args.includes('--agent'), `argv: ${JSON.stringify(args)}`);
  });
});

describe('kimiMapper (stream-json 2.0.0)', () => {
  test('retentativa vira aviso legível, não log com text vazio', () => {
    const [e] = kimiMapper({
      role: 'meta',
      type: 'turn.step.retrying',
      failed_attempt: 1,
      next_attempt: 2,
      max_attempts: 10,
      delay_ms: 606.03,
      error_name: 'APIConnectionError',
      error_message: 'Connection error.',
    });
    assert.equal(e?.type, 'log');
    assert.equal(e?.payload['level'], 'warn');
    assert.equal(
      e?.payload['text'],
      'Kimi: tentativa 1/10 falhou (APIConnectionError: Connection error.); nova tentativa em 1s',
    );
  });

  test('a última retentativa avisa que é a última', () => {
    const [e] = kimiMapper({
      role: 'meta',
      type: 'turn.step.retrying',
      failed_attempt: 9,
      next_attempt: 10,
      max_attempts: 10,
      delay_ms: 30000,
      error_name: 'APIConnectionError',
      error_message: 'Connection error.',
    });
    assert.match(String(e?.payload['text']), /é a última$/);
  });

  test('system.version vira log com texto', () => {
    const [e] = kimiMapper({ role: 'meta', type: 'system.version', version: '2.0.0' });
    assert.equal(e?.payload['text'], 'Kimi 2.0.0');
  });

  test('assistant com tool_calls: texto + chamadas (Bash vira command.executed com o comando)', () => {
    const eventos = kimiMapper({
      role: 'assistant',
      content: 'vou rodar os testes',
      tool_calls: [
        { type: 'function', id: 't1', function: { name: 'Bash', arguments: '{"command":"npm test"}' } },
        {
          type: 'function',
          id: 't2',
          function: { name: 'Write', arguments: '{"path":"src/a.ts","content":"x"}' },
        },
      ],
    });
    assert.deepEqual(
      eventos.map((e) => e.type),
      ['message', 'command.executed', 'file.changed'],
    );
    assert.equal(eventos[1]?.payload['command'], 'npm test');
    assert.equal(eventos[2]?.payload['path'], 'src/a.ts');
  });

  test('assistant só com tool_calls (sem content) não perde a chamada', () => {
    const eventos = kimiMapper({
      role: 'assistant',
      tool_calls: [
        { type: 'function', id: 't1', function: { name: 'Read', arguments: '{"path":"a"}' } },
      ],
    });
    assert.deepEqual(
      eventos.map((e) => e.type),
      ['tool.call'],
    );
  });

  test('role tool da 2.0.0 é RESULTADO (tool_call_id), não chamada', () => {
    const [e] = kimiMapper({ role: 'tool', tool_call_id: 't1', content: 'ok' });
    assert.equal(e?.type, 'tool.result');
    assert.equal(e?.payload['callId'], 't1');
  });

  test('resume_hint revela o id nativo', () => {
    const [e] = kimiMapper({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_abc',
      command: 'kimi -r session_abc',
      content: 'To resume this session: kimi -r session_abc',
    });
    assert.equal(e?.nativeSessionId, 'session_abc');
  });

  test('formato antigo (role tool com name/input) continua aceito', () => {
    const [e] = kimiMapper({ role: 'tool', name: 'bash', input: { command: 'ls' } });
    assert.equal(e?.type, 'command.executed');
    assert.equal(e?.payload['command'], 'ls');
  });
});
