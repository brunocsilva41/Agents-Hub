import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';
import { encerradorDoProcesso } from './safety-net.js';

/**
 * Pendência D(4) do fechamento do MVP: o `main.ts` e o `createHub` montam
 * CADA UM o seu `encerradorDoProcesso` (sinal e `POST /shutdown`), cada um com
 * a sua guarda de reentrância. Um Ctrl-C durante o `POST /shutdown` passava
 * pelas duas guardas e rodava `hub.shutdown()` duas vezes em paralelo — a
 * segunda fechava o banco que a primeira ainda usava e o processo saía com
 * código 1. O desligamento precisa ser idempotente no próprio Hub: a segunda
 * entrada espera a primeira.
 */
describe('Hub.shutdown idempotente', () => {
  let raiz: string;
  let hub: Hub;

  function montar(): Hub {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-shutdown-'));
    const home = path.join(raiz, 'home');
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(home, { recursive: true });
    mkdirSync(manifestos, { recursive: true });
    return createHub({ home, manifestsDir: manifestos, port: 0 });
  }

  /** Conta as entradas no desligamento das sessões e o torna lento de propósito. */
  function espiarDesligamento(h: Hub): { entradas: number; fim: number } {
    const espia = { entradas: 0, fim: 0 };
    const original = h.sessions.shutdown.bind(h.sessions);
    h.sessions.shutdown = async () => {
      espia.entradas += 1;
      // Lentidão simulada: alarga a janela em que a segunda chamada chega.
      await new Promise((r) => setTimeout(r, 50));
      await original();
      espia.fim = Date.now();
    };
    return espia;
  }

  afterEach(() => {
    rmSync(raiz, { recursive: true, force: true });
  });

  test('duas chamadas concorrentes: um desligamento só, e a segunda espera a primeira', async () => {
    hub = montar();
    await hub.start();
    const espia = espiarDesligamento(hub);

    let segundaResolveuEm = 0;
    const primeira = hub.shutdown();
    const segunda = hub.shutdown().then(() => {
      segundaResolveuEm = Date.now();
    });
    await Promise.all([primeira, segunda]);

    assert.equal(espia.entradas, 1, 'o desligamento rodou mais de uma vez');
    assert.ok(segundaResolveuEm >= espia.fim, 'a segunda entrada voltou antes de a primeira terminar');
    // Depois de encerrado, chamar de novo continua inofensivo.
    await hub.shutdown();
    assert.equal(espia.entradas, 1);
  });

  test('Ctrl-C durante POST /shutdown: os dois encerradores saem com código 0', async () => {
    hub = montar();
    const { port } = await hub.start();
    const espia = espiarDesligamento(hub);

    // Mesma composição do daemon real, com `sair` falso no lugar de `process.exit`.
    const codigos: Array<{ quem: string; codigo: number }> = [];
    let saidas = 0;
    let todasSairam!: () => void;
    const ambas = new Promise<void>((r) => (todasSairam = r));
    const sair = (quem: string) => (codigo: number) => {
      codigos.push({ quem, codigo });
      saidas += 1;
      if (saidas === 2) todasSairam();
    };
    hub.server.onShutdown = encerradorDoProcesso(() => hub.shutdown(), sair('POST /shutdown'));
    const porSinal = encerradorDoProcesso(async (_sinal: string) => hub.shutdown(), sair('SIGINT'));

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/shutdown',
          headers: { Authorization: `Bearer ${hub.operatorToken}`, 'Content-Length': 0 },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);

    // A rota agenda o desligamento para 100 ms depois de responder; o sinal
    // chega no meio dele, com as sessões ainda sendo encerradas.
    // Consulta curta: o sinal precisa cair DENTRO da janela de ~50 ms do desligamento.
    await esperarAte(() => espia.entradas > 0, 'o desligamento começar', { intervaloMs: 2 });
    void porSinal('SIGINT');
    await ambas;

    assert.equal(espia.entradas, 1, 'o desligamento rodou mais de uma vez');
    assert.deepEqual(
      codigos.map((c) => c.codigo),
      [0, 0],
      `saídas: ${JSON.stringify(codigos)}`,
    );
  });
});
