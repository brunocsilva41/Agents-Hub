import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { textoDe } from './texto.js';

describe('textoDe', () => {
  test('objeto vira JSON, não "[object Object]"', () => {
    assert.equal(textoDe({ tipo: 'rate_limit', ate: 3 }), '{"tipo":"rate_limit","ate":3}');
    assert.equal(textoDe(['a', 1]), '["a",1]');
  });

  test('primitivos como String(); null/undefined viram o vazio pedido', () => {
    assert.equal(textoDe('x'), 'x');
    assert.equal(textoDe(0), '0');
    assert.equal(textoDe(false), 'false');
    assert.equal(textoDe(10n), '10');
    assert.equal(textoDe(null), '');
    assert.equal(textoDe(undefined, '?'), '?');
  });

  test('referência circular não lança', () => {
    const a: Record<string, unknown> = {};
    a['a'] = a;
    assert.equal(textoDe(a), '[objeto]');
  });
});
