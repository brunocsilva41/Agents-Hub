import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { createHub, type Hub } from '@agents-hub/daemon';
import { HubClient } from './client.js';
import { streamUntilDone } from './follow-task.js';
import { workflowCommand } from './workflow-cmd.js';

/**
 * `hub workflow run` e `hub start`/`hub watch` contra um daemon de verdade com
 * agentes FALSOS (item 2.9 da vistoria de 2026-09-25, relatório 13).
 *
 * O agente falso fala o JSONL do Claude; diretivas no objetivo controlam o que
 * ele faz: `@FAIL=<agente>` (falha só nesse agente), `@SLEEP=ms`, `@COST=usd`,
 * `@WRITE=arquivo`, `@REQUIRE=arquivo` (falha se o arquivo não está no checkout).
 */
const AGENTE_FALSO = `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
const agente = process.env.FAKE_AGENT;
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const dir = (k) => (prompt.match(new RegExp('@' + k + '=(\\\\S+)', 'g')) || []).map((x) => x.slice(k.length + 2));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const sid = 'nat-' + agente + '-' + process.pid;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', tools: [] });
  if (dir('FAIL').includes(agente)) { process.stderr.write('API error 429: rate limit exceeded\\n'); process.exitCode = 1; return; }
  for (const r of dir('REQUIRE')) {
    if (!fs.existsSync(path.join(process.cwd(), r))) { process.stderr.write('faltou ' + r + ' no checkout\\n'); process.exitCode = 3; return; }
  }
  for (const w of dir('WRITE')) fs.writeFileSync(path.join(process.cwd(), w), 'feito por ' + agente + '\\n');
  const sleep = Number(dir('SLEEP')[0] || 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  out({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'RESULTADO_' + agente }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'RESULTADO_' + agente, session_id: sid, total_cost_usd: Number(dir('COST')[0] || 0), usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

function git(cwd: string, args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=teste', '-c', 'user.email=teste@local', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

/** Roda `fn` capturando o console; devolve as linhas e restaura `process.exitCode`. */
async function capturar(
  fn: () => Promise<void>,
): Promise<{ linhas: string[]; exitCode: number | undefined }> {
  const linhas: string[] = [];
  const log = console.log;
  const err = console.error;
  const exitAntes = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => linhas.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => linhas.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = exitAntes;
  return { linhas, exitCode };
}

describe('hub workflow run / hub start com agentes falsos (item 2.9)', () => {
  let raiz: string;
  let hub: Hub;
  let client: HubClient;
  let semGit: string;
  let comGit: string;
  let n = 0;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-workflow-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(script, AGENTE_FALSO, 'utf8');
    const s = script.replaceAll('\\', '\\\\');
    const manifesto = (id: string, capacidade: string): string =>
      [
        `id: ${id}`,
        `name: ${id}`,
        'bin: node',
        'detect:',
        `  args: ["${s}", "--version"]`,
        'invoke:',
        `  oneShot: ["${s}"]`,
        '  stdinPrompt: true',
        '  env:',
        `    FAKE_AGENT: "${id}"`,
        'session:',
        '  strategy: replay',
        'stream:',
        '  format: jsonl',
        '  mapper: claude',
        `capabilities: [${capacidade}]`,
        'defaults:',
        '  isolation: none',
        '  timeoutSeconds: 60',
        '  supervision: semi',
        '',
      ].join('\n');
    writeFileSync(path.join(manifestos, 'flaky.yaml'), manifesto('flaky', 'tarefa-falsa'), 'utf8');
    writeFileSync(path.join(manifestos, 'beta.yaml'), manifesto('beta', 'tarefa-falsa'), 'utf8');
    writeFileSync(path.join(manifestos, 'solo.yaml'), manifesto('solo', 'sozinho'), 'utf8');

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: 0,
      policy: {
        ...DEFAULT_POLICY,
        retries: { max: 0, backoffMs: 10 },
        fallback: { 'tarefa-falsa': ['flaky', 'beta'] },
        watch: { pauseOn: [], flagOn: [] },
        maxConcurrency: 8,
        maxConcurrencyPerAgent: 2,
        defaultBudget: { usd: 50, tokens: 10_000_000, seconds: 100_000 },
      },
    });
    const { host, port } = await hub.start();
    client = new HubClient(`http://${host}:${port}`);

    semGit = path.join(raiz, 'sem-git');
    mkdirSync(semGit, { recursive: true });
    comGit = path.join(raiz, 'com-git');
    mkdirSync(comGit, { recursive: true });
    git(comGit, ['init', '-q']);
    writeFileSync(path.join(comGit, 'README.md'), '# projeto\n', 'utf8');
    git(comGit, ['add', '-A']);
    git(comGit, ['commit', '-q', '-m', 'init']);
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function arquivo(yaml: string): string {
    n += 1;
    const f = path.join(raiz, `wf-${n}.yaml`);
    writeFileSync(f, yaml, 'utf8');
    return f;
  }

  async function rodar(yaml: string, projeto: string, flags: Record<string, string> = {}) {
    return capturar(() =>
      workflowCommand(
        client,
        {
          command: 'workflow',
          positional: ['run', arquivo(yaml)],
          flags: { project: projeto, ...flags },
        },
        { intervaloMs: 100, esperaMaxMs: 60_000 },
      ),
    );
  }

  test('passo que sofre fallback conclui pelo substituto e libera o dependente', async () => {
    const { linhas, exitCode } = await rodar(
      [
        'name: wf-fallback',
        'steps:',
        '  - id: s1',
        '    agent: flaky',
        '    objective: "primeiro passo @FAIL=flaky"',
        '    isolation: none',
        '  - id: s2',
        '    agent: solo',
        '    objective: "segundo passo depois do fallback"',
        '    isolation: none',
        '    dependsOn: [s1]',
        '',
      ].join('\n'),
      semGit,
    );
    const texto = linhas.join('\n');
    assert.doesNotMatch(texto, /a sessão não tem tarefa/);
    assert.match(texto, /2\/2 passos concluídos/, texto);
    assert.equal(exitCode, undefined);
  });

  test('CONCURRENCY_EXCEEDED via HTTP é retentado: três passos paralelos no mesmo agente concluem', async () => {
    const { linhas, exitCode } = await rodar(
      [
        'name: wf-concorrencia',
        'steps:',
        ...['a', 'b', 'c'].flatMap((id) => [
          `  - id: ${id}`,
          '    agent: solo',
          `    objective: "passo paralelo ${id} @SLEEP=700"`,
          '    isolation: none',
        ]),
        '',
      ].join('\n'),
      semGit,
    );
    const texto = linhas.join('\n');
    assert.doesNotMatch(texto, /não foi possível iniciar/);
    assert.match(texto, /3\/3 passos concluídos/, texto);
    assert.equal(exitCode, undefined);
  });

  test('passo bloqueado por aprovação: o workflow espera, e aprovado, retoma o DAG', async () => {
    let aprovadas = 0;
    let parar = false;
    const aprovador = (async () => {
      while (!parar) {
        for (const a of hub.sessions.pendingApprovals()) {
          // Humano não aprova no mesmo instante: dá tempo ao workflow (que
          // consulta a cada 100 ms) de ver o bloqueio e avisar.
          if (Date.now() - Date.parse(a.requestedAt) < 1_000) continue;
          await hub.sessions.resolveApproval(a.id, 'approved', 'teste');
          aprovadas += 1;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();

    try {
      const { linhas, exitCode } = await rodar(
        [
          'name: wf-aprovacao',
          'steps:',
          '  - id: caro',
          '    agent: solo',
          '    objective: "passo caro @COST=0.9"',
          '    isolation: none',
          '    budget: { usd: 0.5 }',
          '  - id: depois',
          '    agent: solo',
          '    objective: "passo que depende do caro"',
          '    isolation: none',
          '    dependsOn: [caro]',
          '',
        ].join('\n'),
        semGit,
      );
      const texto = linhas.join('\n');
      assert.match(texto, /esperando aprovação/, texto);
      assert.match(texto, /2\/2 passos concluídos/, texto);
      assert.equal(exitCode, undefined);
      assert.equal(aprovadas, 1, 'uma aprovação, sem turno extra que estourasse de novo');
    } finally {
      parar = true;
      await aprovador;
    }
  });

  test('passo seguinte em worktree recebe o CÓDIGO do anterior, não só o resumo', async () => {
    const { linhas, exitCode } = await rodar(
      [
        'name: wf-codigo',
        'steps:',
        '  - id: plan',
        '    agent: solo',
        '    objective: "escrever o plano @WRITE=plan.txt"',
        '  - id: build',
        '    agent: solo',
        '    objective: "seguir o plano @REQUIRE=plan.txt"',
        '    dependsOn: [plan]',
        '',
      ].join('\n'),
      comGit,
    );
    const texto = linhas.join('\n');
    assert.match(texto, /2\/2 passos concluídos/, texto);
    assert.equal(exitCode, undefined);
  });

  test('`hub start` acompanha a tarefa até o substituto concluir (não sai calado no fallback)', async () => {
    const projectId = (await client.addProject(semGit)).project.id;
    const res = await client.startSession({
      projectId,
      brief: { agent: 'flaky', objective: 'tarefa @FAIL=flaky @SLEEP=200', isolation: 'none' },
    });

    const { linhas } = await capturar(() =>
      streamUntilDone(client, { rootId: res.session.rootId }, { taskId: res.task.id, intervaloMs: 100 }),
    );
    const texto = linhas.join('\n');
    const task = hub.store.tasks.get(res.task.id)!;
    assert.equal(task.state, 'completed', 'a CLI só pode devolver o terminal com a tarefa terminada');
    assert.match(texto, /a tarefa passou para/);
    assert.match(texto, /custo do fluxo/);
  });

  test('`hub watch <sessão>` segue para a sessão do substituto', async () => {
    const projectId = (await client.addProject(semGit)).project.id;
    const res = await client.startSession({
      projectId,
      brief: { agent: 'flaky', objective: 'tarefa vigiada @FAIL=flaky @SLEEP=200', isolation: 'none' },
    });

    const { linhas } = await capturar(() =>
      streamUntilDone(client, { sessionId: res.session.id }, { intervaloMs: 100 }),
    );
    const task = hub.store.tasks.get(res.task.id)!;
    assert.equal(task.state, 'completed');
    assert.match(linhas.join('\n'), /RESULTADO_beta/);
  });
});
