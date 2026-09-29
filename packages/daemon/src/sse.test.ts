import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, test } from 'node:test';
import { HubError, makeEvent } from '@agents-hub/core';
import {
  formatarCursorDaTask,
  intercalarTimelines,
  lerCursorDaTask,
  SSE_KEEPALIVE_MS,
  startSseChannel,
} from './sse.js';

/**
 * `startSseChannel` é a extração que faz `/events` e `/api/tasks/:id/events`
 * pararem de divergir na origem (keep-alive, `id:`, backpressure). Estes
 * testes exercitam o canal isolado, sem precisar de um HTTP real: um
 * `ServerResponse` de verdade não deixa controlar backpressure nem simular
 * "conexão já morta entre o close do socket e o próximo tick do timer" de
 * forma determinística.
 */

/** `ServerResponse` falso: grava tudo que seria escrito no socket. */
class FakeRes extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  chunks: string[] = [];
  ended = false;
  /** Quando definido, toda chamada a `write` lança isto em vez de gravar. */
  throwOnWrite: Error | null = null;
  /** Quando `false`, simula o buffer do socket cheio (backpressure real). */
  writeReturns = true;

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.chunks.push(chunk);
    return this.writeReturns;
  }

  end(): void {
    this.ended = true;
    this.writableEnded = true;
  }
}

class FakeReq extends EventEmitter {}

function evento(seq: number, sessionId = 'ses_abc123') {
  return makeEvent({ sessionId, agentId: 'claude', type: 'message', payload: { text: `m${seq}` } }, seq);
}

describe('startSseChannel — keep-alive, id: e try/catch', () => {
  test('ping periódico sai a cada SSE_KEEPALIVE_MS, sem poluir com dado', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const req = new FakeReq() as unknown as IncomingMessage;
    const res = new FakeRes() as unknown as ServerResponse;

    startSseChannel(req, res, { withId: true });

    t.mock.timers.tick(SSE_KEEPALIVE_MS);
    t.mock.timers.tick(SSE_KEEPALIVE_MS);

    const chunks = (res as unknown as FakeRes).chunks;
    assert.equal(chunks.length, 2);
    assert.ok(
      chunks.every((c) => c === ': ping\n\n'),
      'ping não deve levar id: nem data:',
    );
  });

  test('id: presente quando withId, ausente quando não', () => {
    const req1 = new FakeReq() as unknown as IncomingMessage;
    const res1 = new FakeRes() as unknown as ServerResponse;
    const ch1 = startSseChannel(req1, res1, { withId: true });
    ch1.send(evento(7));
    assert.match((res1 as unknown as FakeRes).chunks[0] ?? '', /^id: 7\n/);
    ch1.close();

    const req2 = new FakeReq() as unknown as IncomingMessage;
    const res2 = new FakeRes() as unknown as ServerResponse;
    const ch2 = startSseChannel(req2, res2, { withId: false });
    ch2.send(evento(7));
    assert.doesNotMatch((res2 as unknown as FakeRes).chunks[0] ?? '', /^id:/);
    ch2.close();
  });

  test('withId pode ser sobrescrito por evento (aviso sintético sem id)', () => {
    const req = new FakeReq() as unknown as IncomingMessage;
    const res = new FakeRes() as unknown as ServerResponse;
    const channel = startSseChannel(req, res, { withId: true });

    channel.send(evento(1));
    channel.send(evento(2), { withId: false });

    const chunks = (res as unknown as FakeRes).chunks;
    assert.match(chunks[0] ?? '', /^id: 1\n/);
    assert.doesNotMatch(chunks[1] ?? '', /^id:/);
    channel.close();
  });

  test('req "close" limpa o timer e chama onClose uma vez', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const req = new FakeReq() as unknown as IncomingMessage;
    const res = new FakeRes() as unknown as ServerResponse;
    let closes = 0;

    const channel = startSseChannel(req, res, { withId: false, onClose: () => (closes += 1) });
    (req as unknown as FakeReq).emit('close');
    (req as unknown as FakeReq).emit('close');

    assert.equal(closes, 1, 'cleanup é idempotente');
    assert.equal(channel.closed, true);

    // Depois de fechado, o ping não deve mais escrever nada (timer já limpo).
    const antes = (res as unknown as FakeRes).chunks.length;
    t.mock.timers.tick(SSE_KEEPALIVE_MS);
    assert.equal((res as unknown as FakeRes).chunks.length, antes);
  });

  test('conexão já destruída entre close do socket e o próximo tick: keep-alive não lança e faz cleanup', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const req = new FakeReq() as unknown as IncomingMessage;
    const fakeRes = new FakeRes();
    const res = fakeRes as unknown as ServerResponse;
    let closed = false;

    startSseChannel(req, res, { withId: false, onClose: () => (closed = true) });

    // Corrida real: o socket morreu, mas ninguém emitiu 'close' ainda.
    fakeRes.destroyed = true;

    assert.doesNotThrow(() => t.mock.timers.tick(SSE_KEEPALIVE_MS));
    assert.equal(
      closed,
      true,
      'checar writableEnded/destroyed antes de escrever deve disparar o mesmo cleanup do close',
    );
    assert.equal(fakeRes.chunks.length, 0, 'nada deveria ter sido escrito numa conexão já morta');
  });

  test('escrita que lança no keep-alive é tratada como desconexão, não deixa o processo cair', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const req = new FakeReq() as unknown as IncomingMessage;
    const fakeRes = new FakeRes();
    const res = fakeRes as unknown as ServerResponse;
    let closed = false;

    startSseChannel(req, res, { withId: false, onClose: () => (closed = true) });

    fakeRes.throwOnWrite = new Error('socket EPIPE');
    assert.doesNotThrow(() => t.mock.timers.tick(SSE_KEEPALIVE_MS));
    assert.equal(closed, true);

    // Depois do cleanup, novos ticks não tentam escrever de novo (timer já parado).
    fakeRes.throwOnWrite = null;
    t.mock.timers.tick(SSE_KEEPALIVE_MS * 2);
    assert.equal(fakeRes.chunks.length, 0);
  });
});

