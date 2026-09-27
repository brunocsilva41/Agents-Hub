import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, textoDe } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Handoff (vistoria 2026-09-25, item 2.7):
 *
 * - `agent_id` ficava fora do UPDATE de sessão: o novo agente rodava, mas o
 *   banco seguia dizendo que a sessão era do antigo;
 * - a sessão contava duas vezes no teto de concorrência (run antiga + reserva
 *   do novo agente), então com o Hub cheio todo handoff era recusado;
 * - o pump da run antiga, cancelada, seguia para `#settle` e marcava a task
 *   como falha no meio da troca.
 */
const SCRIPT = `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
const lento = process.argv.includes('lento');
setTimeout(() => { process.stdout.write('pronto\\n'); process.exit(0); }, lento ? 30000 : 800);
`;

async function esperar<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > limite) throw new Error('condição não atingida a tempo');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('handoff: agente persistido, uma vaga só, sem falha fantasma', () => {
  let raiz: string;
  let hub: Hub;
  let projetoPath: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-conc-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'agente.cjs');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    writeFileSync(script, SCRIPT, 'utf8');

    const s = script.replace(/\\/g, '\\\\');
    for (const [id, modo] of [
      ['lento-a', 'lento'],
      ['rapido-b', 'rapido'],
    ] as const) {
      writeFileSync(
        path.join(manifestos, `${id}.yaml`),
        `
id: ${id}
name: ${id}
vendor: Test
description: Agente de teste
bin: node
invoke:
  oneShot: ["${s}", "${modo}"]
  interactive: false
detect:
  args: ["${s}", "--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 60
`,
        'utf8',
      );
    }

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      policy: {
        ...DEFAULT_POLICY,
        // Hub CHEIO com uma sessão só: o handoff dela não pode ser recusado.
        maxConcurrency: 1,
        watch: { pauseOn: [], flagOn: [] },
        retries: { max: 0, backoffMs: 0 },
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

  test('com o teto ocupado pela própria sessão, o handoff passa e o novo agente é persistido', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Handoff concorrência');
    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId: 'lento-a',
      brief: {
        agent: 'lento-a',
        objective: 'Trabalhar devagar até alguém assumir',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });
    const sessionId = started.session.id;
    assert.equal(hub.sessions.isLive(sessionId), true);

    await hub.sessions.handoff(sessionId, 'rapido-b', 'teste');

    assert.equal(
      hub.store.sessions.get(sessionId)?.agentId,
      'rapido-b',
      'o banco precisa refletir o agente novo (agent_id no UPDATE)',
    );

    const estado = await esperar(() => {
      const t = hub.store.tasks.get(started.task.id);
      return t && ['completed', 'failed', 'canceled', 'rejected'].includes(t.state) ? t : undefined;
    });
    assert.equal(estado.state, 'completed', 'a run cancelada no handoff não pode derrubar a task');

    const agentes = estado.attempts.map((a) => a.agentId);
    assert.deepEqual(agentes, ['lento-a', 'rapido-b'], 'o histórico de tentativas registra a troca');
    assert.ok(estado.attempts[0]?.endedAt, 'a tentativa do agente antigo foi fechada');
    assert.equal(estado.attempts[1]?.outcome, 'success');

    const erros = hub.store.events
      .list({ sessionId, types: ['error'] })
      .map((e) => textoDe(e.payload['message']));
    assert.deepEqual(erros, [], `nenhum erro fantasma do pump antigo: ${erros.join(' | ')}`);
    assert.equal(hub.store.sessions.get(sessionId)?.agentId, 'rapido-b');
  });
});
