import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, isTerminalSessionState } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Vistoria 2026-09-25: R13-17 (revisão APROVADA não deixava registro) e
 * R06-14 (diff só era capturado no caminho de sucesso). Agentes FALSOS
 * (script node no dialeto JSONL do Claude); nenhum CLI de modelo roda.
 *
 * Diretivas no objetivo: `@WRITE=arquivo` escreve no diretório da sessão,
 * `@FAIL` sai com erro permanente DEPOIS de escrever, `@SLEEP=ms` segura a run.
 * O agente `revisor` responde `APROVADO`.
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
  const dir = (k) => (prompt.match(new RegExp('@' + k + '(=(\\\\S+))?', 'g')) || []).map((x) => x.slice(k.length + 2));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const sid = 'nat-' + agente + '-' + process.pid;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', tools: [] });
  const texto = agente === 'revisor' ? 'APROVADO: critérios atendidos' : 'RESULTADO_' + agente;
  if (agente !== 'revisor') {
    for (const w of dir('WRITE')) fs.writeFileSync(path.join(process.cwd(), w), 'feito por ' + agente + '\\n');
    if (dir('FAIL').length > 0) { process.stderr.write('erro de sintaxe no arquivo\\n'); process.exitCode = 2; return; }
    const sleep = Number(dir('SLEEP')[0] || 0);
    // Simula um agente ainda trabalhando: é a janela em que o teste cancela.
    if (sleep) await new Promise((r) => setTimeout(r, sleep));
  }
  out({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: texto }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: texto, session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 0 } });
});
`;

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=teste', '-c', 'user.email=teste@local', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);

describe('revisão aprovada e diff em falha/cancelamento (R13-17, R06-14)', () => {
  let raiz: string;
  let hub: Hub;
  let cont = 0;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-revisao-diff-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(script, AGENTE_FALSO, 'utf8');
    const s = script.replaceAll('\\', '\\\\');
    for (const id of ['autor', 'revisor']) {
      writeFileSync(
        path.join(manifestos, `${id}.yaml`),
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
          `capabilities: [${id}]`,
          'defaults:',
          '  isolation: none',
          '  timeoutSeconds: 60',
          '  supervision: autonomous',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: 0,
      policy: {
        ...DEFAULT_POLICY,
        retries: { max: 0, backoffMs: 10 },
        fallback: {},
        watch: { pauseOn: [], flagOn: [] },
        validation: {
          command: null,
          commandTimeoutSeconds: 60,
          review: { enabled: true, agent: 'revisor' },
        },
      },
    });
    await hub.start();
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function projetoGit(): string {
    cont += 1;
    const dir = path.join(raiz, `repo-${cont}`);
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    writeFileSync(path.join(dir, 'README.md'), '# projeto\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
    return hub.sessions.registerProject(dir, `repo-${cont}`).id;
  }

  const iniciar = (projectId: string, objective: string) =>
    hub.sessions.start({
      projectId,
      agentId: '',
      brief: { agent: 'autor', objective, isolation: 'none' },
    });

  // A task vira `failed` antes de a sessão fechar: o diff é gravado no
  // fechamento, então a espera é pela SESSÃO terminal.
  const sessaoFechada = (sessionId: string): Promise<boolean> =>
    esperarAte(() => {
      const s = hub.store.sessions.get(sessionId);
      return s !== null && isTerminalSessionState(s.state);
    }, 'sessão terminal');

  const diffs = (sessionId: string) =>
    hub.store.artifacts.list({ sessionId }).filter((a) => a.kind === 'diff');

  test('revisão APROVADA entra em `validation` e vira evento na timeline', async () => {
    const { session, task } = await iniciar(projetoGit(), 'criar o arquivo @WRITE=novo.txt');
    await esperarAte(() => TERMINAIS.has(hub.store.tasks.get(task.id)?.state ?? ''), 'task terminal');
    const final = hub.store.tasks.get(task.id)!;
    assert.equal(final.state, 'completed');
    const checks = final.result?.validation?.checks ?? [];
    assert.ok(
      checks.some((c) => /revis/i.test(c.name) && /revisor/.test(c.name) && c.passed),
      JSON.stringify(final.result?.validation),
    );
    const eventos = hub.store.events.list({ sessionId: session.id, types: ['log'], limit: 500 });
    assert.ok(
      eventos.some(
        (e) => e.payload['kind'] === 'review.approved' && /APROVADO/.test(String(e.payload['text'])),
      ),
      'evento de revisão aprovada',
    );
  });

  test('sessão que FALHA depois de escrever gera o artefato de diff', async () => {
    const { session, task } = await iniciar(projetoGit(), 'escrever e quebrar @WRITE=parcial.txt @FAIL');
    await esperarAte(() => TERMINAIS.has(hub.store.tasks.get(task.id)?.state ?? ''), 'task terminal');
    assert.equal(hub.store.tasks.get(task.id)?.state, 'failed');
    await sessaoFechada(session.id);
    const d = diffs(session.id);
    assert.equal(d.length, 1, 'um diff da tentativa que falhou');
    assert.ok(existsSync(d[0]!.path));
    assert.match(readFileSync(d[0]!.path, 'utf8'), /parcial\.txt/);
  });

  test('sessão CANCELADA depois de escrever gera o artefato de diff', async () => {
    const projectId = projetoGit();
    const { session, task } = await iniciar(
      projectId,
      'escrever e esperar @WRITE=meio.txt @SLEEP=20000',
    );
    const arquivo = path.join(hub.store.sessions.get(session.id)!.workdir, 'meio.txt');
    await esperarAte(() => existsSync(arquivo), 'agente escrever');
    await hub.sessions.cancel(session.id, 'teste');
    await esperarAte(() => TERMINAIS.has(hub.store.tasks.get(task.id)?.state ?? ''), 'task terminal');
    await sessaoFechada(session.id);
    const d = diffs(session.id);
    assert.equal(d.length, 1, 'um diff do trabalho interrompido');
    assert.match(readFileSync(d[0]!.path, 'utf8'), /meio\.txt/);
  });
});
