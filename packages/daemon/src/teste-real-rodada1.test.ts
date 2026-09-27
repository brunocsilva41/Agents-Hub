import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Defeitos do teste real de 2026-09-26 (rodada 1, docs/vistoria-2026-09-25/
 * STATUS.md), reproduzidos com agentes FALSOS pelo daemon inteiro:
 *
 * - motivo de falha: a 1ª linha do stderr (aviso "failed to load skill ...
 *   SKILL.md") virava o erro da tentativa, em vez do evento `error` do agente
 *   ("You've hit your usage limit"); e limite de uso virava falha permanente
 *   genérica, com fallback sem aviso claro;
 * - negar o estouro de orçamento DEPOIS de o turno concluir marcava a sessão
 *   `killed` — o trabalho tinha sido entregue;
 * - "✓ turno concluído" repetido por turno.
 *
 * Diretivas no objetivo: `@COST=usd`, `@QUOTA=<agente>`, `@TURNO2` (o agente
 * emite dois `result` de sucesso na mesma run, como o Copilot).
 */

const AGENTE = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
const agente = process.env.FAKE_AGENT;
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, agente + '\\n');
  const tem = (k) => prompt.includes('@' + k);
  const valor = (k) => { const m = prompt.match(new RegExp('@' + k + '=(\\\\S+)')); return m ? m[1] : null; };
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const sid = 'nat-' + agente + '-' + process.pid;
  // Aviso do AMBIENTE do usuário, no stderr, antes de tudo (como no Codex real).
  process.stderr.write('failed to load skill C:\\\\x\\\\SKILL.md: missing YAML frontmatter\\n');
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', tools: [] });
  if (valor('QUOTA') === agente) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid,
      result: "You've hit your usage limit. Upgrade to Pro or try again later." });
    process.stderr.write('ERROR: stream ended\\n');
    process.exitCode = 1;
    return;
  }
  out({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'RESULTADO_' + agente }] } });
  const r = { type: 'result', subtype: 'success', is_error: false, result: 'RESULTADO_' + agente, session_id: sid,
    total_cost_usd: Number(valor('COST') || 0), usage: { input_tokens: 10, output_tokens: 5 } };
  out(r);
  if (tem('TURNO2')) out({ ...r, total_cost_usd: 0, usage: {} });
});
`;

const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);

describe('teste real — rodada 1: defeitos reproduzidos com agentes falsos', () => {
  let raiz: string;
  let hub: Hub;
  let log: string;
  let cont = 0;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-rodada1-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(script, AGENTE, 'utf8');
    log = path.join(raiz, 'execucoes.log');
    writeFileSync(log, '', 'utf8');
    const s = script.replaceAll('\\', '\\\\');
    for (const id of ['cota', 'reserva', 'solo']) {
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
          `    FAKE_LOG: "${log.replaceAll('\\', '\\\\')}"`,
          'session:',
          '  strategy: replay',
          'stream:',
          '  format: jsonl',
          '  mapper: claude',
          `capabilities: [${id === 'solo' ? 'sozinho' : 'tarefa-cota'}]`,
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
      policy: {
        ...DEFAULT_POLICY,
        retries: { max: 2, backoffMs: 10 },
        fallback: { 'tarefa-cota': ['cota', 'reserva'] },
        watch: { pauseOn: [], flagOn: [] },
        defaultBudget: { usd: 50, tokens: 10_000_000, seconds: 100_000 },
      },
    });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza oportunista */
    }
  });

  function projeto(): string {
    cont += 1;
    const dir = path.join(raiz, `proj-${cont}`);
    mkdirSync(dir, { recursive: true });
    return hub.sessions.registerProject(dir, `proj-${cont}`).id;
  }

  function execucoes(): string[] {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }

  async function esperar(cond: () => boolean, oque: string, ms = 20_000): Promise<void> {
    const limite = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > limite) throw new Error(`${oque} não aconteceu em ${ms}ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test('falha por cota: motivo = evento error do agente (não o aviso do stderr), sem retry, fallback AVISADO antes', async () => {
    const antes = execucoes().length;
    const { session, task } = await hub.sessions.start({
      projectId: projeto(),
      agentId: '',
      brief: { agent: 'cota', objective: 'tarefa @QUOTA=cota', isolation: 'none' },
    });
    await esperar(() => hub.store.tasks.get(task.id)?.state === 'completed', 'tarefa concluída pela reserva');

    const t = hub.store.tasks.get(task.id)!;
    const primeira = t.attempts[0]!;
    assert.equal(primeira.agentId, 'cota');
    assert.match(primeira.error ?? '', /usage limit/, `motivo registrado: ${primeira.error}`);
    assert.doesNotMatch(primeira.error ?? '', /SKILL\.md/, 'aviso do stderr promovido a motivo');

    // Cota não se repete com o mesmo agente: uma execução de `cota`, uma de `reserva`.
    assert.deepEqual(execucoes().slice(antes), ['cota', 'reserva']);

    // Aviso explícito de fallback na timeline da sessão original, com o substituto.
    const eventos = hub.sessions.listEvents(session.id);
    const aviso = eventos.find((e) => e.type === 'log' && e.payload['kind'] === 'fallback');
    assert.ok(aviso, 'sem aviso de fallback');
    assert.equal(aviso.payload['toAgentId'], 'reserva');
    assert.match(String(aviso.payload['text']), /cota/);
  });

  test('negar o estouro com o turno JÁ concluído: sessão e tarefa `completed`, com a nota', async () => {
    const antes = execucoes().length;
    const { session, task } = await hub.sessions.start({
      projectId: projeto(),
      agentId: '',
      brief: { agent: 'solo', objective: 'caro @COST=0.9', isolation: 'none', budget: { usd: 0.5 } },
    });
    await esperar(() => hub.sessions.pendingApprovals(session.id).length > 0, 'aprovação de orçamento');
    await esperar(() => !hub.sessions.isLive(session.id), 'fim do processo');
    const [pendente] = hub.sessions.pendingApprovals(session.id);
    assert.equal(pendente?.detail['turnCompleted'], true);

    await hub.sessions.resolveApproval(pendente.id, 'denied', 'teste');
    await esperar(() => TERMINAIS.has(hub.store.tasks.get(task.id)?.state ?? ''), 'tarefa terminal');
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(hub.store.sessions.get(session.id)!.state, 'completed');
    const t = hub.store.tasks.get(task.id)!;
    assert.equal(t.state, 'completed');
    assert.match(t.result?.summary ?? '', /orçamento excedido; continuação negada/);
    assert.match(t.result?.summary ?? '', /RESULTADO_solo/);
    assert.equal(execucoes().slice(antes).length, 1, 'o agente não pode rodar de novo');
  });

  test('um turno, UM `turn.completed` — mesmo com o agente fechando o turno duas vezes', async () => {
    const { session, task } = await hub.sessions.start({
      projectId: projeto(),
      agentId: '',
      brief: { agent: 'solo', objective: 'simples @TURNO2', isolation: 'none' },
    });
    await esperar(() => hub.store.tasks.get(task.id)?.state === 'completed', 'tarefa concluída');
    const fins = hub.sessions.listEvents(session.id).filter((e) => e.type === 'turn.completed');
    assert.equal(fins.length, 1, `turn.completed por turno: ${fins.length}`);
  });
});
