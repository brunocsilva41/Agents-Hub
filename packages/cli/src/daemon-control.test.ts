import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { HubClient } from '@agents-hub/client';
import { ensureDaemon } from './daemon-control.js';

/**
 * `ensureDaemon` (item 7.1 do GOAL: sem teste próprio). Só os caminhos que NÃO
 * sobem processo: subir um daemon destacado de dentro da suíte deixaria um
 * processo órfão (é `detached` + `unref` de propósito) e, sem porta própria,
 * tentaria a 4747 do usuário. O caminho do spawn continua SEM teste
 * automatizado: exigiria `AGENTS_HUB_PORT` aceitar 0 (hoje o schema recusa) ou
 * um ponto de injeção para o comando de subida.
 */
describe('ensureDaemon', () => {
  let autostartAntes: string | undefined;

  beforeEach(() => {
    autostartAntes = process.env['AGENTS_HUB_NO_AUTOSTART'];
  });

  afterEach(() => {
    if (autostartAntes === undefined) delete process.env['AGENTS_HUB_NO_AUTOSTART'];
    else process.env['AGENTS_HUB_NO_AUTOSTART'] = autostartAntes;
  });

  function cliente(responde: boolean): { client: HubClient; chamadas: () => number } {
    let n = 0;
    const client = {
      health: async () => {
        n += 1;
        if (!responde) throw new Error('ECONNREFUSED');
        return { ok: true };
      },
    } as unknown as HubClient;
    return { client, chamadas: () => n };
  }

  test('daemon já no ar: devolve "ja-estava" e não tenta subir outro', async () => {
    // Mesmo com o autostart permitido: se respondeu, nada é iniciado.
    delete process.env['AGENTS_HUB_NO_AUTOSTART'];
    const { client, chamadas } = cliente(true);
    assert.equal(await ensureDaemon(client, { quiet: true }), 'ja-estava');
    assert.equal(chamadas(), 1);
  });

  test('daemon fora do ar com AGENTS_HUB_NO_AUTOSTART=1: erro claro, sem subir nada', async () => {
    process.env['AGENTS_HUB_NO_AUTOSTART'] = '1';
    const { client, chamadas } = cliente(false);
    await assert.rejects(ensureDaemon(client, { quiet: true }), /AGENTS_HUB_NO_AUTOSTART=1.*hub daemon/);
    assert.equal(chamadas(), 1, 'uma sondagem e para — nenhum laço de espera');
  });
});
