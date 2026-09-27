import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, textoDe, type EventEnvelope } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Itens 2.9 e 2.10 da vistoria de 2026-09-25 (relatório 13): orquestração de
 * ponta a ponta com agentes FALSOS, pelo daemon inteiro.
 *
 * O agente falso fala o dialeto JSONL do Claude (mapper `claude`), então dá
 * para injetar custo, uso de ferramenta e escrita em disco por diretivas no
 * próprio objetivo (`@FAIL=<agente>`, `@SLEEP=ms`, `@COST=usd`, `@TOKENS=n`,
 * `@WRITE=arquivo`, `@REQUIRE=arquivo`, `@TOOL=comando_com_underscores`).
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
  fs.appendFileSync(process.env.FAKE_LOG, agente + '\\n');
  const dir = (k) => (prompt.match(new RegExp('@' + k + '=(\\\\S+)', 'g')) || []).map((x) => x.slice(k.length + 2));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const sid = 'nat-' + agente + '-' + process.pid;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', tools: [] });
  if (dir('FAIL').includes(agente)) { process.stderr.write('API error 429: rate limit exceeded\\n'); process.exitCode = 1; return; }
  for (const r of dir('REQUIRE')) {
    if (!fs.existsSync(path.join(process.cwd(), r))) { process.stderr.write('faltou ' + r + ' no checkout\\n'); process.exitCode = 3; return; }
  }
  for (const w of dir('WRITE')) fs.writeFileSync(path.join(process.cwd(), w), 'feito por ' + agente + '\\n');
  for (const t of dir('TOOL')) {
    out({ type: 'assistant', message: { id: 'm-tool', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: t.replace(/_/g, ' ') } }] } });
  }
  const tokens = Number(dir('TOKENS')[0] || 0);
  if (tokens) out({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'pensando' }], usage: { input_tokens: tokens, output_tokens: 0 } } });
  const sleep = Number(dir('SLEEP')[0] || 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  out({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'RESULTADO_' + agente }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'RESULTADO_' + agente, session_id: sid, total_cost_usd: Number(dir('COST')[0] || 0), usage: { input_tokens: tokens, output_tokens: 0 } });
});
`;

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const endereco = srv.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      srv.close(() => resolve(porta));
    });
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=teste', '-c', 'user.email=teste@local', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);

describe('orquestração com agentes falsos (itens 2.9 e 2.10)', () => {
  let raiz: string;
  let hub: Hub;
  let baseUrl: string;
  let log: string;
  let comGit: string;
  let projetoGit: string;
  let cont = 0;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-orquestracao-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(script, AGENTE_FALSO, 'utf8');
    log = path.join(raiz, 'execucoes.log');
    writeFileSync(log, '', 'utf8');

    const s = script.replaceAll('\\', '\\\\');
    const manifesto = (id: string, supervisao: string, capacidade: string): string =>
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
        `    FAKE_LOG: "${log.replaceAll('\\', '\\\\')}"`,
        'session:',
        '  strategy: replay',
        'stream:',
        '  format: jsonl',
        '  mapper: claude',
        `capabilities: [${capacidade}]`,
        'defaults:',
        '  isolation: none',
        '  timeoutSeconds: 60',
        `  supervision: ${supervisao}`,
        '',
      ].join('\n');
    for (const id of ['flaky', 'backup', 'gama']) {
      writeFileSync(
        path.join(manifestos, `${id}.yaml`),
        manifesto(id, 'autonomous', 'tarefa-falsa'),
        'utf8',
      );
    }
    writeFileSync(path.join(manifestos, 'solo.yaml'), manifesto('solo', 'semi', 'sozinho'), 'utf8');

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: await portaLivre(),
      policy: {
        ...DEFAULT_POLICY,
        retries: { max: 1, backoffMs: 10 },
        fallback: { 'tarefa-falsa': ['flaky', 'backup', 'gama'] },
        watch: { pauseOn: [], flagOn: [] },
        maxConcurrency: 8,
        maxConcurrencyPerAgent: 4,
        defaultBudget: { usd: 50, tokens: 10_000_000, seconds: 100_000 },
      },
    });
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;

    comGit = path.join(raiz, 'com-git');
    mkdirSync(comGit, { recursive: true });
    git(comGit, ['init', '-q']);
    writeFileSync(path.join(comGit, 'README.md'), '# projeto\n', 'utf8');
    git(comGit, ['add', '-A']);
    git(comGit, ['commit', '-q', '-m', 'init']);
    projetoGit = hub.sessions.registerProject(comGit, 'com-git').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  /** Projeto novo por teste: a config `.agents-hub/config.yaml` é por projeto. */
  function projeto(configYaml?: string): string {
    cont += 1;
    const dir = path.join(raiz, `proj-${cont}`);
    mkdirSync(path.join(dir, '.agents-hub'), { recursive: true });
    if (configYaml) writeFileSync(path.join(dir, '.agents-hub', 'config.yaml'), configYaml, 'utf8');
    return hub.sessions.registerProject(dir, `proj-${cont}`).id;
  }

  function execucoes(): string[] {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }

  async function esperar(cond: () => boolean, timeoutMs = 20_000, oque = 'condição'): Promise<void> {
    const limite = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`${oque} não aconteceu em ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function terminal(taskId: string): Promise<string> {
    await esperar(
      () => TERMINAIS.has(hub.store.tasks.get(taskId)?.state ?? ''),
      20_000,
      `task ${taskId} terminal`,
    );
    return hub.store.tasks.get(taskId)!.state;
  }

  function brief(agent: string, objective: string, extra: Record<string, unknown> = {}) {
    return { agent, objective, isolation: 'none', ...extra };
  }

  // ------------------------------------------------------------ 2.10 overrides

  test('override de projeto `retries.max: 0` vale em tempo de execução (o agente roda UMA vez)', async () => {
    const projectId = projeto('policy:\n  retries:\n    max: 0\n');
    const antes = execucoes().length;
    const { task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('flaky', 'tarefa @FAIL=flaky @FAIL=backup @FAIL=gama'),
    });
    await terminal(task.id);
    const rodadas = execucoes().slice(antes);
    // Global `max: 1` rodaria flaky 2x (tentativa + retry) antes da troca.
    assert.equal(rodadas.filter((a) => a === 'flaky').length, 1, `rodadas: ${rodadas.join(',')}`);
  });

  test('override de projeto `fallback` corta a cadeia (backup fora: o substituto é gama)', async () => {
    const projectId = projeto(
      "policy:\n  retries:\n    max: 0\n  fallback:\n    tarefa-falsa: ['flaky', 'gama']\n",
    );
    const { task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('flaky', 'tarefa @FAIL=flaky'),
    });
    assert.equal(await terminal(task.id), 'completed');
    const final = hub.store.tasks.get(task.id)!;
    assert.deepEqual(
      final.attempts.map((a) => a.agentId),
      ['flaky', 'gama'],
    );
  });

  test('override de projeto `watch.pauseOn: [escalate]` pausa a sessão com aprovação', async () => {
    const projectId = projeto('policy:\n  watch:\n    pauseOn: [escalate]\n');
    const { session, task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'baixar algo @TOOL=curl_http://x.example', { supervision: 'semi' }),
    });
    await esperar(
      () =>
        hub.store.tasks.get(task.id)?.state === 'input_required' ||
        TERMINAIS.has(hub.store.tasks.get(task.id)?.state ?? ''),
      20_000,
      'pausa ou fim',
    );
    const pendentes = hub.sessions.pendingApprovals(session.id);
    assert.equal(pendentes.length, 1, 'a vigilância do projeto deveria ter parado em escalate');
    assert.equal(pendentes[0]!.detail['kind'], 'watch');
    await hub.sessions.resolveApproval(pendentes[0]!.id, 'denied', 'teste');
  });

  test('override de projeto `maxConcurrency: 1` recusa a segunda sessão simultânea do projeto', async () => {
    const projectId = projeto('policy:\n  maxConcurrency: 1\n');
    const primeira = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'demora @SLEEP=1500'),
    });
    await assert.rejects(
      hub.sessions.start({ projectId, agentId: '', brief: brief('gama', 'outra tarefa qualquer') }),
      (err: Error & { code?: string }) => err.code === 'CONCURRENCY_EXCEEDED',
    );
    // Outro projeto (sem o override) não é afetado.
    const outro = projeto();
    const livre = await hub.sessions.start({
      projectId: outro,
      agentId: '',
      brief: brief('gama', 'tarefa livre'),
    });
    await terminal(livre.task.id);
    await terminal(primeira.task.id);
  });

  test('`supervision: autonomous` capado pelo manifesto `semi` deixa aviso na timeline', async () => {
    const projectId = projeto();
    const { session, task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'qualquer', { supervision: 'autonomous' }),
    });
    assert.equal(session.mode, 'semi');
    await terminal(task.id);
    const avisos = hub.sessions
      .listEvents(session.id)
      .filter(
        (e) => e.type === 'log' && textoDe(e.payload['text']).includes('modo "autonomous" pedido'),
      );
    assert.equal(avisos.length, 1);
  });

  // ------------------------------------------------------------ 2.10 orçamento

  test('orçamento em `seconds` é teto de tempo de parede: para a run e pede aprovação', async () => {
    const projectId = projeto();
    const inicio = Date.now();
    const { session, task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'demora @SLEEP=6000', { budget: { seconds: 1 } }),
    });
    await esperar(
      () =>
        hub.store.tasks.get(task.id)?.state === 'input_required' ||
        TERMINAIS.has(hub.store.tasks.get(task.id)?.state ?? ''),
      20_000,
      'estouro de tempo',
    );
    assert.equal(hub.store.tasks.get(task.id)!.state, 'input_required');
    assert.ok(Date.now() - inicio < 5_000, 'a run deveria ter parado antes do fim natural (6 s)');
    const [pendente] = hub.sessions.pendingApprovals(session.id);
    assert.equal(pendente?.detail['kind'], 'budget');
    assert.match(pendente.action, /s de 1s de tempo/);
    await hub.sessions.resolveApproval(pendente.id, 'denied', 'teste');
  });

  test('aprovar estouro com o turno JÁ concluído não relança o agente: só finaliza', async () => {
    const projectId = projeto();
    const antes = execucoes().length;
    const { session, task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'caro @COST=0.9', { budget: { usd: 0.5 } }),
    });
    await esperar(
      () => hub.sessions.pendingApprovals(session.id).length > 0,
      20_000,
      'aprovação de orçamento',
    );
    await esperar(() => !hub.sessions.isLive(session.id), 20_000, 'fim do processo');
    const [pendente] = hub.sessions.pendingApprovals(session.id);

    await hub.sessions.resolveApproval(pendente!.id, 'approved', 'teste');
    assert.equal(await terminal(task.id), 'completed');
    // Dá tempo a um relançamento indevido de aparecer.
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(execucoes().slice(antes).length, 1, 'o agente não pode rodar de novo');
    assert.equal(hub.sessions.pendingApprovals(session.id).length, 0);
    assert.equal(hub.store.sessions.get(session.id)!.state, 'completed');
  });

  test('estouro não empilha aprovações; `send` na sessão bloqueada é recusado sem criar outra', async () => {
    const projectId = projeto();
    const { session } = await hub.sessions.start({
      projectId,
      agentId: '',
      // A linha `assistant` (estimativa) já estoura; o `result` (final) estoura de novo.
      brief: brief('solo', 'tokens @TOKENS=30', { budget: { tokens: 20 } }),
    });
    await esperar(() => hub.sessions.pendingApprovals(session.id).length > 0, 20_000, 'aprovação');
    await esperar(() => !hub.sessions.isLive(session.id), 20_000, 'fim do processo');
    assert.equal(hub.sessions.pendingApprovals(session.id).length, 1);
    assert.match(hub.sessions.pendingApprovals(session.id)[0]!.action, /tokens/);

    await assert.rejects(hub.sessions.send(session.id, 'e aí?'), /aguardando aprovação/);
    assert.equal(hub.sessions.pendingApprovals(session.id).length, 1);
    await hub.sessions.resolveApproval(
      hub.sessions.pendingApprovals(session.id)[0]!.id,
      'denied',
      'teste',
    );
  });

  // ------------------------------------------------- 2.9 código entre passos

  test('sessão concluída em worktree commita o trabalho em hub/<id>; a seguinte parte dele', async () => {
    const projectId = projetoGit;
    const a = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'planejar @WRITE=plan.txt', { isolation: 'worktree' }),
    });
    assert.equal(await terminal(a.task.id), 'completed');
    assert.match(git(comGit, ['show', `hub/${a.session.id}:plan.txt`]), /feito por solo/);

    const b = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'executar o plano @REQUIRE=plan.txt', { isolation: 'worktree' }),
      baseSessionIds: [a.session.id],
    });
    assert.ok(
      existsSync(path.join(b.session.workdir, 'plan.txt')),
      'o worktree do passo seguinte deveria ter o código',
    );
    assert.equal(await terminal(b.task.id), 'completed');
  });

  test('fan-in: junta o trabalho de duas sessões; conflito é recusado com erro explícito', async () => {
    const projectId = projetoGit;
    const x = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'x @WRITE=x.txt @WRITE=igual.txt', { isolation: 'worktree' }),
    });
    const y = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('gama', 'y @WRITE=y.txt @WRITE=igual.txt', { isolation: 'worktree' }),
    });
    const z = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'z @WRITE=z.txt', { isolation: 'worktree' }),
    });
    for (const t of [x, y, z]) assert.equal(await terminal(t.task.id), 'completed');

    const juncao = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'junta @REQUIRE=x.txt @REQUIRE=z.txt', { isolation: 'worktree' }),
      baseSessionIds: [x.session.id, z.session.id],
    });
    assert.equal(await terminal(juncao.task.id), 'completed');

    // `igual.txt` com conteúdo diferente nos dois (autores diferentes).
    await assert.rejects(
      hub.sessions.start({
        projectId,
        agentId: '',
        brief: brief('solo', 'conflito', { isolation: 'worktree' }),
        baseSessionIds: [x.session.id, y.session.id],
      }),
      /conflito ao juntar hub\//,
    );
  });

  test('fallback em worktree: o substituto parte da mesma base do original (herda o código)', async () => {
    const projectId = projetoGit;
    const base = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('solo', 'base @WRITE=base.txt', { isolation: 'worktree' }),
    });
    assert.equal(await terminal(base.task.id), 'completed');

    const { task } = await hub.sessions.start({
      projectId,
      agentId: '',
      brief: brief('flaky', 'continua @FAIL=flaky @REQUIRE=base.txt', { isolation: 'worktree' }),
      baseSessionIds: [base.session.id],
    });
    assert.equal(await terminal(task.id), 'completed');
    assert.notEqual(hub.store.sessions.get(hub.store.tasks.get(task.id)!.sessionId)!.agentId, 'flaky');
  });

  // ------------------------------------------------------- 2.10 SSE da task

  test('/api/tasks/:id/events segue o fallback e FECHA quando a task termina', async () => {
    const projectId = projeto();
    const res = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        brief: brief('flaky', 'tarefa @FAIL=flaky @SLEEP=300'),
      }),
    });
    assert.equal(res.status, 201);
    const { session, task } = (await res.json()) as { session: { id: string }; task: { id: string } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const eventos: EventEnvelope[] = [];
    let fechou = false;
    try {
      const sse = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { signal: controller.signal });
      let buffer = '';
      for await (const chunk of sse.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString('utf8');
        let fim: number;
        while ((fim = buffer.indexOf('\n\n')) >= 0) {
          const bloco = buffer.slice(0, fim);
          buffer = buffer.slice(fim + 2);
          const data = bloco.split('\n').find((l) => l.startsWith('data: '));
          if (data) eventos.push(JSON.parse(data.slice(6)) as EventEnvelope);
        }
      }
      fechou = true;
    } catch {
      fechou = false;
    } finally {
      clearTimeout(timer);
    }

    assert.ok(fechou, 'o stream deveria fechar sozinho quando a task termina');
    const final = hub.store.tasks.get(task.id)!;
    assert.equal(final.state, 'completed');
    assert.notEqual(final.sessionId, session.id);
    assert.ok(
      eventos.some((e) => e.sessionId === final.sessionId && e.type === 'turn.completed'),
      'o stream deveria trazer o turno do substituto',
    );
  });
});
