import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Handoff de sessão PAUSADA (ou interrompida): a pausa deixa a task em
 * `input_required`, e o handoff subia o novo agente sem devolvê-la a
 * `working`. Resultado: `hub_agent_wait`/`hub wait` liam "precisa de
 * instrução" enquanto o substituto trabalhava, e a task ficava parada em
 * `input_required` mesmo depois de ele concluir (achado pelo smoke do MCP,
 * item 8.3 / R08-12 da vistoria 2026-09-25).
 */

// `lento` dorme 30 s; `rapido` responde na hora.
const SCRIPT = `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdout.write('AGENTE ' + process.env.FAKE_ID + ' NO AR\\n');
setTimeout(() => { process.stdout.write('FIM ' + process.env.FAKE_ID + '\\n'); process.exit(0); }, Number(process.env.FAKE_MS));
`;

function manifesto(id: string, script: string, ms: number): string {
  const esc = script.replace(/\\/g, '\\\\');
  return `
id: ${id}
name: ${id}
bin: node
invoke:
  oneShot: ["${esc}"]
  interactive: false
  env:
    FAKE_ID: "${id}"
    FAKE_MS: "${ms}"
detect:
  args: ["${esc}", "--version"]
capabilities: [teste-handoff]
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 60
`;
}

async function esperar(cond: () => boolean, oque: string, timeoutMs = 15_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > limite) throw new Error(`${oque}: não aconteceu em ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('handoff de sessão pausada', () => {
  let raiz: string;
  let hub: Hub;
  let projectId: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-pausada-'));
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projeto, { recursive: true });
    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(script, SCRIPT, 'utf8');
    writeFileSync(path.join(manifestos, 'lento.yaml'), manifesto('lento', script, 30_000), 'utf8');
    writeFileSync(path.join(manifestos, 'rapido.yaml'), manifesto('rapido', script, 100), 'utf8');
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: { ...DEFAULT_POLICY, watch: { pauseOn: [], flagOn: [] } },
    });
    projectId = hub.sessions.registerProject(projeto, 'handoff-pausada').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('pausada → handoff: a task volta a working e conclui com o novo agente', async () => {
    const { session, task } = await hub.sessions.start({
      projectId,
      agentId: 'lento',
      brief: {
        agent: 'lento',
        objective: 'trabalho longo que será transferido',
        isolation: 'none',
        supervision: 'semi',
      },
    });
    await esperar(
      () => hub.sessions.listEvents(session.id).some((e) => e.type === 'message'),
      'lento falou',
    );
    await hub.sessions.pause(session.id);
    await esperar(() => hub.store.tasks.get(task.id)?.state === 'input_required', 'task input_required');

    await hub.sessions.handoff(session.id, 'rapido', 'teste');
    assert.equal(hub.store.tasks.get(task.id)?.state, 'working', 'o substituto está trabalhando');

    await esperar(
      () => ['completed', 'failed', 'canceled'].includes(hub.store.tasks.get(task.id)?.state ?? ''),
      'task terminal',
    );
    assert.equal(hub.store.tasks.get(task.id)?.state, 'completed');
    assert.equal(hub.store.sessions.get(session.id)?.agentId, 'rapido');
  });
});
