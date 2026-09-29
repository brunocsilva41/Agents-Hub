import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, type EventEnvelope, type Session } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Ciclo de vida de sessão (itens 2.1, 2.2 e 2.3 do GOAL; vistoria 2026-09-25,
 * relatórios 06, 08, 11 e 13), com agentes FALSOS — scripts Node que dormem,
 * falham com 429 ou terminam na hora, sem custo e sem rede.
 *
 * - 2.1: cancelar termina `killed`/`canceled` sempre (a corrida cancel × pump
 *   dava `failed` 6 de 8 vezes), inclusive no meio da validação e do backoff;
 *   o desligamento mata a validação em vez de deixá-la órfã; os eventos do
 *   fechamento chegam a quem assina a raiz.
 * - 2.2: interrupt/pause param o turno e deixam a sessão `idle`/`paused`,
 *   retomável por `send` (resume nativo); agente sem retomada é recusado.
 * - 2.3: falha ao subir o agente não deixa sessão `running` fantasma, task
 *   `working`, worktree vazado nem reserva de orçamento presa.
 */

const AGENTE_FALSO = `
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
const modo = process.env.FAKE_MODE || 'ok';
const jsonl = process.env.FAKE_JSONL === '1';
const retomada = argv.includes('--resume');
if (process.env.FAKE_LOG) {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, argv }) + '\\n');
}
function fala(texto) {
  process.stdout.write(
    jsonl
      ? JSON.stringify({ type: 'text', sessionID: 'nat_falso_1', part: { type: 'text', text: texto } }) + '\\n'
      : texto + '\\n',
  );
}
process.stdin.resume();
process.stdin.on('end', () => {
  if (modo === 'rate') {
    process.stderr.write('API error 429: rate limit exceeded\\n');
    process.exit(1);
  }
  fala('comecei');
  if (modo === 'sleep' && !retomada) {
    // Simula um turno longo: é a janela em que os testes cancelam/pausam.
    setTimeout(() => {
      fala('terminei');
      process.exit(0);
    }, Number(process.env.FAKE_MS || 30000));
    return;
  }
  fala('pronto');
  process.exit(0);
});
`;

/** Comando de validação: grava o PID e dorme de propósito — simula o "npm test" lento. */
const VALIDACAO_FALSA = `
require('node:fs').writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => process.exit(0), Number(process.argv[3] || 4000));
`;

function esc(p: string): string {
  return p.replaceAll('\\', '\\\\');
}

interface OpcoesDoManifesto {
  modo?: 'ok' | 'sleep' | 'rate';
  bin?: string;
  jsonl?: boolean;
  strategy?: 'native' | 'replay' | 'none';
  log?: string;
  supervision?: 'supervised' | 'semi' | 'autonomous';
}

function manifesto(id: string, script: string, o: OpcoesDoManifesto = {}): string {
  const jsonl = o.jsonl === true;
  return [
    `id: ${id}`,
    `name: Agente falso ${id}`,
    `bin: ${o.bin ?? 'node'}`,
    'detect:',
    `  args: ["${esc(script)}", "--version"]`,
    'invoke:',
    `  oneShot: ["${esc(script)}"]`,
    ...(o.strategy === 'native'
      ? [`  resume: ["${esc(script)}", "--resume", "{{nativeSessionId}}"]`]
      : []),
    '  stdinPrompt: true',
    '  env:',
    `    FAKE_MODE: "${o.modo ?? 'ok'}"`,
    `    FAKE_JSONL: "${jsonl ? '1' : '0'}"`,
    ...(o.log ? [`    FAKE_LOG: "${esc(o.log)}"`] : []),
    'session:',
    `  strategy: ${o.strategy ?? 'replay'}`,
    'stream:',
    `  format: ${jsonl ? 'jsonl' : 'text'}`,
    `  mapper: ${jsonl ? 'generic-json' : 'generic-text'}`,
    `capabilities: [falso-${id}]`,
    'defaults:',
    '  isolation: none',
    '  timeoutSeconds: 120',
    `  supervision: ${o.supervision ?? 'autonomous'}`,
    '',
  ].join('\n');
}

