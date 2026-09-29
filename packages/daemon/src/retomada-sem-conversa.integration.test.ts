import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, HubError } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Teste real de 2026-09-29 (claude 2.1.285), reproduzido com um agente FALSO
 * que imita as linhas do binário real:
 *
 * 1. `hub start` e `interrupt` 4,7 s depois: os únicos eventos do turno foram
 *    `system/hook_started` e `system/hook_response` do hook `SessionStart` do
 *    usuário, com `session_id` — sem `system/init`, sem conversa gravada;
 * 2. `hub send` relançou com `--resume <id>`; o Claude escreveu no stderr
 *    "No conversation found with session ID: <id>", emitiu um `result`
 *    `error_during_execution` com `num_turns: 0` e saiu com 1;
 * 3. a tentativa virou falha permanente e a TASK terminou `failed`.
 *
 * Diretivas no prompt: `@INIT` (o primeiro turno chega a emitir o `init`
 * antes de ser interrompido — a conversa ainda assim não existe no resume) e
 * `@CONTINUA` (o turno termina na hora).
 */

const SID = 'cb8f904e-1abd-41d8-a15d-78075a22b01f';

const CLAUDE_FALSO = `
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.285\\n'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const i = argv.indexOf('--resume');
  if (i >= 0) {
    process.stderr.write('No conversation found with session ID: ' + argv[i + 1] + '\\n');
    out({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, is_error: true,
      num_turns: 0, session_id: 'e0e0e0e0-0000-4000-8000-000000000000', total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 } });
    process.exitCode = 1;
    return;
  }
  if (prompt.includes('@CONTINUA')) {
    out({ type: 'system', subtype: 'init', session_id: 'nat-novo', model: 'claude-opus-5-5', tools: [] });
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'RETOMADO' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'RETOMADO', num_turns: 1,
      session_id: 'nat-novo', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  const hook = { type: 'system', hook_id: 'h1', hook_name: 'SessionStart:startup',
    hook_event: 'SessionStart', uuid: 'u1', session_id: '${SID}' };
  out({ ...hook, subtype: 'hook_started' });
  out({ ...hook, subtype: 'hook_response', output: '', exit_code: 0, outcome: 'success' });
  if (prompt.includes('@INIT')) {
    out({ type: 'system', subtype: 'init', session_id: '${SID}', model: 'claude-opus-5-5', tools: [] });
  }
  // Turno longo: é a janela em que o teste interrompe.
  setTimeout(() => process.exit(0), 30000);
});
`;

function esc(p: string): string {
  return p.replaceAll('\\', '\\\\');
}

interface Execucao {
  argv: string[];
}

