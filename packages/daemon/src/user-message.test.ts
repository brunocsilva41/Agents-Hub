import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, newId, nowIso, type Session, type Task } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * A mensagem que o usuário manda para a sessão precisa virar evento.
 *
 * Sem isto a timeline tinha um lado só: o painel mostrava a resposta do agente
 * e nunca o pedido. E, retomando uma sessão pausada por mensagem, o `#launch`
 * troca o estado para `running` sem evento nenhum — o painel ficava "PAUSADA"
 * enquanto a sessão rodava. `user.message` é o sinal que faltava.
 */
const SCRIPT_AGENTE = `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdout.write('AGENTE OK\\n');
process.exit(0);
`;

describe('send registra a fala do usuário', () => {
  let raiz: string;
  let hub: Hub;
  let projetoPath: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-user-msg-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'agente.cjs');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    writeFileSync(script, SCRIPT_AGENTE, 'utf8');
    const escapado = script.replace(/\\/g, '\\\\');
    writeFileSync(
      path.join(manifestos, 'agente-u.yaml'),
      `
id: agente-u
name: agente-u
vendor: Test
description: Agente de teste
bin: node
invoke:
  oneShot: ["${escapado}"]
  interactive: false
detect:
  args: ["${escapado}", "--version"]
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
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: { ...DEFAULT_POLICY, watch: { pauseOn: [], flagOn: [] } },
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

  test('mensagem para sessão pausada vira evento user.message ANTES do turno novo', async () => {
    const projeto = hub.sessions.registerProject(projetoPath, 'projeto-user-msg');
    const id = newId('ses');
    const session: Session = {
      id,
      projectId: projeto.id,
      agentId: 'agente-u',
      parentId: null,
      rootId: id,
      depth: 0,
      state: 'paused',
      mode: 'semi',
      isolation: 'none',
      workdir: projetoPath,
      nativeSessionId: null,
      path: [`agente-u:${id}`],
      title: 'sessão pausada',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);
    const task: Task = {
      id: newId('tsk'),
      sessionId: id,
      requesterSessionId: null,
      brief: {
        agent: 'agente-u',
        objective: 'tarefa de teste',
        acceptanceCriteria: [],
        constraints: [],
        artifacts: [],
        contextRefs: [],
        upstream: [],
        budget: {},
        isolation: 'none',
        mode: 'async',
        supervision: 'semi',
        labels: {},
      },
      state: 'working',
      attempts: [],
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    hub.store.tasks.create(task);

    const recebidos: string[] = [];
    const desinscrever = hub.bus.subscribe({ sessionId: id }, (e) => recebidos.push(e.type));

    try {
      await hub.sessions.send(id, 'retome daqui, por favor');

      const fala = hub.sessions.listEvents(id).find((e) => e.type === 'user.message');
      assert.ok(fala, 'send precisa registrar a fala do usuário na timeline');
      assert.equal(fala.payload['text'], 'retome daqui, por favor');
      assert.equal(recebidos[0], 'user.message', 'o evento sai ao vivo, antes do turno novo');
      // Retomar trocou o estado: é exatamente o que o evento avisa ao painel.
      assert.notEqual(hub.store.sessions.get(id)?.state, 'paused');
    } finally {
      // Deixa o turno fake terminar antes do shutdown.
      const limite = Date.now() + 15_000;
      while (hub.sessions.isLive(id) && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 50));
      }
      desinscrever();
    }
  });
});