/**
 * Espera fixa — NUNCA para sincronizar (isso é `esperarAte`). Só em dois usos
 * deliberados, cada um comentado na chamada: variar o instante de uma corrida
 * de propósito, e a janela de uma prova de AUSÊNCIA (algo que não pode
 * acontecer depois de um prazo), onde não existe evento positivo a esperar.
 */
const pausa = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'teste@agents-hub.local');
  git('config', 'user.name', 'teste');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# teste\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
}

interface Ambiente {
  hub: Hub;
  raiz: string;
  projeto: string;
  projectId: string;
  gitProjectId: string;
  naoGitProjectId: string;
  logNativo: string;
  logRate: string;
  pidValidacao: string;
  baseUrl: string;
}

async function montar(
  nome: string,
  opcoes: { validacao?: boolean; http?: boolean; backoffMs?: number; validacaoMs?: number } = {},
): Promise<Ambiente> {
  const raiz = mkdtempSync(path.join(os.tmpdir(), `hub-ciclo-${nome}-`));
  const manifestos = path.join(raiz, 'manifests');
  const projeto = path.join(raiz, 'projeto');
  const projetoGit = path.join(raiz, 'projeto-git');
  const projetoNaoGit = path.join(raiz, 'projeto-nao-git');
  const script = path.join(raiz, 'agente-falso.cjs');
  const valida = path.join(raiz, 'valida.cjs');
  const logNativo = path.join(raiz, 'nativo.log');
  const logRate = path.join(raiz, 'rate.log');
  const pidValidacao = path.join(raiz, 'validacao.pid');
  const naoExecutavel = path.join(raiz, 'nao-executavel.txt');

  for (const dir of [manifestos, projeto, projetoNaoGit]) mkdirSync(dir, { recursive: true });
  gitInit(projetoGit);
  writeFileSync(script, AGENTE_FALSO, 'utf8');
  writeFileSync(valida, VALIDACAO_FALSA, 'utf8');
  writeFileSync(naoExecutavel, 'isto não é um programa\n', 'utf8');

  const m = (id: string, o: OpcoesDoManifesto): void =>
    writeFileSync(path.join(manifestos, `${id}.yaml`), manifesto(id, script, o), 'utf8');
  m('lento', { modo: 'sleep' });
  m('rapido', { modo: 'ok' });
  m('rate', { modo: 'rate', log: logRate });
  m('nativo', { modo: 'sleep', jsonl: true, strategy: 'native', log: logNativo });
  m('semretomada', { modo: 'sleep', strategy: 'none' });
  m('fantasma', { bin: 'agente-que-nao-existe-em-lugar-nenhum-xyz' });
  m('quebrado', { bin: esc(naoExecutavel) });
  // Mesmo id do Codex real: é o id que liga o gate pré-execução.
  m('codex', { modo: 'ok' });

  const hub = createHub({
    home: raiz,
    manifestsDir: manifestos,
    webRoot: path.join(raiz, 'sem-web'),
    ...(opcoes.http ? { port: 0 } : {}),
    policy: {
      ...DEFAULT_POLICY,
      retries: { max: 2, backoffMs: opcoes.backoffMs ?? 10 },
      fallback: {},
      watch: { pauseOn: [], flagOn: [] },
      validation: {
        ...DEFAULT_POLICY.validation,
        command: opcoes.validacao
          ? `node "${valida}" "${pidValidacao}" ${opcoes.validacaoMs ?? 4000}`
          : null,
      },
    },
  });

  let baseUrl = '';
  if (opcoes.http) {
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;
  }

  return {
    hub,
    raiz,
    projeto,
    projectId: hub.sessions.registerProject(projeto, 'projeto').id,
    gitProjectId: hub.sessions.registerProject(projetoGit, 'projeto-git').id,
    naoGitProjectId: hub.sessions.registerProject(projetoNaoGit, 'projeto-nao-git').id,
    logNativo,
    logRate,
    pidValidacao,
    baseUrl,
  };
}

