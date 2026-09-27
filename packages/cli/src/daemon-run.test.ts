import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createHub, readHubEnv } from '@agents-hub/daemon';
import { explicarFalhaDeListen, resolveDaemonOverrides, subirDaemon } from './daemon-run.js';
import { montarHubDeTeste } from './hub-de-teste.js';

/**
 * `hub daemon` é o caminho que o autostart usa (`ensureDaemon` em
 * `daemon-control.ts`) — o mais executado dos dois entrypoints do daemon.
 * Antes desta mudança ele chamava `createHub()` sem overrides nenhum, então
 * `AGENTS_HUB_PORT` só era respeitado no OUTRO entrypoint
 * (`packages/daemon/src/main.ts`, que só roda com `node .../main.js` direto).
 * Nenhum teste cobria essa lacuna — é exatamente o que faltou para o bug ser
 * notado.
 *
 * `resolveDaemonOverrides` é a função que `runDaemon()` chama para montar o
 * override de `createHub`; testá-la aqui prova que a variável de ambiente
 * chega até o `HubConfig` sem precisar subir um daemon de verdade (o que
 * exigiria bind de porta real e handlers de processo dentro da suíte
 * compartilhada de testes).
 */
describe('resolveDaemonOverrides — o daemon que o autostart sobe respeita AGENTS_HUB_PORT', () => {
  test('AGENTS_HUB_PORT definido vira override de port', () => {
    const env = readHubEnv({ AGENTS_HUB_PORT: '5050' });
    assert.deepEqual(resolveDaemonOverrides(env), { port: 5050 });
  });

  test('sem AGENTS_HUB_PORT, nenhum override é aplicado (fica o padrão do createHub)', () => {
    const env = readHubEnv({});
    assert.deepEqual(resolveDaemonOverrides(env), {});
  });
});

/**
 * Vistoria 07, R07-07: `hub daemon` com a porta ocupada saía com
 * `Error: listen EADDRINUSE 127.0.0.1:4747` — sem dizer que o ocupante é,
 * quase sempre, o próprio daemon. Daemon de teste isolado (porta própria,
 * home temporário); o segundo hub, com OUTRO home, nunca chega a abrir a porta.
 */
describe('hub daemon com a porta ocupada', () => {
  test('ocupada por um Hub: "já há um daemon em <url>" e sugere hub status', async () => {
    const h = await montarHubDeTeste([], { prefixo: 'hub-cli-porta-' });
    const home2 = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-porta2-'));
    const segundo = createHub({
      home: home2,
      manifestsDir: path.join(home2, 'manifests'),
      webRoot: path.join(home2, 'sem-web'),
      port: h.hub.config.port,
    });
    try {
      const url = `http://${h.hub.config.host}:${h.hub.config.port}`;
      await assert.rejects(
        () => subirDaemon(segundo),
        (err: Error & { code?: string }) => {
          assert.equal(err.code, 'DAEMON_ALREADY_RUNNING');
          assert.ok(err.message.includes(`já há um daemon em ${url}`), err.message);
          assert.match(err.message, /hub status/);
          assert.doesNotMatch(err.message, /EADDRINUSE/);
          return true;
        },
      );
      // O daemon de pé continua respondendo.
      assert.equal((await h.client.health()).ok, true);
    } finally {
      // Home próprio: encerrar o segundo não toca no banco do primeiro.
      await segundo.shutdown();
      await h.encerrar();
      try {
        rmSync(home2, { recursive: true, force: true });
      } catch {
        /* limpeza de temp é oportunista (Windows segura arquivo aberto) */
      }
    }
  });

  test('ocupada por outro programa: diz que não é um Hub e como trocar a porta', async () => {
    const intruso = createServer((_req, res) => res.end('nada'));
    await new Promise<void>((resolve) => intruso.listen(0, '127.0.0.1', resolve));
    const porta = (intruso.address() as { port: number }).port;
    try {
      const err = await explicarFalhaDeListen(
        Object.assign(new Error(`listen EADDRINUSE 127.0.0.1:${porta}`), { code: 'EADDRINUSE' }),
        `http://127.0.0.1:${porta}`,
      );
      assert.equal((err as { code?: string }).code, 'PORT_IN_USE');
      assert.match((err as Error).message, /já está em uso por outro programa/);
      assert.match((err as Error).message, /AGENTS_HUB_PORT/);
    } finally {
      await new Promise<void>((resolve) => intruso.close(() => resolve()));
    }
  });

  test('outros erros passam como vieram', async () => {
    const original = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    assert.equal(await explicarFalhaDeListen(original, 'http://127.0.0.1:1', async () => true), original);
  });
});
