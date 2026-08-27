import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Integração do pipeline de resiliência com agentes FALSOS.
 *
 * Testar retry e fallback contra agentes de verdade seria caro, lento e
 * dependente de rede — três motivos para o teste nunca rodar. Os agentes falsos
 * aqui são scripts Node que falham ou funcionam sob comando, o que deixa o
 * comportamento determinístico e o custo em zero.
 */

const AGENTE_FALSO = `
const fs = require('node:fs');

// Conta as execuções em disco: o processo morre entre as tentativas, então
// contador em memória não sobreviveria para simular "falha nas N primeiras".
const arquivo = process.env.FAKE_COUNTER;
const falharAte = Number(process.env.FAKE_FAIL_UNTIL || 0);

let n = 0;
try { n = Number(fs.readFileSync(arquivo, 'utf8')) || 0; } catch {}
n += 1;
fs.writeFileSync(arquivo, String(n));

if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9\\n');
  process.exit(0);
}

if (n <= falharAte) {
  process.stderr.write('API error 429: rate limit exceeded\\n');
  process.exit(1);
}

process.stdout.write('FAKE_OK da tentativa ' + n + '\\n');
process.exit(0);
`;

interface Ambiente {
  hub: Hub;
  raiz: string;
  projeto: string;
  contadorFlaky: string;
  contadorBackup: string;
}

function montarAmbiente(overrides: { maxRetries: number }): Ambiente {
  const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-resiliencia-'));
  const manifestos = path.join(raiz, 'manifests');
  const projeto = path.join(raiz, 'projeto');
  const script = path.join(raiz, 'agente-falso.cjs');
  const contadorFlaky = path.join(raiz, 'flaky.count');
  const contadorBackup = path.join(raiz, 'backup.count');

  for (const dir of [manifestos, projeto]) mkdirSync(dir, { recursive: true });

  writeFileSync(script, AGENTE_FALSO, 'utf8');

  const manifesto = (id: string, contador: string, falharAte: number): string =>
    [
      `id: ${id}`,
      `name: Agente falso ${id}`,
      'bin: node',
      'detect:',
      `  args: ["${script.replaceAll('\\', '\\\\')}", "--version"]`,
      'invoke:',
      `  oneShot: ["${script.replaceAll('\\', '\\\\')}"]`,
      '  stdinPrompt: true',
      '  env:',
      `    FAKE_COUNTER: "${contador.replaceAll('\\', '\\\\')}"`,
      `    FAKE_FAIL_UNTIL: "${falharAte}"`,
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
    ].join('\n');

  // `flaky` falha sempre; `backup` funciona de primeira. É a combinação que
  // força o pipeline a esgotar o retry e trocar de agente.
  writeFileSync(path.join(manifestos, 'flaky.yaml'), manifesto('flaky', contadorFlaky, 99), 'utf8');
  writeFileSync(path.join(manifestos, 'backup.yaml'), manifesto('backup', contadorBackup, 0), 'utf8');

  const hub = createHub({
    home: raiz,
    manifestsDir: manifestos,
    webRoot: path.join(raiz, 'sem-web'),
    policy: {
      ...DEFAULT_POLICY,
      retries: { max: overrides.maxRetries, backoffMs: 10 },
      fallback: { 'tarefa-falsa': ['flaky', 'backup'] },
      // Sem vigilância nem validação: este teste é sobre retry e fallback.
      watch: { pauseOn: [], flagOn: [] },
    },
  });

  return { hub, raiz, projeto, contadorFlaky, contadorBackup };
}

async function esperarTerminal(hub: Hub, taskId: string, timeoutMs = 30_000): Promise<string> {
  const limite = Date.now() + timeoutMs;
  const terminais = new Set(['completed', 'failed', 'canceled', 'rejected']);

  for (;;) {
    const task = hub.store.tasks.get(taskId);
    if (task && terminais.has(task.state)) return task.state;
    if (Date.now() > limite) {
      throw new Error(`task ${taskId} não chegou a estado terminal em ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('pipeline de resiliência', () => {
  let ambiente: Ambiente;

  before(() => {
    ambiente = montarAmbiente({ maxRetries: 1 });
  });

  after(async () => {
    await ambiente.hub.shutdown();
    try {
      rmSync(ambiente.raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('agente que falha sempre esgota o retry e passa a tarefa adiante', async () => {
    const projeto = ambiente.hub.sessions.registerProject(ambiente.projeto, 'projeto-falso');

    const { task } = await ambiente.hub.sessions.start({
      projectId: projeto.id,
      agentId: '',
      brief: {
        agent: 'flaky',
        objective: 'uma tarefa qualquer para exercitar o pipeline',
        isolation: 'none',
      },
    });

    const estadoFinal = await esperarTerminal(ambiente.hub, task.id);
    const finalizada = ambiente.hub.store.tasks.get(task.id);
    assert.ok(finalizada);

    assert.equal(estadoFinal, 'completed', 'o agente de fallback deveria ter concluído');

    const agentes = finalizada.attempts.map((a) => a.agentId);
    assert.deepEqual(
      agentes,
      ['flaky', 'flaky', 'backup'],
      'esperado: tentativa, retry no mesmo agente, e então a troca',
    );

    assert.equal(finalizada.attempts[0]?.outcome, 'error');
    assert.equal(finalizada.attempts[1]?.outcome, 'error');
    assert.equal(finalizada.attempts[2]?.outcome, 'success');

    // A task foi MOVIDA para a sessão do substituto: é a mesma tarefa,
    // executada por outro agente.
    const sessaoFinal = ambiente.hub.store.sessions.get(finalizada.sessionId);
    assert.equal(sessaoFinal?.agentId, 'backup');
  });

  test('o substituto entra como irmão no grafo, não como filho', async () => {
    const projeto = ambiente.hub.sessions.registerProject(ambiente.projeto, 'projeto-falso');
    const sessoes = ambiente.hub.store.sessions.list({ projectId: projeto.id });

    const doFlaky = sessoes.find((s) => s.agentId === 'flaky');
    const doBackup = sessoes.find((s) => s.agentId === 'backup');

    assert.ok(doFlaky && doBackup, 'as duas sessões precisam existir para a troca ser auditável');
    assert.equal(doBackup.parentId, doFlaky.parentId, 'mesmo pai');
    assert.equal(doBackup.depth, doFlaky.depth, 'mesmo nível de profundidade');
    assert.equal(doBackup.rootId, doFlaky.rootId, 'mesmo fluxo, logo mesmo orçamento');
  });

  test('o histórico de falhas fica preservado para auditoria', async () => {
    const tasks = ambiente.hub.store.tasks.list();
    const task = tasks[0];
    assert.ok(task);

    const comErro = task.attempts.filter((a) => a.outcome === 'error');
    assert.ok(comErro.length >= 2);
    for (const tentativa of comErro) {
      assert.match(String(tentativa.error), /429|rate limit|código 1/i);
    }
  });
});
