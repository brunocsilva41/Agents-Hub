import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, test } from 'node:test';
import { guardRequest } from './guard.js';

const ESPERADO = { host: '127.0.0.1', port: 4747 };

function req(
  method: string,
  headers: Record<string, string | undefined>,
): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

/**
 * Estes testes existem porque a falha que eles cobrem foi confirmada rodando
 * contra o daemon de verdade: um POST com `Origin` de outro site e
 * `Content-Type: text/plain` criava recurso e devolvia 201.
 */
describe('guarda de borda — o que precisa passar', () => {
  test('a CLI e o MCP server passam: cliente fora do navegador não manda Origin', () => {
    const v = guardRequest(
      req('POST', { host: '127.0.0.1:4747', 'content-type': 'application/json' }),
      ESPERADO,
    );
    assert.equal(v.ok, true);
  });

  test('a Web UI passa: é servida por este mesmo daemon, logo mesma origem', () => {
    const v = guardRequest(
      req('POST', {
        host: '127.0.0.1:4747',
        origin: 'http://127.0.0.1:4747',
        'content-type': 'application/json',
      }),
      ESPERADO,
    );
    assert.equal(v.ok, true);
  });

  test('localhost e 127.0.0.1 são a mesma coisa para a guarda', () => {
    const v = guardRequest(
      req('GET', { host: 'localhost:4747', origin: 'http://localhost:4747' }),
      ESPERADO,
    );
    assert.equal(v.ok, true);
  });

  test('GET sem corpo não exige content-type', () => {
    assert.equal(guardRequest(req('GET', { host: '127.0.0.1:4747' }), ESPERADO).ok, true);
  });

  test('charset no content-type não invalida', () => {
    const v = guardRequest(
      req('POST', {
        host: '127.0.0.1:4747',
        'content-type': 'application/json; charset=utf-8',
      }),
      ESPERADO,
    );
    assert.equal(v.ok, true);
  });
});

describe('guarda de borda — o que precisa ser barrado', () => {
  test('CSRF por formulário: página remota com content-type de form', () => {
    const v = guardRequest(
      req('POST', {
        host: '127.0.0.1:4747',
        origin: 'https://site-malicioso.exemplo',
        'content-type': 'text/plain',
      }),
      ESPERADO,
    );
    assert.equal(v.ok, false);
    assert.equal(v.status, 403);
  });

  test('mesmo sem Origin, corpo que não é JSON é recusado', () => {
    const v = guardRequest(
      req('POST', {
        host: '127.0.0.1:4747',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      ESPERADO,
    );
    assert.equal(v.ok, false);
    assert.equal(v.status, 415, 'formulário HTML só consegue mandar estes content-types');
  });

  test('POST sem content-type nenhum é recusado', () => {
    const v = guardRequest(req('POST', { host: '127.0.0.1:4747' }), ESPERADO);
    assert.equal(v.ok, false);
  });

  test('DNS rebinding: domínio do atacante resolvendo para 127.0.0.1', () => {
    const v = guardRequest(
      req('POST', { host: 'rebind.exemplo:4747', 'content-type': 'application/json' }),
      ESPERADO,
    );
    assert.equal(v.ok, false);
    assert.match(String(v.reason), /rebinding/);
  });

  // NÃO afrouxe isto para aceitar qualquer porta loopback.
  //
  // A tentação aparece porque em desenvolvimento a Web UI é servida pelo Vite
  // na 4748, e o navegador manda `Origin: http://localhost:4748` em todo POST
  // — inclusive de mesma origem. Toda ação de escrita do painel batia em 403.
  //
  // Aceitar qualquer porta local resolveria, e abriria um buraco: um XSS em
  // QUALQUER outro servidor de desenvolvimento no ar na máquina passaria a
  // dirigir o Hub, que roda agentes com todo o privilégio do usuário.
  //
  // A correção certa está em `packages/web/vite.config.ts`: o proxy reescreve
  // o `Origin` para a origem do daemon, porque a requisição de fato vem da
  // interface dele. A guarda continua estrita.
  test('origem de outra porta local também é outra origem', () => {
    const v = guardRequest(
      req('POST', {
        host: '127.0.0.1:4747',
        origin: 'http://127.0.0.1:3000',
        'content-type': 'application/json',
      }),
      ESPERADO,
    );
    assert.equal(v.ok, false);
  });

  test('extensão de navegador com origem própria é barrada', () => {
    const v = guardRequest(
      req('POST', {
        host: '127.0.0.1:4747',
        origin: 'chrome-extension://abcdefghijklmnop',
        'content-type': 'application/json',
      }),
      ESPERADO,
    );
    assert.equal(v.ok, false);
  });

  test('cabeçalho duplicado não driba a checagem', () => {
    const v = guardRequest(
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4747',
          origin: ['https://site-malicioso.exemplo', 'http://127.0.0.1:4747'],
          'content-type': 'application/json',
        },
      } as unknown as IncomingMessage,
      ESPERADO,
    );
    assert.equal(v.ok, false, 'a primeira origem é a que vale, não a mais conveniente');
  });
});
