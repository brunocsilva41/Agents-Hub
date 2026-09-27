import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, textoDe, type EventEnvelope } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/** Porta livre reservada antes do Hub: a guarda de borda compara o `Host` com ela. */
function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const endereco = srv.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      srv.close(() => resolve(porta));
    });
  });
}

/**
 * Agente "ruidoso": 12.000 linhas de 1 KB (12 MB) de uma vez, depois UMA
 * linha de 24 MB sem quebra (acima do teto de linha). No modo `claude`, um `tool_result` de 5 MB.
 */
const SCRIPT = `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
const modo = process.argv[2];
function escrever(texto) {
  return new Promise((resolve) => { if (process.stdout.write(texto)) resolve(); else process.stdout.once('drain', resolve); });
}
(async () => {
  if (modo === 'rajada') {
    const linha = 'y'.repeat(1023) + '\\n';
    let bloco = '';
    for (let i = 0; i < 12000; i += 1) {
      bloco += linha;
      if (bloco.length > 256 * 1024) { await escrever(bloco); bloco = ''; }
    }
    await escrever(bloco);
    await escrever('z'.repeat(24 * 1024 * 1024) + '\\n');
  } else {
    const conteudo = 'c'.repeat(5 * 1024 * 1024);
    await escrever(JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: conteudo },
    ] } }) + '\\n');
  }
  await escrever('fim\\n');
  process.exit(0);
})();
`;

/**
 * Rajada de saída (vistoria 2026-09-25, item 2.5): 20 MB de saída deixaram
 * `GET /health` 17 s sem resposta, uma linha de 60 MB gerou uma resposta de
 * `GET /sessions/:id/events` de 125 MB, e `raw` guardava 5 MB por
 * `tool_result`. Borda HTTP real, agente real (processo `node`).
 */
describe('HTTP sob rajada de saída do agente', () => {
  let raiz: string;
  let hub: Hub;
  let baseUrl: string;
  let projectId: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-flood-'));
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'ruidoso.cjs');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projeto, { recursive: true });
    writeFileSync(script, SCRIPT, 'utf8');
    const s = script.replace(/\\/g, '\\\\');
    for (const [id, modo, formato, mapper] of [
      ['ruidoso', 'rajada', 'text', 'generic-text'],
      ['claude-falso', 'tool', 'jsonl', 'claude'],
    ] as const) {
      writeFileSync(
        path.join(manifestos, `${id}.yaml`),
        `
id: ${id}
name: ${id}
vendor: Test
description: Agente de teste de rajada
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
  format: ${formato}
  mapper: ${mapper}
defaults:
  isolation: none
  timeoutSeconds: 300
`,
        'utf8',
      );
    }

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: await portaLivre(),
      policy: {
        ...DEFAULT_POLICY,
        watch: { pauseOn: [], flagOn: [] },
        retries: { max: 0, backoffMs: 0 },
        heartbeatTimeoutSeconds: 300,
      },
    });
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;
    projectId = hub.sessions.registerProject(projeto, 'projeto-rajada').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  async function iniciar(agentId: string): Promise<{ sessionId: string; taskId: string }> {
    const r = await hub.sessions.start({
      projectId,
      agentId,
      brief: {
        agent: agentId,
        objective: 'Imprimir muita saída de uma vez',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'autonomous',
      },
    });
    return { sessionId: r.session.id, taskId: r.task.id };
  }

  function terminou(taskId: string): boolean {
    const t = hub.store.tasks.get(taskId);
    return t !== null && ['completed', 'failed', 'canceled', 'rejected'].includes(t.state);
  }

  test(
    'GET /health responde em menos de 500 ms durante a rajada, e a página de eventos tem teto de bytes',
    { timeout: 240_000 },
    async () => {
      const { sessionId, taskId } = await iniciar('ruidoso');

      let pior = 0;
      let medidas = 0;
      const limite = Date.now() + 200_000;
      while (!terminou(taskId) && Date.now() < limite) {
        const inicio = performance.now();
        const res = await fetch(`${baseUrl}/health`);
        await res.arrayBuffer();
        const ms = performance.now() - inicio;
        pior = Math.max(pior, ms);
        medidas += 1;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(terminou(taskId), 'a sessão ruidosa não terminou a tempo');
      assert.ok(medidas >= 3, `poucas medidas (${medidas}) para concluir alguma coisa`);
      assert.ok(pior < 500, `GET /health levou ${Math.round(pior)} ms durante a rajada`);

      const res = await fetch(`${baseUrl}/sessions/${sessionId}/events?tail=1&limit=5000`);
      const corpo = await res.text();
      const bytes = Buffer.byteLength(corpo);
      assert.ok(bytes < 12 * 1024 * 1024, `resposta de ${bytes} bytes`);
      const { events } = JSON.parse(corpo) as { events: EventEnvelope[] };
      assert.equal(events.length, 5000, 'o teto de bytes não pode mudar a contagem da página');
      const gigante = events.find((e) => textoDe(e.payload['text']).startsWith('zzzz'));
      assert.ok(gigante, 'a linha gigante precisa aparecer (cortada), não sumir');
      assert.match(String(gigante.payload['text']), /\[truncado \d+ bytes\]$/);
      assert.ok(String(gigante.payload['text']).length < 2 * 1024 * 1024);
    },
  );

  test('raw de tool_result de 5 MB é persistido cortado, com a marca', { timeout: 60_000 }, async () => {
    const { sessionId, taskId } = await iniciar('claude-falso');
    const limite = Date.now() + 50_000;
    while (!terminou(taskId) && Date.now() < limite) await new Promise((r) => setTimeout(r, 50));

    const resultado = hub.store.events
      .list({ sessionId, types: ['tool.result'] })
      .find((e) => e.payload['toolUseId'] === 'tu_1');
    assert.ok(resultado, 'o tool.result precisa existir');
    const rawBytes = Buffer.byteLength(JSON.stringify(resultado.raw));
    assert.ok(rawBytes < 64 * 1024, `raw persistido com ${rawBytes} bytes`);
    assert.match(String(resultado.raw), /\[truncado \d+ bytes\]$/);
    assert.equal(resultado.payload['truncated'], true);
  });
});
