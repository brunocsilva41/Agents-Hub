import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, isTerminalTaskState } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Pendência D(3) do fechamento do MVP: sessão em validação/revisão não
 * contava no teto de concorrência. A run sai de `#runs` quando o processo do
 * agente termina, mas o `validation.command` (processo real — um `npm test`)
 * e o revisor ainda rodam; com `maxConcurrency: 1` uma segunda sessão subia
 * no meio da validação da primeira.
 *
 * Agentes FALSOS (scripts Node), sem modelo e sem rede. Os testes de fallback
 * e retry com `maxConcurrency: 1` guardam o outro lado: a vaga que a sessão
 * segura no fechamento não pode barrar o substituto dela mesma.
 */

const AGENTE_FALSO = `
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => {
  if (process.env.FAKE_MODE === 'rate') {
    process.stderr.write('API error 429: rate limit exceeded\\n');
    process.exit(1);
  }
  process.stdout.write('pronto\\n');
  process.exit(0);
});
`;

/** Validação lenta: grava o PID (sinal de "estou validando") e dorme. */
const VALIDACAO_FALSA = `
require('node:fs').writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => process.exit(0), Number(process.argv[3]));
`;

function esc(p: string): string {
  return p.replaceAll('\\', '\\\\');
}

function manifesto(id: string, script: string, modo: 'ok' | 'rate'): string {
  return [
    `id: ${id}`,
    `name: Agente falso ${id}`,
    'bin: node',
    'detect:',
    `  args: ["${esc(script)}", "--version"]`,
    'invoke:',
    `  oneShot: ["${esc(script)}"]`,
    '  stdinPrompt: true',
    '  env:',
    `    FAKE_MODE: "${modo}"`,
    'session:',
    '  strategy: replay',
    'stream:',
    '  format: text',
    '  mapper: generic-text',
    'capabilities: [tarefa-falsa]',
    'defaults:',
    '  isolation: none',
    '  timeoutSeconds: 120',
    '  supervision: autonomous',
    '',
  ].join('\n');
}

interface Ambiente {
  hub: Hub;
  raiz: string;
  projectId: string;
  pidValidacao: string;
}

function montar(nome: string, opcoes: { validacaoMs: number | null; retries: number }): Ambiente {
  const raiz = mkdtempSync(path.join(os.tmpdir(), `hub-conc-${nome}-`));
  const manifestos = path.join(raiz, 'manifests');
  const projeto = path.join(raiz, 'projeto');
  const script = path.join(raiz, 'agente-falso.cjs');
  const valida = path.join(raiz, 'valida.cjs');
  const pidValidacao = path.join(raiz, 'validacao.pid');
  mkdirSync(manifestos, { recursive: true });
  mkdirSync(projeto, { recursive: true });
  writeFileSync(script, AGENTE_FALSO, 'utf8');
  writeFileSync(valida, VALIDACAO_FALSA, 'utf8');
  writeFileSync(path.join(manifestos, 'rapido.yaml'), manifesto('rapido', script, 'ok'), 'utf8');
  writeFileSync(path.join(manifestos, 'outro.yaml'), manifesto('outro', script, 'ok'), 'utf8');
  writeFileSync(path.join(manifestos, 'rate.yaml'), manifesto('rate', script, 'rate'), 'utf8');

  const hub = createHub({
    home: raiz,
    manifestsDir: manifestos,
    webRoot: path.join(raiz, 'sem-web'),
    policy: {
      ...DEFAULT_POLICY,
      maxConcurrency: 1,
      retries: { max: opcoes.retries, backoffMs: 10 },
      fallback: { 'tarefa-falsa': ['rate', 'rapido'] },
      watch: { pauseOn: [], flagOn: [] },
      validation: {
        ...DEFAULT_POLICY.validation,
        command:
          opcoes.validacaoMs === null
            ? null
            : `node "${valida}" "${pidValidacao}" ${opcoes.validacaoMs}`,
      },
    },
  });
  return {
    hub,
    raiz,
    projectId: hub.sessions.registerProject(projeto, 'projeto').id,
    pidValidacao,
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

function iniciar(amb: Ambiente, agent: string) {
  return amb.hub.sessions.start({
    projectId: amb.projectId,
    agentId: '',
    brief: {
      agent,
      objective: `tarefa de teste para ${agent} ${Math.random().toString(36).slice(2, 8)}`,
      isolation: 'none',
    },
  });
}

function terminou(hub: Hub, taskId: string): boolean {
  const estado = hub.store.tasks.get(taskId)?.state;
  return estado !== undefined && isTerminalTaskState(estado);
}

describe('teto de concorrência conta sessão em validação/revisão', () => {
  let amb: Ambiente;

  before(() => {
    amb = montar('validacao', { validacaoMs: 3000, retries: 0 });
  });
  after(() => desmontar(amb));

  test('com maxConcurrency 1, segunda sessão é recusada enquanto a primeira valida', async () => {
    const primeira = await iniciar(amb, 'rapido');
    // O processo do agente já saiu (a run deixou `#runs`); o que roda agora
    // é o `validation.command` da sessão.
    await esperarAte(() => existsSync(amb.pidValidacao), 'validação da primeira começar');
    assert.ok(Number(readFileSync(amb.pidValidacao, 'utf8')) > 0);
    assert.equal(amb.hub.sessions.isLive(primeira.session.id), false, 'a run já saiu de #runs');

    // Outro agente: o teto global é que precisa barrar, não o por agente.
    await assert.rejects(
      iniciar(amb, 'outro'),
      (err: Error & { code?: string }) => err.code === 'CONCURRENCY_EXCEEDED',
    );

    // Terminada a validação, a vaga volta.
    await esperarAte(() => terminou(amb.hub, primeira.task.id), 'primeira terminar');
    assert.equal(amb.hub.store.tasks.get(primeira.task.id)?.state, 'completed');
    const segunda = await iniciar(amb, 'outro');
    await esperarAte(() => terminou(amb.hub, segunda.task.id), 'segunda terminar');
  });
});

describe('a vaga do fechamento não barra o substituto da própria sessão', () => {
  let amb: Ambiente;

  before(() => {
    amb = montar('fallback', { validacaoMs: null, retries: 0 });
  });
  after(() => desmontar(amb));

  test('fallback com maxConcurrency 1: o substituto sobe e conclui', async () => {
    const { task } = await iniciar(amb, 'rate');
    await esperarAte(() => terminou(amb.hub, task.id), 'task terminar');
    const final = amb.hub.store.tasks.get(task.id)!;
    assert.equal(final.state, 'completed', JSON.stringify(final.attempts));
    assert.deepEqual(
      final.attempts.map((a) => a.agentId),
      ['rate', 'rapido'],
    );
  });
});

describe('retry também não é barrado pela vaga da própria sessão', () => {
  let amb: Ambiente;

  before(() => {
    amb = montar('retry', { validacaoMs: null, retries: 1 });
  });
  after(() => desmontar(amb));

  test('retry com maxConcurrency 1: a segunda tentativa roda na mesma vaga', async () => {
    const { task } = await iniciar(amb, 'rate');
    await esperarAte(() => terminou(amb.hub, task.id), 'task terminar');
    const final = amb.hub.store.tasks.get(task.id)!;
    const recusas = amb.hub.store.events
      .list({ taskId: task.id, limit: 500 })
      .filter((e) => /CONCURRENCY_EXCEEDED|simultâneas/.test(JSON.stringify(e.payload)));
    assert.deepEqual(recusas, [], 'nenhuma tentativa pode ter sido recusada pelo teto');
    assert.ok(final.attempts.length >= 2, JSON.stringify(final.attempts));
  });
});
