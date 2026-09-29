import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, type EventEnvelope } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Custo de turno que termina porque o HUB parou a run (teste real de
 * 2026-09-29, rodada 2): a vigilância pausou um `git push` do Claude, o Hub
 * matou o processo e o orçamento do fluxo ficou em US$ 0,00 e 0 tokens — o
 * modelo foi chamado e o gasto sumiu. O `tool_use` que disparou a pausa era
 * justamente o evento que trazia o `usage` da mensagem.
 *
 * Os agentes falsos imprimem o formato do Claude (`usage` na mensagem do
 * assistente, que o mapper trata como estimativa parcial) e depois ficam
 * "trabalhando" até o Hub matá-los por cada um dos caminhos de parada. Um
 * deles não manda `usage` nenhum (o Codex só informa no `turn.completed`):
 * esse turno tem custo DESCONHECIDO, e o orçamento não pode ser cobrado por
 * um número inventado.
 */

const USAGE = { input_tokens: 1200, output_tokens: 300 };
const TOKENS_DO_TURNO = USAGE.input_tokens + USAGE.output_tokens;
const CUSTO_FINAL = 0.0421;

const AGENTE = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('2.1.285\\n'); process.exit(0); }
const modo = process.env.MODO_AGENTE;
const linha = (o) => fs.writeSync(1, JSON.stringify(o) + '\\n');
const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const usage = ${JSON.stringify(USAGE)};
linha({ type: 'system', subtype: 'init', session_id: 'nativo-' + process.pid, model: 'claude-opus-5-5', tools: ['Bash'] });
if (modo === 'push') {
  linha({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [
    { type: 'tool_use', id: 'toolu_push_1', name: 'Bash', input: { command: 'git push origin main' } },
  ] } });
} else if (modo === 'parcial') {
  linha({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [
    { type: 'text', text: 'lendo o repositório' },
  ] } });
} else if (modo === 'final') {
  linha({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [
    { type: 'text', text: 'pronto' },
  ] } });
  linha({ type: 'result', subtype: 'success', is_error: false, result: 'pronto',
    session_id: 'nativo-' + process.pid, total_cost_usd: ${CUSTO_FINAL}, usage });
} else {
  linha({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'pensando' }] } });
}
// "Trabalhando" até o Hub encerrar o processo.
dormir(60000);
process.exit(0);
`;

function manifesto(id: string, script: string, modo: string): string {
  const esc = (s: string): string => s.replaceAll('\\', '\\\\');
  return [
    `id: ${id}`,
    `name: ${id}`,
    'bin: node',
    'detect:',
    `  args: ["${esc(script)}", "--version"]`,
    'invoke:',
    `  oneShot: ["${esc(script)}"]`,
    `  resume: ["${esc(script)}", "--resume", "{{nativeSessionId}}"]`,
    '  stdinPrompt: true',
    '  env:',
    `    MODO_AGENTE: "${modo}"`,
    'session:',
    '  strategy: native',
    'stream:',
    '  format: jsonl',
    '  mapper: claude',
    'defaults:',
    '  isolation: none',
    '  timeoutSeconds: 120',
    '',
  ].join('\n');
}

describe('custo do turno parado pelo Hub entra no orçamento', () => {
  let raiz: string;
  let hub: Hub;
  let projetoId: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-custo-parada-'));
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'claude-falso.cjs');
    for (const d of [manifestos, projeto]) mkdirSync(d, { recursive: true });
    writeFileSync(script, AGENTE, 'utf8');
    for (const modo of ['push', 'parcial', 'final', 'sem-usage']) {
      writeFileSync(
        path.join(manifestos, `falso-${modo}.yaml`),
        manifesto(`falso-${modo}`, script, modo),
        'utf8',
      );
    }

    // Política PADRÃO: a vigilância (pauseOn: irreversible) é quem pausa o push
    // de um agente sem gate.
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      policy: DEFAULT_POLICY,
    });
    projetoId = hub.sessions.registerProject(projeto, 'custo na parada').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza oportunista */
    }
  });

  async function iniciar(modo: string, budget: { usd: number; seconds?: number } = { usd: 10 }) {
    const agent = `falso-${modo}`;
    return hub.sessions.start({
      projectId: projetoId,
      agentId: agent,
      brief: { agent, objective: 'trabalhar', isolation: 'none', supervision: 'semi', budget },
    });
  }

  /** Espera o evento com custo ser lido do stream: a partir daí o Hub pode parar a run. */
  async function esperarCustoNoStream(sessionId: string): Promise<void> {
    await esperarAte(
      () => hub.sessions.listEvents(sessionId).some((e) => !!e.cost),
      'evento com usage no stream',
    );
  }

  async function esperarRunEncerrada(sessionId: string): Promise<void> {
    await esperarAte(() => !hub.sessions.isLive(sessionId), 'run encerrada');
  }

  function fechamentos(sessionId: string): EventEnvelope[] {
    return hub.sessions.listEvents(sessionId).filter((e) => e.payload['kind'] === 'custo.turno.fechado');
  }

  /** O orçamento do fluxo cobrou a estimativa do turno morto — uma vez só. */
  function assertEstimativaCobrada(rootId: string, sessionId: string): void {
    const [fechamento, ...extras] = fechamentos(sessionId);
    assert.ok(fechamento, 'o turno parado fecha a conta pela estimativa num evento próprio');
    assert.equal(extras.length, 0, 'fechamento em dobro');
    assert.equal(fechamento.payload['costBasis'], 'estimated');
    const usd = fechamento.cost?.usd ?? 0;
    assert.ok(usd > 0, `estimativa em dólares: ${usd}`);

    const budget = hub.sessions.budget(rootId);
    assert.ok(
      Math.abs(budget.consumed.usd - usd) < 1e-9,
      `orçamento US$ ${budget.consumed.usd}, estimativa ${usd}`,
    );
    assert.equal(budget.consumed.tokens, TOKENS_DO_TURNO, 'tokens do turno parado');
  }

  test('vigilância pausa o git push e a aprovação é negada: a estimativa do turno morto é cobrada', async () => {
    const { session, task } = await iniciar('push');
    const apv = await esperarAte(
      () => hub.sessions.pendingApprovals(session.id)[0],
      'aprovação da vigilância',
    );
    assert.equal(apv.detail['kind'], 'watch');
    await esperarRunEncerrada(session.id);
    await hub.sessions.resolveApproval(apv.id, 'denied', 'teste');
    await esperarAte(() => hub.store.sessions.get(session.id)?.state === 'killed', 'sessão killed');
    assert.equal(hub.store.tasks.get(task.id)?.state, 'rejected');

    assertEstimativaCobrada(session.rootId, session.id);
  });

  test('cancel no meio do turno: a estimativa é cobrada', async () => {
    const { session } = await iniciar('parcial');
    await esperarCustoNoStream(session.id);
    await hub.sessions.cancel(session.id);
    await esperarRunEncerrada(session.id);

    assertEstimativaCobrada(session.rootId, session.id);
  });

  test('interrupt no meio do turno: a estimativa é cobrada', async () => {
    const { session } = await iniciar('parcial');
    await esperarCustoNoStream(session.id);
    assert.equal(await hub.sessions.interrupt(session.id), true);
    await esperarRunEncerrada(session.id);

    assertEstimativaCobrada(session.rootId, session.id);
  });

  test('pause no meio do turno: a estimativa é cobrada', async () => {
    const { session } = await iniciar('parcial');
    await esperarCustoNoStream(session.id);
    await hub.sessions.pause(session.id);
    await esperarRunEncerrada(session.id);
    assert.equal(hub.store.sessions.get(session.id)?.state, 'paused');

    assertEstimativaCobrada(session.rootId, session.id);
  });

  test('teto de tempo estoura no meio do turno: a estimativa é cobrada', async () => {
    const { session } = await iniciar('parcial', { usd: 10, seconds: 2 });
    await esperarCustoNoStream(session.id);
    await esperarAte(
      () => hub.sessions.pendingApprovals(session.id).find((a) => a.detail['kind'] === 'budget'),
      'aprovação de estouro do teto de tempo',
    );
    await esperarRunEncerrada(session.id);

    assertEstimativaCobrada(session.rootId, session.id);
  });

  test('custo final chegou antes da parada: cobra o final, sem somar a estimativa nem fechar de novo', async () => {
    const { session } = await iniciar('final');
    await esperarAte(
      () => hub.sessions.listEvents(session.id).some((e) => !!e.cost && e.cost.provisional !== true),
      'custo final no stream',
    );
    await hub.sessions.cancel(session.id);
    await esperarRunEncerrada(session.id);

    assert.equal(fechamentos(session.id).length, 0, 'turno com custo final não fecha pela estimativa');
    const budget = hub.sessions.budget(session.rootId);
    assert.ok(
      Math.abs(budget.consumed.usd - CUSTO_FINAL) < 1e-9,
      `orçamento US$ ${budget.consumed.usd}`,
    );
    assert.equal(budget.consumed.tokens, TOKENS_DO_TURNO);
  });

  test('turno parado sem usage nenhum: evento de custo desconhecido e orçamento intacto', async () => {
    const { session } = await iniciar('sem-usage');
    await esperarAte(
      () => hub.sessions.listEvents(session.id).some((e) => e.type === 'message'),
      'mensagem do agente',
    );
    await hub.sessions.cancel(session.id);
    await esperarRunEncerrada(session.id);

    assert.equal(fechamentos(session.id).length, 0, 'não há estimativa para fechar');
    const desconhecidos = hub.sessions
      .listEvents(session.id)
      .filter((e) => e.payload['kind'] === 'custo.turno.desconhecido');
    assert.equal(desconhecidos.length, 1, 'um aviso de custo desconhecido por turno parado');
    const [aviso] = desconhecidos;
    assert.equal(aviso?.payload['costBasis'], 'unknown');
    assert.equal(aviso?.cost ?? null, null, 'custo desconhecido não é custo zero');
    assert.match(String(aviso?.payload['text']), /desconhecido/);

    const budget = hub.sessions.budget(session.rootId);
    assert.equal(budget.consumed.usd, 0, 'orçamento não é cobrado por valor inventado');
    assert.equal(budget.consumed.tokens, 0);
  });
});