describe('retomada do Claude com turno interrompido antes de a conversa existir', () => {
  let raiz: string;
  let hub: Hub;
  let log: string;
  let projectId: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-retomada-'));
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projeto, { recursive: true });
    const script = path.join(raiz, 'claude-falso.cjs');
    writeFileSync(script, CLAUDE_FALSO, 'utf8');
    log = path.join(raiz, 'execucoes.log');
    writeFileSync(
      path.join(manifestos, 'claudefalso.yaml'),
      [
        'id: claudefalso',
        'name: Claude falso',
        'bin: node',
        'detect:',
        `  args: ["${esc(script)}", "--version"]`,
        'invoke:',
        `  oneShot: ["${esc(script)}"]`,
        `  resume: ["${esc(script)}", "--resume", "{{nativeSessionId}}"]`,
        '  stdinPrompt: true',
        '  env:',
        `    FAKE_LOG: "${esc(log)}"`,
        'session:',
        '  strategy: native',
        '  nativeSessionMissing: ["No conversation found with session ID"]',
        'stream:',
        '  format: jsonl',
        '  mapper: claude',
        'capabilities: [falso-claude]',
        'defaults:',
        '  isolation: none',
        '  timeoutSeconds: 120',
        '  supervision: autonomous',
        '',
      ].join('\n'),
      'utf8',
    );
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      policy: {
        ...DEFAULT_POLICY,
        retries: { max: 2, backoffMs: 10 },
        fallback: {},
        watch: { pauseOn: [], flagOn: [] },
      },
    });
    projectId = hub.sessions.registerProject(projeto, 'projeto').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function execucoes(): Execucao[] {
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Execucao);
  }

  async function iniciarEInterromper(objetivo: string): Promise<{ sessionId: string; taskId: string }> {
    writeFileSync(log, '', 'utf8');
    const { session, task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: { agent: 'claudefalso', objective: objetivo, isolation: 'none' },
    });
    await esperarAte(
      () =>
        hub.store.events
          .list({ sessionId: session.id, limit: 1000 })
          .some((e) => e.payload['subtype'] === (objetivo.includes('@INIT') ? 'init' : 'hook_response')),
      'o último evento do turno antes da interrupção',
    );
    assert.equal(await hub.sessions.interrupt(session.id), true);
    await esperarAte(() => !hub.sessions.isLive(session.id), 'o turno interrompido encerrar');
    assert.equal(hub.store.sessions.get(session.id)?.state, 'idle');
    return { sessionId: session.id, taskId: task.id };
  }

  async function esperarTaskTerminal(taskId: string): Promise<string> {
    await esperarAte(
      () =>
        ['completed', 'failed', 'canceled', 'rejected'].includes(
          hub.store.tasks.get(taskId)?.state ?? '',
        ),
      'tarefa terminal',
    );
    return hub.store.tasks.get(taskId)!.state;
  }

  test('só hooks com session_id: o id NÃO vira sessão nativa e o send já vai em replay', async () => {
    const { sessionId, taskId } = await iniciarEInterromper('investigar o bug');
    assert.equal(hub.store.sessions.get(sessionId)?.nativeSessionId, null);

    const envio = await hub.sessions.send(sessionId, '@CONTINUA siga');
    assert.equal(envio.mode, 'replay');
    assert.equal(await esperarTaskTerminal(taskId), 'completed');
    const argv = execucoes().map((e) => e.argv);
    assert.equal(argv.length, 2);
    assert.ok(!argv[1]?.includes('--resume'), `relançou com --resume: ${JSON.stringify(argv[1])}`);
  });

  test('resume de conversa inexistente: turno refeito UMA vez em replay, sem falha, retry nem fallback', async () => {
    const { sessionId, taskId } = await iniciarEInterromper('investigar o bug @INIT');
    assert.equal(hub.store.sessions.get(sessionId)?.nativeSessionId, SID);

    const envio = await hub.sessions.send(sessionId, '@CONTINUA siga');
    assert.equal(envio.mode, 'resume');
    assert.equal(await esperarTaskTerminal(taskId), 'completed');
    await esperarAte(() => hub.store.sessions.get(sessionId)?.state === 'completed', 'sessão concluída');

    const argv = execucoes().map((e) => e.argv);
    assert.equal(argv.length, 3, `execuções: ${JSON.stringify(argv)}`);
    assert.deepEqual(argv[1]?.slice(-2), ['--resume', SID]);
    assert.ok(!argv[2]?.includes('--resume'), 'o replay não pode repetir o --resume');

    const task = hub.store.tasks.get(taskId)!;
    assert.equal(task.attempts.length, 1, 'refazer em replay não consome tentativa');
    assert.equal(task.attempts[0]?.error ?? null, null);
    assert.match(task.result?.summary ?? '', /RETOMADO/);
    // O id inválido foi esquecido; vale o da conversa nova.
    assert.equal(hub.store.sessions.get(sessionId)?.nativeSessionId, 'nat-novo');

    const aviso = hub.store.events
      .list({ sessionId, limit: 1000 })
      .find((e) => e.type === 'log' && e.payload['kind'] === 'replay');
    assert.ok(aviso, 'a timeline precisa dizer que o turno virou replay');
    assert.equal(aviso.payload['nativeSessionId'], SID);
    assert.match(String(aviso.payload['text']), /replay/);

    // Sessão concluída continua recusando `send` (sugere continuar com --from).
    await assert.rejects(
      () => hub.sessions.send(sessionId, 'mais uma'),
      (err: unknown) => err instanceof HubError && err.code === 'ILLEGAL_STATE',
    );
  });
});
