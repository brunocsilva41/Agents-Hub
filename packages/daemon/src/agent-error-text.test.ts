import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, HubError } from '@agents-hub/core';
import { juntarErroDoAgente, textoDoErroDoAgente } from './agent-error-text.js';
import { createHub, type Hub } from './hub.js';

describe('texto do erro do agente (unidade)', () => {
  test('lê message, summary ou error, nessa ordem', () => {
    assert.equal(textoDoErroDoAgente({ summary: 'Prompt is too long' }), 'Prompt is too long');
    assert.equal(textoDoErroDoAgente({ message: 'm', summary: 's' }), 'm');
    assert.equal(textoDoErroDoAgente({ error: 'e' }), 'e');
    assert.equal(textoDoErroDoAgente({ subtype: 'x' }), null);
  });

  test('junta só quando houve falha, sem repetir', () => {
    assert.equal(juntarErroDoAgente(null, 'x'), null);
    assert.equal(juntarErroDoAgente('código 1', null), 'código 1');
    assert.equal(juntarErroDoAgente('código 1', 'Prompt is too long'), 'Prompt is too long (código 1)');
    assert.equal(juntarErroDoAgente('código 1: Prompt is too long', 'Prompt is too long'), 'código 1: Prompt is too long');
  });
});

/**
 * Integração com um agente falso de sessão NATIVA (formato do Claude:
 * `system/init` com `session_id`, `result` no fim):
 *
 * - vistoria 08, achado 11: a recusa "Prompt is too long" (linha `result` com
 *   `is_error`, código 1) ficava fora da tentativa — o chamador via só
 *   "processo terminou com código 1";
 * - vistoria 11, achado R11-05: `send` em sessão CONCLUÍDA é recusado, mas a
 *   recusa precisa ensinar o caminho (sessão nova a partir desta) e não pode
 *   subir o agente.
 */
describe('agente nativo falso: erro repassado e send em sessão concluída', () => {
  let raiz: string;
  let hub: Hub;
  let projetoPath: string;
  let contador: string;

  function agente(id: string, linhas: unknown[], codigo: number): string {
    const script = path.join(raiz, `${id}.cjs`);
    writeFileSync(
      script,
      `
const fs = require('fs');
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  const n = Number(fs.readFileSync(${JSON.stringify(contador)}, 'utf8'));
  fs.writeFileSync(${JSON.stringify(contador)}, String(n + 1), 'utf8');
  for (const l of ${JSON.stringify(linhas)}) process.stdout.write(JSON.stringify(l) + '\\n');
  process.exit(${codigo});
});
`,
      'utf8',
    );
    const s = script.replace(/\\/g, '\\\\');
    writeFileSync(
      path.join(raiz, 'manifests', `${id}.yaml`),
      `
id: ${id}
name: ${id}
vendor: Test
description: Agente falso de sessão nativa
bin: node
invoke:
  oneShot: ["${s}"]
  resume: ["${s}", "--resume", "{{nativeSessionId}}"]
  stdinPrompt: true
  interactive: false
detect:
  args: ["${s}", "--version"]
capabilities:
  - code-edit
session:
  strategy: native
stream:
  format: jsonl
  mapper: claude
defaults:
  isolation: none
  timeoutSeconds: 30
`,
      'utf8',
    );
    return id;
  }

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-erro-agente-'));
    mkdirSync(path.join(raiz, 'manifests'), { recursive: true });
    projetoPath = path.join(raiz, 'projeto');
    mkdirSync(projetoPath, { recursive: true });
    contador = path.join(raiz, 'invocacoes.n');
    writeFileSync(contador, '0', 'utf8');

    const init = { type: 'system', subtype: 'init', session_id: 'nativa-123' };
    agente(
      'nativo-recusa',
      [init, { type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', session_id: 'nativa-123' }],
      1,
    );
    agente(
      'nativo-ok',
      [
        init,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] }, session_id: 'nativa-123' },
        { type: 'result', subtype: 'success', result: 'OK', total_cost_usd: 0, session_id: 'nativa-123' },
      ],
      0,
    );

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: path.join(raiz, 'manifests'),
      policy: {
        ...DEFAULT_POLICY,
        watch: { pauseOn: [], flagOn: [] },
        retries: { ...DEFAULT_POLICY.retries, max: 0 },
        fallback: {},
        defaultBudget: { usd: 10, tokens: 1_000_000, seconds: 100_000 },
      },
    });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  async function esperar(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
    const limite = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > limite) throw new Error('condição não satisfeita a tempo');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function rodar(agentId: string) {
    const proj = hub.sessions.registerProject(projetoPath, 'Erro do agente');
    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId,
      brief: {
        agent: agentId,
        objective: 'Responda apenas com a palavra OK',
        acceptanceCriteria: [],
        constraints: [],
        isolation: 'none',
        supervision: 'semi',
      },
    });
    await esperar(() => {
      const t = hub.store.tasks.get(started.task.id);
      return !!t && ['completed', 'failed'].includes(t.state) && !hub.sessions.isLive(started.session.id);
    });
    return started;
  }

  test('"Prompt is too long" chega à tentativa, não só "código 1"', async () => {
    const { task } = await rodar('nativo-recusa');
    const t = hub.store.tasks.get(task.id);
    assert.equal(t?.state, 'failed');
    assert.match(String(t?.attempts[0]?.error), /Prompt is too long/);
  });

  test('send em sessão concluída é recusado, ensina "hub start --from" e não sobe o agente', async () => {
    const { session } = await rodar('nativo-ok');
    assert.equal(hub.store.sessions.get(session.id)?.state, 'completed');
    assert.equal(hub.store.sessions.get(session.id)?.nativeSessionId, 'nativa-123');
    const antes = readFileSync(contador, 'utf8');

    await assert.rejects(
      () => hub.sessions.send(session.id, 'e agora, mais uma coisa'),
      (err: unknown) => {
        assert.ok(err instanceof HubError);
        assert.equal(err.code, 'ILLEGAL_STATE');
        assert.match(err.message, new RegExp(`hub start --from ${session.id}`));
        assert.match(err.message, /context_refs/);
        assert.equal((err.details as { continuarCom?: { from?: string } }).continuarCom?.from, session.id);
        return true;
      },
    );
    assert.equal(readFileSync(contador, 'utf8'), antes, 'o agente não pode ter sido invocado');
    assert.equal(hub.store.sessions.get(session.id)?.state, 'completed');
  });
});