describe('startSseChannel — backpressure e cliente lento', () => {
  test('res.write() devolvendo false enfileira; "drain" esvazia a fila', () => {
    const req = new FakeReq() as unknown as IncomingMessage;
    const fakeRes = new FakeRes();
    const res = fakeRes as unknown as ServerResponse;
    const channel = startSseChannel(req, res, { withId: true });

    fakeRes.writeReturns = false; // buffer do socket "cheio"
    channel.send(evento(1));
    channel.send(evento(2));
    channel.send(evento(3));

    // A primeira escrita ainda acontece (tenta escrever direto); as
    // seguintes, com `draining=true`, vão para a fila sem tocar `write`.
    assert.equal(fakeRes.chunks.length, 1, 'só a primeira tentativa de escrita ocorre antes do drain');

    fakeRes.writeReturns = true; // socket teria espaço agora
    fakeRes.emit('drain');

    assert.equal(fakeRes.chunks.length, 3, 'drain deve esvaziar a fila inteira');
    assert.match(fakeRes.chunks[1] ?? '', /"seq":2/);
    assert.match(fakeRes.chunks[2] ?? '', /"seq":3/);
    channel.close();
  });

  test('fila além do teto encerra a conexão em vez de crescer sem limite', () => {
    const req = new FakeReq() as unknown as IncomingMessage;
    const fakeRes = new FakeRes();
    const res = fakeRes as unknown as ServerResponse;
    let closed = false;
    const QUEUE_CAP = 5;

    const channel = startSseChannel(req, res, {
      withId: false,
      queueCap: QUEUE_CAP,
      onClose: () => (closed = true),
    });

    fakeRes.writeReturns = false; // cliente nunca lê o socket
    for (let i = 1; i <= QUEUE_CAP + 10; i += 1) {
      channel.send(evento(i));
    }

    assert.equal(closed, true, 'cliente lento demais deve ser desconectado');
    assert.equal(fakeRes.ended, true, 'a conexão precisa ser encerrada de verdade, não só marcada');
    assert.equal(channel.closed, true);
  });

  test('end() entrega a fila pendente antes de fechar; close() a larga', () => {
    const req = new FakeReq() as unknown as IncomingMessage;
    const fakeRes = new FakeRes();
    const res = fakeRes as unknown as ServerResponse;
    let closes = 0;
    const channel = startSseChannel(req, res, { withId: true, onClose: () => (closes += 1) });

    fakeRes.writeReturns = false; // socket "cheio": 2 e 3 ficam na fila
    channel.send(evento(1));
    channel.send(evento(2));
    channel.send(evento(3));
    channel.end();

    assert.equal(fakeRes.chunks.length, 3, 'o fim normal não pode perder o final do stream');
    assert.match(fakeRes.chunks[2] ?? '', /^id: 3\n/);
    assert.equal(fakeRes.ended, true);
    assert.equal(closes, 1);
    assert.equal(channel.closed, true);
  });

  test('depois de fechado, send() não escreve mais nada', () => {
    const req = new FakeReq() as unknown as IncomingMessage;
    const fakeRes = new FakeRes();
    const res = fakeRes as unknown as ServerResponse;
    const channel = startSseChannel(req, res, { withId: false });

    channel.close();
    channel.send(evento(1));

    assert.equal(fakeRes.chunks.length, 0);
  });
});

