import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHubError } from '@agents-hub/core';
import { readHubEnv } from './env.js';

describe('readHubEnv', () => {
  test('AGENTS_HUB_PORT=abc é rejeitado com erro claro, não vira NaN', () => {
    assert.throws(
      () => readHubEnv({ AGENTS_HUB_PORT: 'abc' }),
      (err: unknown) => {
        assert.ok(isHubError(err), 'deveria lançar HubError');
        assert.equal((err as { code: string }).code, 'HUB_CONFIG_INVALID');
        assert.match((err as Error).message, /AGENTS_HUB_PORT/);
        return true;
      },
    );
  });

  test('porta fora do intervalo (0, > 65535) é rejeitada', () => {
    assert.throws(() => readHubEnv({ AGENTS_HUB_PORT: '0' }));
    assert.throws(() => readHubEnv({ AGENTS_HUB_PORT: '70000' }));
  });

  test('sem nenhuma variável definida, tudo vem undefined — nada de padrão embutido aqui', () => {
    const env = readHubEnv({});
    assert.equal(env.AGENTS_HUB_PORT, undefined);
    assert.equal(env.AGENTS_HUB_HOME, undefined);
  });

  test('valores válidos são coeridos para o tipo certo', () => {
    const env = readHubEnv({
      AGENTS_HUB_PORT: '5050',
      AGENTS_HUB_HOME: '/tmp/hub-teste',
      AGENTS_HUB_NO_AUTOSTART: '1',
      AGENTS_HUB_URL: 'http://127.0.0.1:5050',
      AGENTS_HUB_MCP_AGENT: 'cursor',
      AGENTS_HUB_MCP_GRACE_MS: '500',
    });
    assert.equal(env.AGENTS_HUB_PORT, 5050);
    assert.equal(env.AGENTS_HUB_HOME, '/tmp/hub-teste');
    assert.equal(env.AGENTS_HUB_NO_AUTOSTART, '1');
    assert.equal(env.AGENTS_HUB_URL, 'http://127.0.0.1:5050');
    assert.equal(env.AGENTS_HUB_MCP_AGENT, 'cursor');
    assert.equal(env.AGENTS_HUB_MCP_GRACE_MS, 500);
  });

  test('AGENTS_HUB_NO_AUTOSTART fora de {0,1} é rejeitado', () => {
    assert.throws(() => readHubEnv({ AGENTS_HUB_NO_AUTOSTART: 'sim' }));
  });
});
