import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readHubEnv } from '@agents-hub/daemon';
import { resolveDaemonOverrides } from './daemon-run.js';

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
