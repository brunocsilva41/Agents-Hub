import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HubError } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Integração do gate pré-execução do Codex de ponta a ponta: da config global
 * (`codexGate.bypassHookTrust`) até os argumentos que realmente chegam no
 * processo spawnado.
 *
 * `codex-gate.test.ts` já cobre `montarConfigDoGate`/`modoExigeGate` como
 * funções puras — mas até este teste nada exercitava se o resultado delas
 * chegava ao `spawn()` de verdade. Era exatamente esse fio que faltava: as
 * duas pontas existiam, testadas separadamente, e nada as unia.
 */

const CODEX_FALSO = `
const fs = require('node:fs');
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9\\n');
  process.exit(0);
}
process.stdout.write('FAKE_OK\\n');
process.exit(0);
`;

interface Ambiente {
  hub: Hub;
  raiz: string;
  projectId: string;
  argsFile: string;
}

function montarAmbiente(): Ambiente {
  const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-codex-gate-'));
  const manifestos = path.join(raiz, 'manifests');
  const projeto = path.join(raiz, 'projeto');
  const script = path.join(raiz, 'codex-falso.cjs');
  const argsFile = path.join(raiz, 'args.json');

  for (const dir of [manifestos, projeto]) mkdirSync(dir, { recursive: true });
  writeFileSync(script, CODEX_FALSO, 'utf8');

  const scriptEsc = script.replaceAll('\\', '\\\\');
  writeFileSync(
    path.join(manifestos, 'codex.yaml'),
    [
      'id: codex',
      'name: Codex Falso',
      'bin: node',
      'detect:',
      `  args: ["${scriptEsc}", "--version"]`,
      'invoke:',
      `  oneShot: ["${scriptEsc}"]`,
      '  stdinPrompt: true',
      '  env:',
      `    ARGS_FILE: "${argsFile.replaceAll('\\', '\\\\')}"`,
      'session:',
      '  strategy: replay',
      'stream:',
      '  format: text',
      '  mapper: generic-text',
      'capabilities: [tarefa-falsa]',
      'defaults:',
      '  isolation: none',
      '  timeoutSeconds: 30',
      '  supervision: autonomous',
      '',
    ].join('\n'),
    'utf8',
  );

  const hub = createHub({
    home: raiz,
    manifestsDir: manifestos,
    webRoot: path.join(raiz, 'sem-web'),
  });
  const projectId = hub.sessions.registerProject(projeto, 'projeto-codex-gate').id;

  return { hub, raiz, projectId, argsFile };
}

async function esperarTerminal(hub: Hub, taskId: string, timeoutMs = 5000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  const terminais = new Set(['completed', 'failed', 'canceled', 'rejected']);
  for (;;) {
    const task = hub.store.tasks.get(taskId);
    if (task && terminais.has(task.state)) return;
    if (Date.now() > limite) throw new Error(`task ${taskId} não chegou a estado terminal em ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function esperarArquivo(file: string, timeoutMs = 5000): Promise<string[]> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as string[];
      } catch {
        // Escrita em andamento — tenta de novo.
      }
    }
    if (Date.now() > limite) throw new Error(`${file} não apareceu em ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('gate pré-execução do Codex — fim a fim', () => {
  let ambiente: Ambiente;

  before(() => {
    ambiente = montarAmbiente();
  });

  after(async () => {
    await ambiente.hub.shutdown();
    try {
      rmSync(ambiente.raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('modo supervised sem bypass de confiança é RECUSADO antes de qualquer processo subir', async () => {
    try {
      rmSync(ambiente.argsFile, { force: true });
    } catch {
      /* pode não existir ainda */
    }

    await assert.rejects(
      () =>
        ambiente.hub.sessions.start({
          projectId: ambiente.projectId,
          agentId: 'codex',
          brief: {
            agent: 'codex',
            objective: 'sessão supervised sem bypass configurado',
            supervision: 'supervised',
            isolation: 'none',
          },
        }),
      (erro: unknown) => {
        assert.ok(erro instanceof HubError);
        assert.equal(erro.code, 'CODEX_GATE_NOT_GUARANTEED');
        return true;
      },
    );

    // A recusa é ANTES do spawn: nenhum processo chegou a escrever o arquivo.
    assert.equal(existsSync(ambiente.argsFile), false);
  });

  test('modo semi sem bypass roda sem o bypass de confiança, e avisa na timeline', async () => {
    const { session, task } = await ambiente.hub.sessions.start({
      projectId: ambiente.projectId,
      agentId: 'codex',
      brief: {
        agent: 'codex',
        objective: 'sessão semi sem bypass configurado',
        supervision: 'semi',
        isolation: 'none',
      },
    });

    const argv = await esperarArquivo(ambiente.argsFile);
    const configIdx = argv.indexOf('-c');
    assert.notEqual(configIdx, -1, 'esperava "-c hooks=..." nos argumentos');
    const hooksArg = argv[configIdx + 1] ?? '';
    assert.match(hooksArg, /^hooks=\{PreToolUse=/);
    // O comando embutido no TOML é o próprio bridge do hook, no dialeto certo.
    assert.match(hooksArg, /hook --dialect codex/);
    assert.equal(
      argv.includes('--dangerously-bypass-hook-trust'),
      false,
      'sem bypass ligado, a flag NÃO pode aparecer',
    );

    const eventos = ambiente.hub.sessions.listEvents(session.id);
    const aviso = eventos.find(
      (e) => e.type === 'log' && (e.payload as { stream?: string }).stream === 'gate',
    );
    assert.ok(aviso, 'esperava um log de aviso explicando que o gate não está garantido');
    assert.match(String((aviso!.payload as { text?: string }).text), /ignorado em silêncio/i);

    await esperarTerminal(ambiente.hub, task.id);
  });

  test('com bypass ligado, sessão supervised roda com --dangerously-bypass-hook-trust e sem aviso', async () => {
    // Mutação direta: o SessionManager lê `config.codexGate` a cada lançamento,
    // não numa cópia — então isto tem efeito imediato na próxima sessão.
    ambiente.hub.config.codexGate.bypassHookTrust = true;
    try {
      rmSync(ambiente.argsFile, { force: true });
    } catch {
      /* ok */
    }

    const { session, task } = await ambiente.hub.sessions.start({
      projectId: ambiente.projectId,
      agentId: 'codex',
      brief: {
        agent: 'codex',
        objective: 'sessão supervised com bypass ligado',
        supervision: 'supervised',
        isolation: 'none',
      },
    });

    const argv = await esperarArquivo(ambiente.argsFile);
    assert.ok(argv.includes('--dangerously-bypass-hook-trust'));

    const eventos = ambiente.hub.sessions.listEvents(session.id);
    const aviso = eventos.find(
      (e) => e.type === 'log' && (e.payload as { stream?: string }).stream === 'gate',
    );
    assert.equal(aviso, undefined, 'com o gate garantido não deveria haver aviso');

    await esperarTerminal(ambiente.hub, task.id);
  });
});
