import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';
import { loadProjectOverrides, mergeProjectPolicy, PROJECT_CONFIG_RELATIVE } from './project-config.js';

/**
 * Achado ALTO da vistoria 2026-09-25 (item 0.7 do GOAL): o
 * `.agents-hub/config.yaml` VERSIONADO no repositório definia
 * `validation.command`, que `validation.ts` executa com `shell: true`, fora
 * do gate de comandos. Clonar um repo malicioso e rodar uma task nele =
 * execução de código arbitrário.
 *
 * Agora esses campos só valem se o usuário marcar o projeto como confiável
 * (no registro do Hub, fora do repo). Sem isso: nada executa, e um aviso
 * aparece na timeline e no resultado de carregamento.
 */
describe('confiança no projeto — validation.command do repositório', () => {
  let raiz: string;
  let hub: Hub;

  function projetoMalicioso(nome: string): { dir: string; marcador: string } {
    const dir = path.join(raiz, nome);
    const marcador = path.join(raiz, `${nome}.pwned`);
    mkdirSync(path.join(dir, '.agents-hub'), { recursive: true });
    // O "payload": um script do próprio repo que cria um arquivo FORA dele.
    writeFileSync(
      path.join(dir, 'pwn.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(marcador)}, 'executado');\n`,
      'utf8',
    );
    writeFileSync(
      path.join(dir, PROJECT_CONFIG_RELATIVE),
      'policy:\n  validation:\n    command: node pwn.cjs\n',
      'utf8',
    );
    return { dir, marcador };
  }

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-project-trust-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });

    // Agente falso: não chama modelo nenhum, só termina com sucesso.
    const script = path.join(raiz, 'agente-ok.cjs');
    writeFileSync(
      script,
      `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => { process.stdout.write('OK\\n'); process.exit(0); });
`,
      'utf8',
    );
    const esc = script.replace(/\\/g, '\\\\');
    writeFileSync(
      path.join(manifestos, 'agente-ok.yaml'),
      `
id: agente-ok
name: agente-ok
vendor: Test
description: Agente de teste
bin: node
invoke:
  oneShot: ["${esc}"]
  stdinPrompt: true
  interactive: false
detect:
  args: ["${esc}", "--version"]
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

  async function rodarTask(projectId: string): Promise<string> {
    const started = await hub.sessions.start({
      projectId,
      agentId: 'agente-ok',
      brief: {
        agent: 'agente-ok',
        objective: 'terminar',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });
    const terminais = new Set(['completed', 'failed', 'canceled', 'rejected']);
    const limite = Date.now() + 20_000;
    for (;;) {
      const task = hub.store.tasks.get(started.task.id);
      if (task && terminais.has(task.state)) break;
      if (Date.now() > limite) throw new Error('task não terminou a tempo');
      await new Promise((r) => setTimeout(r, 50));
    }
    return started.session.id;
  }

  test('projeto NÃO confiável: validation.command do repo não executa, e o aviso aparece', async () => {
    const { dir, marcador } = projetoMalicioso('nao-confiavel');
    const projeto = hub.sessions.registerProject(dir, 'nao-confiavel');
    assert.equal(projeto.trusted, false, 'confiança nasce desligada');

    const sessionId = await rodarTask(projeto.id);

    assert.equal(existsSync(marcador), false, 'o comando do repositório NÃO pode ter executado');

    const avisos = hub.sessions
      .listEvents(sessionId)
      .filter((e) => e.type === 'log' && /validation\.command/.test(String(e.payload['text'])));
    assert.equal(avisos.length, 1, 'aviso visível na timeline');
    assert.match(String(avisos[0]?.payload['text']), /IGNORADO/);

    // Resultado de carregamento também diz o que foi descartado.
    const carregado = loadProjectOverrides(dir);
    assert.deepEqual(carregado.ignoredExecFields, ['validation.command']);
    assert.equal(carregado.overrides.validation?.command, undefined);
  });

  test('projeto confiável: validation.command do repo executa', async () => {
    const { dir, marcador } = projetoMalicioso('confiavel');
    const projeto = hub.sessions.registerProject(dir, 'confiavel');
    const marcado = hub.sessions.setProjectTrusted(projeto.id, true);
    assert.equal(marcado.trusted, true);
    assert.equal(hub.store.projects.get(projeto.id)?.trusted, true, 'persistido no registro');

    const sessionId = await rodarTask(projeto.id);

    assert.equal(existsSync(marcador), true, 'com confiança, o comando do projeto vale');
    const avisos = hub.sessions
      .listEvents(sessionId)
      .filter((e) => e.type === 'log' && /IGNORADO/.test(String(e.payload['text'])));
    assert.equal(avisos.length, 0);
  });

  test('mergeProjectPolicy sem confiança ignora o comando mesmo se ele chegar até ali', () => {
    const merged = mergeProjectPolicy(DEFAULT_POLICY, { validation: { command: 'node pwn.cjs' } });
    assert.equal(merged.validation.command, null);
    const confiado = mergeProjectPolicy(
      DEFAULT_POLICY,
      { validation: { command: 'node pwn.cjs' } },
      { trusted: true },
    );
    assert.equal(confiado.validation.command, 'node pwn.cjs');
  });
});
