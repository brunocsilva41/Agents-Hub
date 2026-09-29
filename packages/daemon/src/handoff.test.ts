import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

const SCRIPT_AGENTE = `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.stdout.write('AGENTE OK\\n');
process.exit(0);
`;

async function esperarTerminal(hub: Hub, taskId: string): Promise<string> {
  const terminais = new Set(['completed', 'failed', 'canceled', 'rejected']);
  return esperarAte(() => {
    const estado = hub.store.tasks.get(taskId)?.state;
    return estado && terminais.has(estado) ? estado : undefined;
  }, `task ${taskId} terminal`);
}

describe('Session Handoff (Fase 3)', () => {
  let raiz: string;
  let hub: Hub;
  let projetoPath: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'agente.cjs');

    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    writeFileSync(script, SCRIPT_AGENTE, 'utf8');

    for (const id of ['agente-a', 'agente-b']) {
      writeFileSync(
        path.join(manifestos, `${id}.yaml`),
        `
id: ${id}
name: ${id}
vendor: Test
description: Agente de teste para handoff
bin: node
invoke:
  oneShot: ["${script.replace(/\\/g, '\\\\')}"]
  interactive: false
detect:
  args: ["${script.replace(/\\/g, '\\\\')}", "--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 30
`,
        'utf8',
      );
    }

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: {
        ...DEFAULT_POLICY,
        watch: { pauseOn: [], flagOn: [] },
      },
    });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      // limpeza de diretório temporário: se falhar, o SO recolhe depois
    }
  });

  test('transfere o controle da sessão para outro agente e emite evento session.handoff', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Teste Handoff');

    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId: 'agente-a',
      brief: {
        agent: 'agente-a',
        objective: 'Construir funcionalidade',
        acceptanceCriteria: ['Critério 1'],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });

    const sessionId = started.session.id;
    assert.equal(started.session.agentId, 'agente-a');

    // Executa o handoff para o agente-b
    const handoffResult = await hub.sessions.handoff(
      sessionId,
      'agente-b',
      'transferindo para especialista em revisão',
    );

    assert.equal(handoffResult.id, sessionId);
    assert.equal(handoffResult.agentId, 'agente-b');

    // Aguarda o pipeline terminar a execução da task completamente
    await esperarTerminal(hub, started.task.id);

    // Verifica que o evento session.handoff foi registrado
    const events = hub.sessions.listEvents(sessionId);
    const handoffEvent = events.find((e) => e.type === 'session.handoff');
    assert.ok(handoffEvent, 'o evento session.handoff deve ser emitido');
    assert.equal(handoffEvent?.payload['fromAgentId'], 'agente-a');
    assert.equal(handoffEvent?.payload['toAgentId'], 'agente-b');
  });
});
