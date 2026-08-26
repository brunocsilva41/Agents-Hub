import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { BudgetLedger } from './budget.js';
import { isHubError } from './errors.js';

const limits = { usd: 10, tokens: 100_000, seconds: 600 };

describe('BudgetLedger', () => {
  test('reserva sai do saldo restante', () => {
    const ledger = new BudgetLedger('ses_root', limits);
    ledger.reserve('tsk_1', { usd: 4 });
    assert.equal(ledger.snapshot().remaining.usd, 6);
  });

  test('filho não pode reservar mais do que o pai tem', () => {
    const ledger = new BudgetLedger('ses_root', limits);
    ledger.reserve('tsk_1', { usd: 8 });

    assert.throws(
      () => ledger.reserve('tsk_2', { usd: 5 }),
      (err: unknown) => isHubError(err) && err.code === 'BUDGET_EXCEEDED',
      'a segunda reserva deveria estourar o orçamento da raiz',
    );
  });

  test('dimensão não pedida reserva zero, liberando fan-out paralelo', () => {
    const ledger = new BudgetLedger('ses_root', limits);
    // Um fan-out de três agentes, cada um pedindo só teto de custo.
    ledger.reserve('tsk_1', { usd: 1 });
    ledger.reserve('tsk_2', { usd: 1 });
    ledger.reserve('tsk_3', { usd: 1 });

    const snapshot = ledger.snapshot();
    assert.equal(snapshot.reserved.tokens, 0, 'ninguém sequestra o orçamento de tokens');
    assert.equal(snapshot.remaining.tokens, limits.tokens);
    assert.equal(snapshot.remaining.usd, 7);
  });

  test('settle converte reserva em consumo e devolve a sobra', () => {
    const ledger = new BudgetLedger('ses_root', limits);
    ledger.reserve('tsk_1', { usd: 6 });
    const snapshot = ledger.settle('tsk_1', { usd: 1.5 });

    assert.equal(snapshot.consumed.usd, 1.5);
    assert.equal(snapshot.reserved.usd, 0);
    assert.equal(snapshot.remaining.usd, 8.5, 'os 4,5 não usados voltam para o fluxo');
  });

  test('exhausted quando qualquer dimensão zera', () => {
    const ledger = new BudgetLedger('ses_root', limits);
    ledger.charge({ tokens: 100_000 });
    assert.equal(ledger.snapshot().exhausted, true, 'tokens acabaram, mesmo com USD sobrando');
  });

  test('pressure reflete a dimensão mais apertada', () => {
    const ledger = new BudgetLedger('ses_root', limits);
    ledger.charge({ usd: 1, tokens: 90_000 });
    assert.equal(Math.round(ledger.snapshot().pressure * 100), 90);
  });

  test('raiseLimits libera a task travada sem perder o consumo', () => {
    const ledger = new BudgetLedger('ses_root', { usd: 1, tokens: 10, seconds: 10 });
    ledger.charge({ usd: 1 });
    assert.equal(ledger.snapshot().exhausted, true);

    ledger.raiseLimits({ usd: 5 });
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.exhausted, false);
    assert.equal(snapshot.consumed.usd, 1, 'o já gasto continua contabilizado');
  });
});
