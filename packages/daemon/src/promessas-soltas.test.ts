import assert from 'node:assert/strict';
import { setImmediate as cederLoop } from 'node:timers/promises';
import { describe, test } from 'node:test';
import type { UnitOfWork } from '@agents-hub/core';
import type { RetentionPolicy } from './config.js';
import { EventRetentionCompactor } from './event-retention.js';
import { WorktreeReaper } from './reaper.js';
import { encerradorDoProcesso } from './safety-net.js';
import { CicloDeVida } from './session-lifecycle.js';
import type { WorktreeManager } from './worktree.js';

/**
 * Promessas disparadas sem `await` no daemon (achados do `no-floating-promises`,
 * item 7.2 do GOAL). Cada uma rejeitava sem dono: no daemon a rede de
 * segurança só registrava "promessa rejeitada sem tratamento — a sessão de
 * origem pode ter parado", culpando a sessão errada; e no caminho de
 * desligamento a rejeição deixava o processo no ar, meio desligado.
 */

/** Roda `fn` e devolve as rejeições que ficaram sem dono até o loop assentar. */
async function rejeicoesSoltas(fn: () => void | Promise<void>): Promise<unknown[]> {
  const soltas: unknown[] = [];
  const ouvir = (motivo: unknown): void => {
    soltas.push(motivo);
  };
  process.on('unhandledRejection', ouvir);
  try {
    await fn();
    for (let i = 0; i < 5; i += 1) await cederLoop();
  } finally {
    process.off('unhandledRejection', ouvir);
  }
  return soltas;
}

/** Captura `console.error` durante `fn`. */
async function errosNoConsole(fn: () => Promise<void>): Promise<string[]> {
  const linhas: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    linhas.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return linhas;
}

describe('promessas soltas do daemon', () => {
  test('compactador de eventos: falha da passada do timer é registrada, não vira rejeição sem dono', async () => {
    const store = {
      events: {
        compactRawBefore: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      },
    } as unknown as Pick<UnitOfWork, 'events'>;
    const compactador = new EventRetentionCompactor(store, { rawEventDays: 7, sweepIntervalMinutes: 60 });

    let soltas: unknown[] = [];
    const erros = await errosNoConsole(async () => {
      soltas = await rejeicoesSoltas(() => compactador.start());
    });
    compactador.stop();

    assert.deepEqual(soltas, []);
    assert.ok(
      erros.some((l) => l.includes('[retenção]') && l.includes('SQLITE_BUSY')),
      `esperava o erro registrado com a origem; veio: ${JSON.stringify(erros)}`,
    );
  });

  test('reaper: falha da passada do timer é registrada, não vira rejeição sem dono', async () => {
    const store = {
      sessions: {
        list: () => {
          throw new Error('database is not open');
        },
      },
    } as unknown as UnitOfWork;
    const reaper = new WorktreeReaper(store, {} as WorktreeManager, {
      worktreeDays: 3,
      sweepIntervalMinutes: 60,
    } as RetentionPolicy);

    let soltas: unknown[] = [];
    const erros = await errosNoConsole(async () => {
      soltas = await rejeicoesSoltas(() => reaper.start());
    });
    reaper.stop();

    assert.deepEqual(soltas, []);
    assert.ok(
      erros.some((l) => l.includes('[reaper]') && l.includes('database is not open')),
      `esperava o erro registrado com a origem; veio: ${JSON.stringify(erros)}`,
    );
  });

  test('ciclo de vida: registrar um pump que rejeita não cria rejeição sem dono e o esquece', async () => {
    const ciclo = new CicloDeVida();
    const pump = Promise.reject(new Error('pump falhou'));
    // Quem cria o pump é quem trata a falha dele (session-manager); o
    // registro só não pode criar uma promessa derivada que rejeite solta.
    pump.catch(() => {});

    const soltas = await rejeicoesSoltas(() => ciclo.registrarPump('ses_x', pump));

    assert.deepEqual(soltas, []);
    assert.equal(await ciclo.aguardarPump('ses_x', 50), true, 'pump encerrado sai do registro');
  });

  describe('encerradorDoProcesso', () => {
    test('desligamento que rejeita: registra e SAI com código 1 (antes: processo ficava no ar)', async () => {
      const saidas: number[] = [];
      const encerrar = encerradorDoProcesso(
        () => Promise.reject(new Error('database is not open')),
        (codigo) => saidas.push(codigo),
      );

      let soltas: unknown[] = [];
      const erros = await errosNoConsole(async () => {
        soltas = await rejeicoesSoltas(() => {
          // Como o `process.on('SIGINT', () => void encerrar())` chama.
          void encerrar();
        });
      });

      assert.deepEqual(soltas, []);
      assert.deepEqual(saidas, [1]);
      assert.ok(erros.some((l) => l.includes('database is not open')), JSON.stringify(erros));
    });

    test('sucesso sai com 0; segundo sinal durante o desligamento não desliga de novo', async () => {
      const saidas: number[] = [];
      let chamadas = 0;
      let liberar!: () => void;
      const encerrar = encerradorDoProcesso(
        (motivo: string) => {
          chamadas += 1;
          assert.equal(motivo, 'SIGINT');
          return new Promise<void>((resolve) => {
            liberar = resolve;
          });
        },
        (codigo) => saidas.push(codigo),
      );

      const primeiro = encerrar('SIGINT');
      await encerrar('SIGINT');
      liberar();
      await primeiro;

      assert.equal(chamadas, 1);
      assert.deepEqual(saidas, [0]);
    });
  });
});