describe('cursor de reconexão do stream da task', () => {
  const A = 'ses_aaa111';
  const B = 'ses_bbb222';

  test('id explícito tem precedência sobre o seq', () => {
    const req = new FakeReq() as unknown as IncomingMessage;
    const fakeRes = new FakeRes();
    const channel = startSseChannel(req, fakeRes as unknown as ServerResponse, { withId: false });
    channel.send(evento(4), { id: `${A}:4` });
    assert.match(fakeRes.chunks[0] ?? '', new RegExp(`^id: ${A}:4\\n`));
    channel.close();
  });

  test('formata e lê de volta a posição de todas as sessões, na ordem', () => {
    const texto = formatarCursorDaTask(
      new Map([
        [A, 3],
        [B, 12],
      ]),
    );
    assert.equal(texto, `${A}:3,${B}:12`);
    assert.deepEqual(
      [...lerCursorDaTask(texto, [A, B])],
      [
        [A, 3],
        [B, 12],
      ],
    );
  });

  test('ausente ou vazio é "sem cursor" (replay desde o começo)', () => {
    assert.equal(lerCursorDaTask(undefined, [A]).size, 0);
    assert.equal(lerCursorDaTask('', [A]).size, 0);
    assert.equal(lerCursorDaTask('   ', [A]).size, 0);
  });

  test('malformado, repetido ou de sessão alheia é INVALID_QUERY', () => {
    const invalidos = [
      '7',
      `${A}`,
      `${A}:`,
      `${A}:-1`,
      `${A}:1.5`,
      `${A}:1,`,
      `${A}:1, ${B}:2`,
      `${A}:1,${A}:2`,
      `${B}:1`,
      `tsk_x:1`,
      `${A}:1234567890123456`,
    ];
    for (const valor of invalidos) {
      assert.throws(
        () => lerCursorDaTask(valor, [A]),
        (err: unknown) => err instanceof HubError && err.code === 'INVALID_QUERY',
        `"${valor}" deveria ser recusado`,
      );
    }
  });

  test('intercala por ts sem inverter a ordem de seq dentro de uma sessão', () => {
    const ev = (sessionId: string, seq: number, s: number) => ({
      ...evento(seq, sessionId),
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString(),
    });
    // O relógio de A "voltou" entre o 2 e o 3: um sort global por ts poria o
    // 3 antes do 2, e o cursor (maior seq entregue) pularia o 2 na reconexão.
    const a = [ev(A, 1, 1), ev(A, 2, 5), ev(A, 3, 2)];
    const b = [ev(B, 1, 3), ev(B, 2, 6)];
    const saida = intercalarTimelines([a, b]).map((e) => `${e.sessionId === A ? 'A' : 'B'}${e.seq}`);
    assert.deepEqual(saida, ['A1', 'B1', 'A2', 'A3', 'B2']);
  });
});
