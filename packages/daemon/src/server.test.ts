import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { statusFor } from './server.js';

/**
 * Regressão do achado 1 (MÉDIO) de auditoria: `ADAPTER_FAILURE` caía no
 * `default: 400` de `statusFor`, classificando como erro de CLIENTE algo que
 * é sempre falha de execução do adapter/processo (agente não sobe, upstream
 * HTTP não-2xx, "opencode serve" morreu antes de responder — ver
 * `packages/adapters/src/process-adapter.ts` e
 * `packages/adapters/src/opencode/adapter.ts`, nenhum lançamento de
 * `ADAPTER_FAILURE` depende do payload de quem chamou).
 *
 * 502 (Bad Gateway) é o código correto: falha de um serviço upstream, o que
 * é semanticamente o que o adapter representa aqui para o cliente HTTP.
 */
describe('statusFor', () => {
  test('ADAPTER_FAILURE mapeia para 502 (falha upstream), não 400 (erro de cliente)', () => {
    assert.equal(statusFor('ADAPTER_FAILURE'), 502);
  });

  test('códigos desconhecidos continuam caindo no default 400', () => {
    assert.equal(statusFor('ALGO_QUE_NAO_EXISTE'), 400);
  });
});
