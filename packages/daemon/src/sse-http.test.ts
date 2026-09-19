import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeEvent, type EventEnvelope } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * `port: 0` deixaria o SO escolher a porta, mas a guarda de borda (`guard.ts`)
 * compara o `Host` da requisição contra `config.port` — que continuaria `0`
 * depois do `listen`, pois só o retorno de `server.listen()` sabe a porta
 * real. Por isso reservamos uma porta livre ANTES de montar o Hub.
 */
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
 * Endurecimento do SSE (Fase 5), exercitado contra o daemon HTTP de verdade —
 * não só a função `startSseChannel` isolada. `since=abc` e o teto de conexões
 * só existem se a rota realmente os aplicar ANTES de aceitar a conexão, e o
 * sinal de truncamento só vale alguma coisa se o cliente de fato o vir no
 * stream de uma sessão com histórico grande.
 */
describe('SSE de /events contra o daemon real', () => {
  let raiz: string;
  let hub: Hub;
  let baseUrl: string;
  let projectId: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-sse-'));
    const manifestos = path.join(raiz, 'manifests');
    const projetoPath = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });

    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(
      script,
      `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.exit(0);
`,
      'utf8',
    );
    writeFileSync(
      path.join(manifestos, 'agente-sse.yaml'),
      `
id: agente-sse
name: agente-sse
vendor: Test
description: Agente de teste para SSE
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

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      port: await portaLivre(),
      maxSseConnections: 1,
    });
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;
    projectId = hub.sessions.registerProject(projetoPath, 'Projeto SSE').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  /**
   * `AbortController.abort()` derruba o socket, mas o `req.on('close')` do
   * servidor (e portanto `bus.unsubscribe`) chega um tick depois — assíncrono
   * demais para confiar num `await` só. Os testes de teto precisam de
   * `subscriberCount` exato, então esperamos ele convergir de verdade.
   */
  async function esperarAssinantes(esperado: number, timeoutMs = 2000): Promise<void> {
    const limite = Date.now() + timeoutMs;
    while (hub.bus.subscriberCount !== esperado) {
      if (Date.now() > limite) {
        throw new Error(
          `subscriberCount não chegou a ${esperado} a tempo (ficou em ${hub.bus.subscriberCount})`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test('since=abc é recusado com 400 ANTES de abrir o stream', async () => {
    const res = await fetch(`${baseUrl}/events?since=abc`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_QUERY');
  });

  test('since ausente continua aceito (replay completo, comportamento antigo preservado)', async () => {
    await esperarAssinantes(0);
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    controller.abort();
    await esperarAssinantes(0);
  });

  test('acima do teto de conexões, a rota responde 503 em vez de aceitar mais uma', async () => {
    await esperarAssinantes(0);

    const primeira = new AbortController();
    const resPrimeira = await fetch(`${baseUrl}/events`, { signal: primeira.signal });
    assert.equal(resPrimeira.status, 200, 'a 1ª conexão deve caber dentro do teto (maxSseConnections=1)');

    try {
      const resSegunda = await fetch(`${baseUrl}/events`);
      assert.equal(resSegunda.status, 503, 'a 2ª conexão excede o teto configurado');
      const body = (await resSegunda.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'SSE_CONNECTION_LIMIT');
    } finally {
      primeira.abort();
    }

    // Depois de fechar a 1ª conexão, o teto libera espaço de novo.
    await esperarAssinantes(0);
    const terceira = new AbortController();
    const resTerceira = await fetch(`${baseUrl}/events`, { signal: terceira.signal });
    assert.equal(resTerceira.status, 200, 'fechar a conexão anterior devolve a vaga');
    terceira.abort();
    await esperarAssinantes(0);
  });

  test('sessão com histórico maior que o teto de replay recebe o sinal de truncamento', async () => {
    const session = hub.sessions.adoptExternal({ agentId: 'agente-sse', projectId, title: 'sessão SSE' });

    // Mais eventos que o teto de replay (500) — semeados direto no banco, sem
    // rodar processo nenhum: o que este teste cobre é o sinal de truncamento,
    // não a produção de eventos. `adoptExternal` já emitiu ao menos um evento
    // (`session.started`), então continuamos a partir do próximo `seq` livre
    // em vez de assumir que a sessão nasce vazia.
    let seq = hub.store.events.lastSeq(session.id) + 1;
    for (let i = 0; i < 520; i += 1) {
      hub.store.events.append(
        makeEvent({ sessionId: session.id, agentId: 'agente-sse', type: 'log', payload: { i } }, seq),
      );
      seq += 1;
    }

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events?sessionId=${session.id}`, { signal: controller.signal });
    assert.equal(res.status, 200);

    const reader = res.body?.getReader();
    assert.ok(reader, 'stream deveria ter corpo legível');

    const decoder = new TextDecoder();
    let acumulado = '';
    let achou = false;
    const limite = Date.now() + 10_000;

    while (!achou && Date.now() < limite) {
      const { value, done } = await reader.read();
      if (done) break;
      acumulado += decoder.decode(value, { stream: true });
      if (acumulado.includes('"truncated":true')) achou = true;
    }
    controller.abort();

    assert.ok(achou, 'o cliente deveria ver um evento sintético avisando que o replay foi cortado');

    const linhaComTruncado = acumulado
      .split('\n')
      .find((linha) => linha.startsWith('data:') && linha.includes('"truncated":true'));
    assert.ok(linhaComTruncado, 'o aviso deveria vir como um evento data: normal');
    const parsed = JSON.parse(linhaComTruncado!.slice('data:'.length).trim()) as EventEnvelope;
    assert.equal(parsed.payload['truncated'], true);
    assert.equal(parsed.payload['sessionId'], session.id);
    assert.equal(parsed.payload['sentCount'], 500);

    // O aviso sintético não deveria levar `id:` — ele não tem `seq` real, e
    // reconectar com `Last-Event-ID` igual ao dele perderia eventos de verdade.
    const idxData = acumulado.indexOf(linhaComTruncado!);
    const antesDoData = acumulado.slice(Math.max(0, idxData - 20), idxData);
    assert.doesNotMatch(antesDoData, /id: 0\n$/);
  });
});
