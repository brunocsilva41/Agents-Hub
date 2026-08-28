import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { interpretarRevisao } from './review-verdict.js';

/**
 * A leitura do veredito é o ponto onde a revisão cruzada pode fazer estrago:
 * interpretar mal reprova trabalho bom e manda o pipeline reciclar por nada.
 */
describe('leitura do veredito da revisão', () => {
  test('reprovação explícita reprova', () => {
    const r = interpretarRevisao('REPROVADO — o critério de idempotência não foi atendido', 'codex');
    assert.equal(r.passed, false);
    assert.match(String(r.checks[0]?.detail), /idempotência/);
  });

  test('aprovação explícita aprova', () => {
    assert.equal(interpretarRevisao('APROVADO, os testes cobrem o caso novo', 'codex').passed, true);
  });

  test('acento e caixa não mudam o veredito', () => {
    assert.equal(interpretarRevisao('reprovado: faltou tratar o erro', 'codex').passed, false);
    assert.equal(interpretarRevisao('Reprovada a mudança', 'codex').passed, false);
  });

  test('resposta ambígua APROVA e diz que foi ambígua', () => {
    const r = interpretarRevisao('Acho que está mais ou menos ok, mas não sei.', 'codex');
    assert.equal(r.passed, true, 'ambiguidade não é evidência de defeito');
    assert.match(String(r.checks[0]?.detail), /ambíguo/);
  });

  test('resposta vazia não reprova', () => {
    assert.equal(interpretarRevisao('', 'codex').passed, true);
  });

  test('texto que cita as duas palavras não reprova por acidente', () => {
    const r = interpretarRevisao(
      'APROVADO. Não reprovado em nenhum critério, tudo certo.',
      'codex',
    );
    assert.equal(r.passed, true, 'a presença de "aprovado" desempata a favor de não reciclar');
  });

  test('o revisor é identificado no check — auditoria precisa saber quem revisou', () => {
    assert.match(String(interpretarRevisao('APROVADO', 'claude').checks[0]?.name), /claude/);
  });

  test('resposta longa é resumida', () => {
    const r = interpretarRevisao(`REPROVADO ${'x'.repeat(2000)}`, 'codex');
    assert.ok(String(r.checks[0]?.detail).length < 500);
  });
});