async function desmontar(amb: Ambiente | undefined): Promise<void> {
  if (!amb) return;
  await amb.hub.shutdown();
  try {
    rmSync(amb.raiz, { recursive: true, force: true });
  } catch {
    /* limpeza de temp é oportunista */
  }
}

function eventos(hub: Hub, sessionId: string): EventEnvelope[] {
  return hub.store.events.list({ sessionId, limit: 1000 });
}

async function iniciar(
  amb: Ambiente,
  agent: string,
  extra: {
    requesterSessionId?: string;
    budgetUsd?: number;
    isolation?: 'none' | 'worktree';
    projectId?: string;
    supervision?: 'supervised' | 'semi' | 'autonomous';
  } = {},
): Promise<{ session: Session; taskId: string }> {
  const r = await amb.hub.sessions.start({
    projectId: extra.projectId ?? amb.projectId,
    agentId: '',
    requesterSessionId: extra.requesterSessionId ?? null,
    brief: {
      agent,
      objective: `tarefa de teste para ${agent} ${Math.random().toString(36).slice(2, 8)}`,
      isolation: extra.isolation ?? 'none',
      ...(extra.supervision ? { supervision: extra.supervision } : {}),
      ...(extra.budgetUsd !== undefined ? { budget: { usd: extra.budgetUsd } } : {}),
    },
  });
  return { session: r.session, taskId: r.task.id };
}

function estado(hub: Hub, sessionId: string): { sessao?: string; task?: string } {
  const [task] = hub.store.tasks.list({ sessionId });
  return { sessao: hub.store.sessions.get(sessionId)?.state, task: task?.state };
}

// ============================================================ 2.1 cancelar

