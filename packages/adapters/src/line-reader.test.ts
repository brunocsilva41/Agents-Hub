import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { AsyncQueue } from './async-queue.js';
import { lerLinhas } from './line-reader.js';

function coletar(max?: number): { stream: PassThrough; linhas: string[]; fim: Promise<void> } {
  const stream = new PassThrough();
  const linhas: string[] = [];
  lerLinhas(stream, (l) => linhas.push(l), max);
  const fim = new Promise<void>((resolve) => stream.on('end', () => setImmediate(resolve)));
  return { stream, linhas, fim };
}

/**
 * Teto de linha do leitor de saída do agente (vistoria 2026-09-25, item 2.5):
 * `readline` acumulava uma linha de 60 MB inteira em memória.
 */
describe('lerLinhas', () => {
  test('quebra por \\n, remove o \\r do CRLF e emite a última linha sem terminador', async () => {
    const { stream, linhas, fim } = coletar();
    stream.write('um\r\ndois\n');
    stream.write('tr');
    stream.end('ês');
    await fim;
    assert.deepEqual(linhas, ['um', 'dois', 'três']);
  });

  test('UTF-8 partido entre chunks chega íntegro', async () => {
    const { stream, linhas, fim } = coletar();
    const bytes = Buffer.from('ção 日本語 🚀\n', 'utf8');
    for (const b of bytes) stream.write(Buffer.from([b]));
    stream.end();
    await fim;
    assert.deepEqual(linhas, ['ção 日本語 🚀']);
  });

  test('linha acima do teto chega cortada com a marca e o resto é descartado até o \\n', async () => {
    const { stream, linhas, fim } = coletar(100);
    // 1 MB em pedaços, sem quebra, e depois uma linha normal.
    const pedaco = Buffer.alloc(64 * 1024, 'x');
    for (let i = 0; i < 16; i += 1) stream.write(pedaco);
    stream.end('\nseguinte\n');
    await fim;

    assert.equal(linhas.length, 2);
    assert.equal(linhas[0], `${'x'.repeat(100)} [truncado ${16 * 64 * 1024 - 100} bytes]`);
    assert.equal(linhas[1], 'seguinte');
  });
});

/**
 * Rajada de saída (item 2.5): com a fila cheia, o `for await` do consumidor
 * drenava tudo em microtasks, sem nunca devolver a vez ao event loop — o HTTP
 * do daemon ficou 17 s sem resposta.
 */
describe('AsyncQueue cede o event loop durante a drenagem', () => {
  test('um setImmediate agendado no meio de uma drenagem longa roda antes de ela acabar', async () => {
    const fila = new AsyncQueue<number>({ highWaterMark: 1_000_000 });
    for (let i = 0; i < 200; i += 1) fila.push(i);
    fila.close();

    let rodouNoMeio = false;
    let consumidos = 0;
    setImmediate(() => {
      rodouNoMeio = consumidos < 200;
    });
    for await (const _ of fila) {
      consumidos += 1;
      // Consumidor lento (a escrita SQLite síncrona por evento, no daemon).
      const ate = Date.now() + 1;
      while (Date.now() < ate) {
        /* ocupado */
      }
    }

    assert.equal(consumidos, 200);
    assert.equal(rodouNoMeio, true, 'a drenagem precisa ceder o event loop');
  });
});
