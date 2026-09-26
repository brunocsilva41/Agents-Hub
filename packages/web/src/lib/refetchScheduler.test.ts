import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRefetchScheduler } from './refetchScheduler.js';
import { FakeClock, flushMicrotasks } from './fakeClock.js';

/**
 * 6.10: cada evento estrutural refazia o índice, e buscas iguais rodavam em
 * paralelo — 253 requisições em 15 min. O agendador tem que transformar uma
 * rajada em uma busca, e nunca deixar duas em voo ao mesmo tempo.
 */
describe('agendador de recarga', () => {
  test('rajada de 50 eventos em 10 ms cada vira UMA busca', async () => {
    const clock = new FakeClock();
    let buscas = 0;
    const s = createRefetchScheduler(async () => {
      buscas += 1;
    }, { delayMs: 300, maxWaitMs: 1500, clock });

    for (let i = 0; i < 50; i += 1) {
      s.request();
      await clock.advance(10);
    }
    await clock.advance(1000);
    assert.equal(buscas, 1);
  });

  test('fluxo contínuo não adia para sempre: maxWait garante atualização', async () => {
    const clock = new FakeClock();
    let buscas = 0;
    const s = createRefetchScheduler(async () => {
      buscas += 1;
    }, { delayMs: 300, maxWaitMs: 1500, clock });

    // Um evento a cada 100 ms por 3 s: o debounce sozinho nunca dispararia.
    for (let i = 0; i < 30; i += 1) {
      s.request();
      await clock.advance(100);
    }
    await clock.advance(1000);
    assert.ok(buscas >= 2, `esperava pelo menos 2 buscas em 3 s, houve ${buscas}`);
    assert.ok(buscas <= 3, `esperava no máximo 3 buscas em 3 s, houve ${buscas}`);
  });

  test('pedidos durante uma busca em voo geram exatamente UMA busca a mais, nunca paralela', async () => {
    const clock = new FakeClock();
    let emVoo = 0;
    let maxEmVoo = 0;
    let buscas = 0;
    let liberar: (() => void) | null = null;
    const s = createRefetchScheduler(
      () => {
        buscas += 1;
        emVoo += 1;
        maxEmVoo = Math.max(maxEmVoo, emVoo);
        return new Promise<void>((resolve) => {
          liberar = () => {
            emVoo -= 1;
            resolve();
          };
        });
      },
      { delayMs: 300, maxWaitMs: 1500, clock },
    );

    s.request();
    await clock.advance(300);
    assert.equal(buscas, 1);

    // 3 s de eventos com a primeira busca ainda em voo — passa do maxWait, que
    // dispararia uma busca nova se o agendador não soubesse que há uma em voo.
    for (let i = 0; i < 60; i += 1) {
      s.request();
      await clock.advance(50);
    }
    assert.equal(buscas, 1, 'nada novo enquanto a primeira está em voo');

    (liberar as unknown as () => void)();
    await flushMicrotasks();
    await clock.advance(300);
    assert.equal(buscas, 2);
    (liberar as unknown as () => void)();
    await flushMicrotasks();
    await clock.advance(2000);
    assert.equal(buscas, 2);
    assert.equal(maxEmVoo, 1);
  });

  test('falha na busca não trava o agendador', async () => {
    const clock = new FakeClock();
    let buscas = 0;
    const erros: unknown[] = [];
    const s = createRefetchScheduler(
      async () => {
        buscas += 1;
        if (buscas === 1) throw new Error('rede');
      },
      { delayMs: 300, clock, onError: (e) => erros.push(e) },
    );
    s.request();
    await clock.advance(300);
    s.request();
    await clock.advance(300);
    assert.equal(buscas, 2);
    assert.equal(erros.length, 1);
  });

  test('dispose cancela o agendado', async () => {
    const clock = new FakeClock();
    let buscas = 0;
    const s = createRefetchScheduler(async () => {
      buscas += 1;
    }, { clock });
    s.request();
    s.dispose();
    await clock.advance(5000);
    assert.equal(buscas, 0);
  });
});