describe('2.1 — cancelar termina killed/canceled, nunca failed', () => {
  let amb: Ambiente;

  before(async () => {
    amb = await montar('cancel', { backoffMs: 3000 });
  });
  after(() => desmontar(amb));

  test('corrida cancel × pump: 20 de 20 terminam killed com task canceled', async () => {
    const resultados: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const { session, taskId } = await iniciar(amb, 'lento');
      // Varia o instante do cancelamento: logo depois do spawn, e depois de
      // o agente já ter falado (a janela em que o pump já está no laço).
      if (i % 2 === 1) {
        await esperarAte(
          () => eventos(amb.hub, session.id).some((e) => e.type === 'message'),
          'primeiro evento',
        );
      } else {
        // Corrida intencional: varia o instante do cancel logo após o spawn.
        await pausa(i * 5);
      }
      await amb.hub.sessions.cancel(session.id);
      // Prova de ausência: janela para um pump atrasado (não) sobrescrever o
      // desfecho — o defeito era exatamente uma escrita DEPOIS do cancel.
      await pausa(150);
      const s = amb.hub.store.sessions.get(session.id);
      const t = amb.hub.store.tasks.get(taskId);
      resultados.push(`${s?.state}/${t?.state}`);

      const erros = eventos(amb.hub, session.id).filter(
        (e) => e.type === 'error' && /encerrada sem sucesso/.test(String(e.payload['message'])),
      );
      assert.equal(erros.length, 0, 'cancelamento não é "tarefa encerrada sem sucesso"');
    }
    assert.deepEqual(
      resultados,
      Array.from({ length: 20 }, () => 'killed/canceled'),
      `desfechos: ${resultados.join(', ')}`,
    );
    assert.equal(amb.hub.sessions.liveCount(), 0);
  });

  test('pai recebe delegation.completed com state canceled, não failed', async () => {
    const pai = await iniciar(amb, 'lento');
    const filho = await iniciar(amb, 'lento', { requesterSessionId: pai.session.id });
    await esperarAte(
      () => eventos(amb.hub, filho.session.id).some((e) => e.type === 'message'),
      'filho falou',
    );

    await amb.hub.sessions.cancel(filho.session.id);
    // Prova de ausência: janela para um segundo `delegation.completed`
    // (duplicado) ou um desfecho `failed` tardio aparecerem.
    await pausa(150);

    const retorno = eventos(amb.hub, pai.session.id).filter(
      (e) => e.type === 'delegation.completed' && e.payload['childSessionId'] === filho.session.id,
    );
    assert.equal(retorno.length, 1, 'exatamente um retorno da delegação');
    assert.equal(retorno[0]?.payload['state'], 'canceled');
    assert.deepEqual(estado(amb.hub, filho.session.id), { sessao: 'killed', task: 'canceled' });
    assert.equal(amb.hub.store.sessions.get(pai.session.id)?.state, 'running', 'o pai segue vivo');

    await amb.hub.sessions.cancel(pai.session.id);
  });

  test('cancel em cascata alcança filho pausado (e fecha todos como canceled)', async () => {
    const pai = await iniciar(amb, 'lento');
    const filho = await iniciar(amb, 'lento', { requesterSessionId: pai.session.id });
    await esperarAte(
      () => eventos(amb.hub, filho.session.id).some((e) => e.type === 'message'),
      'filho falou',
    );
    await amb.hub.sessions.pause(filho.session.id);
    assert.equal(amb.hub.store.sessions.get(filho.session.id)?.state, 'paused');

    await amb.hub.sessions.cancel(pai.session.id);
    // Prova de ausência: janela para um pump atrasado (não) reescrever o desfecho.
    await pausa(150);
    assert.deepEqual(estado(amb.hub, pai.session.id), { sessao: 'killed', task: 'canceled' });
    assert.deepEqual(estado(amb.hub, filho.session.id), { sessao: 'killed', task: 'canceled' });
  });

  test('cancel durante o backoff de retry fecha a task como canceled na hora', async () => {
    writeFileSync(amb.logRate, '');
    const { session, taskId } = await iniciar(amb, 'rate');
    await esperarAte(
      () =>
        eventos(amb.hub, session.id).some(
          (e) => e.type === 'log' && /nova tentativa/.test(String(e.payload['text'])),
        ),
      'aviso de nova tentativa',
    );

    const t0 = Date.now();
    await amb.hub.sessions.cancel(session.id);
    assert.ok(Date.now() - t0 < 2500, 'cancel não pode esperar o backoff inteiro');
    assert.equal(amb.hub.store.sessions.get(session.id)?.state, 'killed');
    assert.equal(amb.hub.store.tasks.get(taskId)?.state, 'canceled', 'task não pode ficar working');

    // Passado o backoff, nenhuma tentativa nova subiu. Prova de ausência cujo
    // objeto é o próprio prazo (3000 ms de backoff): não há evento a esperar.
    await pausa(3500);
    const execucoes = readFileSync(amb.logRate, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(execucoes.length, 1, 'o retry não pode rodar depois do cancelamento');
    assert.deepEqual(estado(amb.hub, session.id), { sessao: 'killed', task: 'canceled' });
  });

  test('eventos do fechamento chegam a quem assina a raiz (nada depois de #finish)', async () => {
    const { session } = await iniciar(amb, 'lento');
    await esperarAte(
      () => eventos(amb.hub, session.id).some((e) => e.type === 'message'),
      'primeiro evento',
    );

    const recebidos = new Set<number>();
    const desassinar = amb.hub.bus.subscribe({ rootId: session.rootId }, (e) => {
      if (e.sessionId === session.id) recebidos.add(e.seq);
    });
    const ultimoAntes = Math.max(...eventos(amb.hub, session.id).map((e) => e.seq));
    try {
      await amb.hub.sessions.cancel(session.id);
      // Prova de ausência: janela para um evento tardio (depois do #finish)
      // cair no banco sem passar pela assinatura da raiz.
      await pausa(300);
    } finally {
      desassinar();
    }

    const depois = eventos(amb.hub, session.id).filter((e) => e.seq > ultimoAntes);
    assert.ok(
      depois.some((e) => e.type === 'session.ended'),
      'o fim precisa estar na timeline',
    );
    const perdidos = depois.filter((e) => !recebidos.has(e.seq)).map((e) => `${e.seq}:${e.type}`);
    assert.deepEqual(perdidos, [], 'todo evento do fechamento precisa chegar pelo filtro de raiz');
  });
});

