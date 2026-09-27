import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HubClient } from './client.js';
import { restartCommand } from './restart-cmd.js';
import { capturar, limpar, montarHub, type HubDeTeste } from './test-kit.js';

async function responde(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`)).ok;
  } catch {
    return false;
  }
}

/** `hub restart` não existia: depois de atualizar, o daemon antigo seguia rodando. */
describe('hub restart', () => {
  test('encerra com o token de operador, espera largar a porta e só então sobe de novo', async () => {
    const primeiro = await montarHub('restart');
    const porta = Number(new URL(primeiro.url).port);
    const novo: { hub: HubDeTeste | null } = { hub: null };
    let antigoRespondiaNaSubida: boolean | null = null;
    try {
      const { out } = await capturar(() =>
        restartCommand(primeiro.client, { command: 'restart', positional: [], flags: {} }, {
          pollMs: 25,
          start: async () => {
            antigoRespondiaNaSubida = await responde(primeiro.url);
            novo.hub = await montarHub('restart', { raiz: primeiro.raiz, porta });
          },
        }),
      );
      assert.equal(antigoRespondiaNaSubida, false, 'a subida esperou o antigo parar');
      assert.ok(novo.hub, 'subiu um daemon novo');
      assert.ok(await responde(primeiro.url), 'e ele responde na mesma porta');
      assert.ok(out.some((l) => l.includes('daemon reiniciado')));
      // O encerramento passou pela rota autenticada e ficou na trilha (mesmo banco).
      const trilha = novo.hub.hub.audit.list({ kind: 'daemon.shutdown' });
      assert.equal(trilha.length, 1);
      assert.match(trilha[0]!.actor, /^cli:/);
    } finally {
      await novo.hub?.fechar();
      await primeiro.fechar();
      limpar(primeiro.raiz);
    }
  });

  test('sem token de operador, recusa e NÃO sobe outro daemon', async () => {
    const t = await montarHub('restart-token');
    let subiu = false;
    try {
      const semToken = new HubClient(t.url);
      await assert.rejects(
        () =>
          restartCommand(semToken, { command: 'restart', positional: [], flags: {} }, {
            start: async () => {
              subiu = true;
            },
          }),
        /token de operador/,
      );
      assert.equal(subiu, false);
      assert.ok(await responde(t.url), 'o daemon continua no ar');
    } finally {
      await t.fechar();
      limpar(t.raiz);
    }
  });

  test('com sessão viva, recusa sem --force (reiniciar encerraria a sessão)', async () => {
    let encerrou = false;
    const falso = {
      health: async () => ({ ok: true, version: '0.1.0', now: '', liveSessions: 2, subscribers: 0 }),
      shutdown: async () => {
        encerrou = true;
        return { ok: true };
      },
    } as unknown as HubClient;
    await assert.rejects(
      () => restartCommand(falso, { command: 'restart', positional: [], flags: {} }, { start: async () => undefined }),
      /2 sessão\(ões\) viva\(s\).*--force/,
    );
    assert.equal(encerrou, false);
  });

  test('daemon parado: só sobe', async () => {
    let vivo = false;
    const falso = {
      health: async () => {
        if (!vivo) throw new Error('fetch failed');
        return { ok: true, version: '0.1.0', now: '', liveSessions: 0, subscribers: 0 };
      },
      shutdown: async () => {
        throw new Error('não deveria encerrar nada');
      },
    } as unknown as HubClient;
    const { out } = await capturar(() =>
      restartCommand(falso, { command: 'restart', positional: [], flags: {} }, {
        start: async () => {
          vivo = true;
        },
      }),
    );
    assert.ok(out.some((l) => l.includes('não estava rodando')));
    assert.ok(out.some((l) => l.includes('daemon reiniciado')));
  });
});
