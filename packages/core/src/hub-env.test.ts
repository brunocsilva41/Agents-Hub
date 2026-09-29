import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HubError } from './errors.js';
import { readHubEnv } from './hub-env.js';

/**
 * R02-10 (resíduo): `AGENTS_HUB_MCP_HEARTBEAT_MS` era lida com `Number()` cru
 * no MCP server — `abc` ou `0` voltavam ao padrão sem aviso, e um valor acima
 * do teto do `setInterval` (2^31-1) é trocado pelo Node por 1 ms: o sinal de
 * vida viraria uma rajada contra o daemon. Agora passa pelo mesmo esquema das
 * outras `AGENTS_HUB_*`.
 */
describe('readHubEnv — AGENTS_HUB_MCP_HEARTBEAT_MS', () => {
  test('ausente fica indefinida (quem lê aplica o padrão)', () => {
    assert.equal(readHubEnv({}).AGENTS_HUB_MCP_HEARTBEAT_MS, undefined);
  });

  test('inteiro positivo é aceito como número', () => {
    assert.equal(
      readHubEnv({ AGENTS_HUB_MCP_HEARTBEAT_MS: '15000' }).AGENTS_HUB_MCP_HEARTBEAT_MS,
      15000,
    );
  });

  test('não numérico, zero, negativo, fracionário ou acima do teto do setInterval é recusado', () => {
    for (const valor of ['abc', '0', '-5', '1.5', '2147483648']) {
      assert.throws(
        () => readHubEnv({ AGENTS_HUB_MCP_HEARTBEAT_MS: valor }),
        (err: unknown) =>
          err instanceof HubError &&
          err.code === 'HUB_CONFIG_INVALID' &&
          err.message.includes('AGENTS_HUB_MCP_HEARTBEAT_MS'),
        `"${valor}" deveria ser recusado`,
      );
    }
  });
});