describe('2.1 — cancelar durante a validação', () => {
  let amb: Ambiente;

  before(async () => {
    amb = await montar('validacao', { validacao: true });
  });
  after(() => desmontar(amb));

  test('cancelado no meio da validação não ressuscita como completed, e o comando morre', async () => {
    rmSync(amb.pidValidacao, { force: true });
    const { session, taskId } = await iniciar(amb, 'rapido');
    await esperarAte(
      () => existsSync(amb.pidValidacao) && readFileSync(amb.pidValidacao, 'utf8').length > 0,
      'validação começou',
    );
    const pid = Number(readFileSync(amb.pidValidacao, 'utf8'));
    assert.ok(vivo(pid), 'a validação deveria estar rodando');

    await amb.hub.sessions.cancel(session.id);

    assert.deepEqual(estado(amb.hub, session.id), { sessao: 'killed', task: 'canceled' });
    assert.equal(vivo(pid), false, 'o comando de validação precisa morrer com o cancelamento');

    // Depois do tempo que a validação levaria (4000 ms), o desfecho continua o
    // do cancel. Prova de ausência cujo objeto é o próprio prazo.
    await pausa(4500);
    assert.deepEqual(estado(amb.hub, session.id), { sessao: 'killed', task: 'canceled' });
    assert.equal(amb.hub.store.tasks.get(taskId)?.result, null, 'nada de resultado entregue');
  });
});

describe('2.1 — desligar durante a validação', () => {
  test('shutdown mata o comando de validação em vez de deixá-lo órfão', async () => {
    // Validação longa: o PID só pode estar morto porque o desligamento o matou,
    // não porque o comando terminou sozinho enquanto o daemon esperava.
    const amb = await montar('shutdown', { validacao: true, validacaoMs: 60_000 });
    try {
      rmSync(amb.pidValidacao, { force: true });
      await iniciar(amb, 'rapido');
      await esperarAte(
        () => existsSync(amb.pidValidacao) && readFileSync(amb.pidValidacao, 'utf8').length > 0,
        'validação começou',
      );
      const pid = Number(readFileSync(amb.pidValidacao, 'utf8'));
      assert.ok(vivo(pid));

      const t0 = Date.now();
      await amb.hub.shutdown();
      assert.equal(vivo(pid), false, 'validação órfã depois do desligamento');
      assert.ok(Date.now() - t0 < 20_000, 'o desligamento não pode esperar a validação inteira');
    } finally {
      try {
        rmSync(amb.raiz, { recursive: true, force: true });
      } catch {
        /* oportunista */
      }
    }
  });
});

// ======================================================= 2.2 interrupt/pause

