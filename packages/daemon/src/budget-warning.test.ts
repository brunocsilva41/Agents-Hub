import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, type EventEnvelope } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Projeção viva e emissor de `budget.warning` (Fase 3).
 *
 * Antes desta correção, `SessionManager.budget()` só calculava projeção
 * quando `consumed.seconds > 0` — e essa dimensão só é alimentada por
 * `ledger.settle()`, chamado DEPOIS que a run termina. Ou seja: a projeção
 * nunca aparecia enquanto a sessão estava viva, que é justamente quando
 * alguém estaria olhando. E `budget.warning` nunca foi emitido nenhuma vez
 * em lugar nenhum do código, apesar de já existir no vocabulário de eventos.
 */
describe('projeção viva e budget.warning (Fase 3)', () => {
  let raiz: string;
  let hub: Hub;
  let projetoPath: string;

  function escreverManifest(
    manifestos: string,
    id: string,
    scriptPath: string,
    mapper: 'generic-text' | 'claude',
  ): void {
    writeFileSync(
      path.join(manifestos, `${id}.yaml`),
      `
id: ${id}
name: ${id}
vendor: Test
description: Agente de teste para orçamento
bin: node
invoke:
  oneShot: ["${scriptPath.replace(/\\/g, '\\\\')}"]
  stdinPrompt: true
  interactive: false
detect:
  args: ["${scriptPath.replace(/\\/g, '\\\\')}", "--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: ${mapper === 'claude' ? 'jsonl' : 'text'}
  mapper: ${mapper}
defaults:
  isolation: none
  timeoutSeconds: 30
`,
      'utf8',
    );
  }

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-budget-warning-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });

    // --- agente-vivo: fica um tempinho rodando antes de terminar, para dar
    // janela de testar `budget()` com a sessão ainda viva.
    const scriptVivo = path.join(raiz, 'agente-vivo.cjs');
    writeFileSync(
      scriptVivo,
      `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.stdin.resume();
// Simula trabalho em andamento: a sessão precisa estar viva quando o teste lê o orçamento.
setTimeout(() => { process.stdout.write('OK\\n'); process.exit(0); }, 200);
`,
      'utf8',
    );
    escreverManifest(manifestos, 'agente-vivo', scriptVivo, 'generic-text');

    // --- agente-custo-unico: um único processo, DUAS cobranças no mesmo
    // turno — a primeira já cruza 80%, a segunda continua acima sem esgotar.
    const scriptUnico = path.join(raiz, 'agente-custo-unico.cjs');
    writeFileSync(
      scriptUnico,
      `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.85, usage: { input_tokens: 100, output_tokens: 50 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.05, usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
  process.exit(0);
});
`,
      'utf8',
    );
    escreverManifest(manifestos, 'agente-custo-unico', scriptUnico, 'claude');

    // --- agente-custo-duplo: estoura na 1ª invocação, e depois de aprovado o
    // aumento de teto, cruza 80% de novo na 2ª — provando que `raiseLimits()`
    // rearma o alerta.
    const scriptDuplo = path.join(raiz, 'agente-custo-duplo.cjs');
    const contadorFile = path.join(raiz, 'agente-custo-duplo.contador');
    writeFileSync(contadorFile, '0', 'utf8');
    writeFileSync(
      scriptDuplo,
      `
const fs = require('fs');
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const contadorFile = ${JSON.stringify(contadorFile)};
  const invocacao = Number(fs.readFileSync(contadorFile, 'utf8')) + 1;
  fs.writeFileSync(contadorFile, String(invocacao), 'utf8');

  // 1ª invocação: estoura o teto de 1M tokens NO MEIO do turno (estimativa
  // da linha "assistant", com o processo ainda vivo): o Hub corta o agente, e
  // aprovar o aumento RETOMA o trabalho. Estouro na linha de custo final (turno
  // já concluído) não relança mais nada ao aprovar — ver
  // orquestracao.integration.test.ts.
  // 2ª invocação (depois da aprovação dobrar o teto para 2M tokens): soma
  // mais 150k ao já consumido (1,5M), cruzando 80% de novo (1,65M de 2M) sem
  // esgotar.
  if (invocacao === 1) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'trabalhando' }], usage: { input_tokens: 1500000, output_tokens: 0 } } }) + '\\n');
    // Simula o agente ainda trabalhando: quem o encerra é o corte do Hub no estouro.
    setTimeout(() => process.exit(0), 10000);
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.2, usage: { input_tokens: 150000, output_tokens: 0 } }) + '\\n');
  process.exit(0);
});
`,
      'utf8',
    );
    escreverManifest(manifestos, 'agente-custo-duplo', scriptDuplo, 'claude');

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: {
        ...DEFAULT_POLICY,
        watch: { pauseOn: [], flagOn: [] },
        defaultBudget: { usd: 1, tokens: 1_000_000, seconds: 100_000 },
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

  test('projeção aparece com a sessão ainda viva (não precisa esperar o fim da run)', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Teste Projeção Viva');
    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId: 'agente-vivo',
      brief: {
        agent: 'agente-vivo',
        objective: 'Trabalhar por um tempo',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });

    // A run ainda está viva (o script só termina depois de 200ms): antes da
    // correção, `budget()` devolvia `projection: undefined` aqui, porque
    // `consumed.seconds` só é alimentado quando a run termina.
    const budget = hub.sessions.budget(started.session.rootId);
    assert.ok(budget.projection, 'a projeção deveria existir com a sessão ainda viva');
    assert.equal(typeof budget.projection?.burnRateUsdPerSec, 'number');
  });

  test('budget.warning dispara uma única vez ao cruzar 80%, mesmo com vários eventos de custo', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Teste Warning Único');
    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId: 'agente-custo-unico',
      brief: {
        agent: 'agente-custo-unico',
        objective: 'Gastar orçamento',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });

    const terminais = new Set(['completed', 'failed', 'canceled', 'rejected']);
    await esperarAte(() => {
      const task = hub.store.tasks.get(started.task.id);
      return !!task && terminais.has(task.state);
    }, 'task terminal');

    const eventos: EventEnvelope[] = hub.sessions.listEvents(started.session.id);
    const avisos = eventos.filter((e) => e.type === 'budget.warning');
    const estourados = eventos.filter((e) => e.type === 'budget.exceeded');

    assert.equal(avisos.length, 1, 'budget.warning deveria disparar exatamente uma vez');
    assert.equal(estourados.length, 0, 'não deveria ter estourado o orçamento (0,90 < 1,00)');

    const snapshot = avisos[0]?.payload['snapshot'] as { pressure: number; exhausted: boolean };
    assert.ok(snapshot.pressure >= 0.8);
    assert.equal(snapshot.exhausted, false);
  });

  test('budget.warning volta a poder disparar depois de raiseLimits (aprovação de aumento)', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Teste Warning Reaparece');
    const started = await hub.sessions.start({
      projectId: proj.id,
      agentId: 'agente-custo-duplo',
      brief: {
        agent: 'agente-custo-duplo',
        objective: 'Estourar e depois se recuperar',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });

    // 1ª rodada: estoura o orçamento e fica esperando aprovação. Espera também
    // a run parar de ser "viva": a aprovação some do banco assim que o evento
    // de custo é processado, mas o processo do agente só sai de `#runs`
    // depois que `handle.done` resolve — resolver a aprovação antes disso
    // colide com uma run que `send()` ainda considera em andamento.
    await esperarAte(
      () =>
        hub.sessions.pendingApprovals(started.session.id).length > 0 &&
        !hub.sessions.isLive(started.session.id),
      'aprovação de orçamento pendente e run encerrada',
    );
    const [approval] = hub.sessions.pendingApprovals(started.session.id);
    assert.ok(approval, 'deveria existir uma aprovação de orçamento pendente');

    await hub.sessions.resolveApproval(approval.id, 'approved');

    // 2ª rodada: dispara depois da aprovação reabrir a sessão. `send()` (o
    // caminho de retomada usado aqui, fora do laço de retry) relança a MESMA
    // task sem empilhar uma nova tentativa em `attempts` — por isso o sinal de
    // "a segunda rodada terminou" é a task voltar a um estado terminal depois
    // de ter sido reaberta para `working` pela aprovação.
    const terminais = new Set(['completed', 'failed', 'canceled', 'rejected']);
    await esperarAte(() => {
      const task = hub.store.tasks.get(started.task.id);
      return !!task && terminais.has(task.state);
    }, 'segunda rodada terminal');

    const eventos: EventEnvelope[] = hub.sessions.listEvents(started.session.id);
    const avisos = eventos.filter((e) => e.type === 'budget.warning');
    const estourados = eventos.filter((e) => e.type === 'budget.exceeded');

    assert.equal(estourados.length, 1, 'o estouro da 1ª rodada deveria ter sido registrado uma vez');
    assert.equal(
      avisos.length,
      1,
      'o aviso da 2ª rodada deveria disparar de novo, porque raiseLimits rearmou o alerta',
    );
  });
});