describe('2.2 — interrupt e pause param o turno sem matar a sessão', () => {
  let amb: Ambiente;

  before(async () => {
    amb = await montar('interrupt', { http: true });
  });
  after(() => desmontar(amb));

  async function post(
    rota: string,
    corpo: unknown = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${amb.baseUrl}${rota}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test('interrupt via HTTP: sessão idle (não failed), task input_required, send retoma com resume nativo', async () => {
    writeFileSync(amb.logNativo, '');
    const { session, taskId } = await iniciar(amb, 'nativo');
    await esperarAte(
      () => amb.hub.store.sessions.get(session.id)?.nativeSessionId === 'nat_falso_1',
      'id nativo conhecido',
    );
    const pid = amb.hub.store.sessions.get(session.id)?.pid;
    assert.ok(pid);

    const r = await post(`/sessions/${session.id}/interrupt`);
    assert.equal(r.status, 200);
    assert.equal(r.body['interrupted'], true);
    assert.equal(r.body['state'], 'idle');

    // O sinal de parada já saiu; o processo morre no ritmo do SO.
    await esperarAte(() => !vivo(pid), 'o processo do turno ser encerrado');
    assert.deepEqual(estado(amb.hub, session.id), { sessao: 'idle', task: 'input_required' });
    const task = amb.hub.store.tasks.get(taskId);
    assert.equal(task?.attempts.length, 1);
    assert.equal(task?.attempts[0]?.endedAt, null, 'interromper não fecha a tentativa (não é falha)');
    assert.ok(
      !eventos(amb.hub, session.id).some((e) => e.type === 'error'),
      'interrupção não pode aparecer como erro',
    );

    // Retomar: resume nativo, com o id que o agente revelou.
    const envio = await post(`/sessions/${session.id}/send`, { text: 'continue de onde parou' });
    assert.equal(envio.status, 200);
    assert.equal(envio.body['mode'], 'resume');
    await esperarAte(
      () => amb.hub.store.sessions.get(session.id)?.state === 'completed',
      'retomada concluída',
    );
    assert.equal(amb.hub.store.tasks.get(taskId)?.state, 'completed');

    const execucoes = readFileSync(amb.logNativo, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[] });
    assert.equal(execucoes.length, 2);
    assert.deepEqual(execucoes[1]?.argv.slice(-2), ['--resume', 'nat_falso_1']);
  });

  test('pause via HTTP: sessão paused, task input_required, send retoma', async () => {
    const { session, taskId } = await iniciar(amb, 'nativo');
    await esperarAte(
      () => amb.hub.store.sessions.get(session.id)?.nativeSessionId === 'nat_falso_1',
      'id nativo conhecido',
    );
    const pid = amb.hub.store.sessions.get(session.id)?.pid;
    assert.ok(pid);

    const r = await post(`/sessions/${session.id}/pause`);
    assert.equal(r.status, 200);
    assert.equal(r.body['state'], 'paused');
    // O sinal de parada já saiu; o processo morre no ritmo do SO.
    await esperarAte(() => !vivo(pid), 'o processo do turno ser encerrado');
    assert.deepEqual(estado(amb.hub, session.id), { sessao: 'paused', task: 'input_required' });

    const envio = await post(`/sessions/${session.id}/send`, { text: 'pode seguir' });
    assert.equal(envio.body['mode'], 'resume');
    await esperarAte(
      () => amb.hub.store.sessions.get(session.id)?.state === 'completed',
      'retomada concluída',
    );
    assert.equal(amb.hub.store.tasks.get(taskId)?.state, 'completed');
  });

  test('interrupt sem turno em andamento responde interrupted:false e não mexe no estado', async () => {
    const { session } = await iniciar(amb, 'lento');
    await esperarAte(() => eventos(amb.hub, session.id).some((e) => e.type === 'message'), 'falou');
    await post(`/sessions/${session.id}/interrupt`);
    const r = await post(`/sessions/${session.id}/interrupt`);
    assert.equal(r.body['interrupted'], false);
    assert.equal(r.body['state'], 'idle');
    await amb.hub.sessions.cancel(session.id);
  });

  test('interrupt de sessão já encerrada é ILLEGAL_STATE, não "interrompido"', async () => {
    const { session } = await iniciar(amb, 'lento');
    await amb.hub.sessions.cancel(session.id);
    const r = await post(`/sessions/${session.id}/interrupt`);
    assert.equal(r.status, 400);
    assert.equal((r.body['error'] as { code: string }).code, 'ILLEGAL_STATE');
  });

  test('agente sem retomada (strategy none): recusa explícita, sessão segue rodando', async () => {
    const { session } = await iniciar(amb, 'semretomada');
    await esperarAte(() => eventos(amb.hub, session.id).some((e) => e.type === 'message'), 'falou');
    const r = await post(`/sessions/${session.id}/interrupt`);
    assert.equal((r.body['error'] as { code: string }).code, 'ILLEGAL_STATE');
    assert.match(String((r.body['error'] as { message: string }).message), /não retoma sessão/);
    const p = await post(`/sessions/${session.id}/pause`);
    assert.equal((p.body['error'] as { code: string }).code, 'ILLEGAL_STATE');
    assert.equal(amb.hub.store.sessions.get(session.id)?.state, 'running');
    assert.equal(amb.hub.sessions.isLive(session.id), true);
    await amb.hub.sessions.cancel(session.id);
  });
});

// ================================================ 2.3 falha ao subir o agente

describe('2.3 — falha ao subir o agente não deixa fantasma', () => {
  let amb: Ambiente;

  before(async () => {
    amb = await montar('launch', { http: true });
  });
  after(() => desmontar(amb));

  function semFantasma(): void {
    const fantasmas = amb.hub.store.sessions
      .list()
      .filter((s) => s.state === 'running' && !amb.hub.sessions.isLive(s.id));
    assert.deepEqual(
      fantasmas.map((s) => `${s.agentId}:${s.id}`),
      [],
      'sessão running sem processo',
    );
  }

  function ultimaSessao(agentId: string): Session {
    const s = amb.hub.store.sessions
      .list()
      .filter((x) => x.agentId === agentId)
      .at(-1);
    assert.ok(s, `nenhuma sessão de ${agentId}`);
    return s;
  }

  test('AGENT_NOT_INSTALLED via HTTP: 424, sessão failed com motivo, task failed, worktree liberado', async () => {
    const res = await fetch(`${amb.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: amb.gitProjectId,
        brief: { agent: 'fantasma', objective: 'tarefa que nunca sobe', isolation: 'worktree' },
      }),
    });
    assert.equal(res.status, 424);

    const s = ultimaSessao('fantasma');
    assert.equal(s.state, 'failed');
    assert.ok(s.endedAt);
    const [task] = amb.hub.store.tasks.list({ sessionId: s.id });
    assert.equal(task?.state, 'failed');
    assert.ok(task?.attempts[0]?.endedAt, 'tentativa fechada');
    assert.match(String(task?.attempts[0]?.error), /não está no PATH/);
    assert.ok(
      eventos(amb.hub, s.id).some((e) => e.type === 'session.ended' && e.payload['state'] === 'failed'),
    );
    assert.notEqual(s.workdir, amb.hub.store.projects.get(amb.gitProjectId)?.path);
    assert.equal(existsSync(s.workdir), false, 'worktree vazado');
    semFantasma();
  });

  test('gate do Codex recusado (supervised): sessão failed, nada rodando', async () => {
    await assert.rejects(
      () => iniciar(amb, 'codex', { supervision: 'supervised' }),
      (e: Error & { code?: string }) => e.code === 'CODEX_GATE_NOT_GUARANTEED',
    );
    const s = ultimaSessao('codex');
    assert.equal(s.state, 'failed');
    assert.equal(amb.hub.store.tasks.list({ sessionId: s.id })[0]?.state, 'failed');
    semFantasma();
  });

  test('spawn que falha (binário não executável): sessão e task failed', async () => {
    let sessionId: string | null = null;
    try {
      sessionId = (await iniciar(amb, 'quebrado')).session.id;
    } catch {
      sessionId = ultimaSessao('quebrado').id;
    }
    await esperarAte(() => {
      const st = amb.hub.store.sessions.get(sessionId)?.state;
      return st === 'failed';
    }, 'desfecho do spawn');
    assert.equal(amb.hub.store.tasks.list({ sessionId })[0]?.state, 'failed');
    semFantasma();
  });

  test('delegações que não sobem devolvem a reserva: a delegação legítima seguinte passa', async () => {
    const pai = await iniciar(amb, 'lento', { budgetUsd: 10 });
    try {
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(
          () => iniciar(amb, 'fantasma', { requesterSessionId: pai.session.id, budgetUsd: 2 }),
          (e: Error & { code?: string }) => e.code === 'AGENT_NOT_INSTALLED',
        );
      }
      // Delegação para projeto não-git com worktree: falha ANTES de criar a
      // sessão — e também não pode prender a fatia.
      await assert.rejects(
        () =>
          iniciar(amb, 'rapido', {
            requesterSessionId: pai.session.id,
            budgetUsd: 2,
            isolation: 'worktree',
            projectId: amb.naoGitProjectId,
          }),
        /não é um repositório git/,
      );

      const orcamento = amb.hub.sessions.budget(pai.session.id);
      assert.equal(orcamento.reserved.usd, 0, 'reserva presa');
      assert.equal(orcamento.remaining.usd, 10);

      const legitima = await iniciar(amb, 'rapido', {
        requesterSessionId: pai.session.id,
        budgetUsd: 5,
      });
      assert.ok(legitima.session.id);
      semFantasma();
    } finally {
      await amb.hub.sessions.cancel(pai.session.id).catch(() => undefined);
    }
  });
});
