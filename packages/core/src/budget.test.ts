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

  test('isWarning dispara quando a pressão atinge o limiar configurado', () => {
    const ledger = new BudgetLedger('ses_root', { usd: 10, tokens: 1000, seconds: 100 });
    ledger.charge({ usd: 7.9 });
    assert.equal(ledger.snapshot(0.8).isWarning, false);

    ledger.charge({ usd: 0.2 }); // total 8.1 / 10 = 81%
    assert.equal(ledger.snapshot(0.8).isWarning, true);
    assert.equal(ledger.snapshot(0.8).exhausted, false);
  });

  // ─── Fase 3.2 (vistoria 2026-09-25, relatório 09) ─────────────────────────

  test('gasto do filho sai da fatia dele: reserva 6, gasta 5 => resta 5, sem exhausted falso', () => {
    const ledger = new BudgetLedger('ses_root', { usd: 10, tokens: 1e6, seconds: 3600 });
    ledger.reserve('child', { usd: 6 });
    const s = ledger.charge({ usd: 5 }, 'child');

    assert.equal(s.consumed.usd, 5);
    assert.equal(s.reserved.usd, 1, 'sobrou 1 da fatia');
    assert.equal(s.remaining.usd, 4);
    assert.equal(s.exhausted, false, 'gastou 5 de 10');
    assert.equal(Math.round(s.pressure * 100), 60, 'consumido + fatia não gasta, sem contar duas vezes');
  });

  test('tabela: consumo + fatia não gasta nunca passa de max(pedido, gasto) por task', () => {
    const casos: Array<{ pedido: number; gastos: number[]; restante: number; esgotado: boolean }> = [
      { pedido: 6, gastos: [], restante: 4, esgotado: false },
      { pedido: 6, gastos: [2, 2], restante: 4, esgotado: false },
      { pedido: 6, gastos: [6], restante: 4, esgotado: false },
      { pedido: 6, gastos: [5, 3], restante: 2, esgotado: false }, // passou da fatia: 8
      { pedido: 10, gastos: [], restante: 0, esgotado: false }, // tudo reservado não é esgotado
      { pedido: 10, gastos: [10], restante: 0, esgotado: true },
      { pedido: 4, gastos: [11], restante: -1, esgotado: true },
    ];
    for (const c of casos) {
      const ledger = new BudgetLedger('r', { usd: 10, tokens: 1e6, seconds: 3600 });
      ledger.reserve('t', { usd: c.pedido });
      let s = ledger.snapshot();
      for (const g of c.gastos) s = ledger.charge({ usd: g }, 't');
      assert.equal(s.remaining.usd, c.restante, `pedido ${c.pedido}, gastos ${c.gastos.join('+')}`);
      assert.equal(s.exhausted, c.esgotado, `pedido ${c.pedido}, gastos ${c.gastos.join('+')}`);
    }
  });

  test('propriedade: em qualquer sequência, a soma nunca conta a fatia do filho duas vezes', () => {
    let semente = 42;
    const aleatorio = (): number => {
      semente = (semente * 1103515245 + 12345) % 2 ** 31;
      return semente / 2 ** 31;
    };
    for (let rodada = 0; rodada < 200; rodada += 1) {
      const ledger = new BudgetLedger('r', { usd: 100, tokens: 1e9, seconds: 1e6 });
      const pedido = Math.round(aleatorio() * 50);
      ledger.reserve('t', { usd: pedido });
      let gasto = 0;
      for (let i = 0; i < 5; i += 1) {
        const g = Math.round(aleatorio() * 10);
        gasto += g;
        const s = ledger.charge({ usd: g }, 't');
        const esperado = 100 - Math.max(pedido, gasto);
        assert.ok(
          Math.abs(s.remaining.usd - esperado) < 1e-9,
          `pedido ${pedido}, gasto ${gasto}: restante ${s.remaining.usd}, esperado ${esperado}`,
        );
      }
    }
  });

  test('NaN, Infinity e negativos não mexem no consumo nem desligam o teto', () => {
    const ledger = new BudgetLedger('r', { usd: 10, tokens: 1000, seconds: 100 });
    for (const lixo of [Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      ledger.charge({ usd: lixo, tokens: lixo, seconds: lixo });
      ledger.estimate('t', { usd: lixo });
    }
    let s = ledger.snapshot();
    assert.equal(s.consumed.usd, 0);
    assert.equal(s.consumed.tokens, 0);
    assert.equal(Number.isNaN(s.pressure), false);

    s = ledger.charge({ usd: 10 });
    assert.equal(s.exhausted, true, 'o teto continua valendo depois de lixo');
  });

  test('reserve duplicado do mesmo taskId substitui a fatia, e um release devolve tudo', () => {
    const ledger = new BudgetLedger('r', { usd: 10, tokens: 1e6, seconds: 3600 });
    ledger.reserve('t1', { usd: 4 });
    ledger.reserve('t1', { usd: 4 });
    assert.equal(ledger.snapshot().reserved.usd, 4, 'não soma as duas');
    ledger.release('t1');
    assert.equal(ledger.snapshot().reserved.usd, 0, 'nada preso até reiniciar o daemon');
  });

  test('reserve duplicado que não cabe mantém a fatia anterior', () => {
    const ledger = new BudgetLedger('r', { usd: 10, tokens: 1e6, seconds: 3600 });
    ledger.reserve('t1', { usd: 4 });
    assert.throws(() => ledger.reserve('t1', { usd: 11 }));
    assert.equal(ledger.snapshot().reserved.usd, 4);
  });

  test('estimativa substitui a anterior e o charge final a apaga (não soma)', () => {
    const ledger = new BudgetLedger('r', { usd: 1, tokens: 1e6, seconds: 3600 });
    ledger.estimate('t', { usd: 0.3 });
    ledger.estimate('t', { usd: 0.5 });
    assert.equal(ledger.snapshot().consumed.usd, 0.5, 'a última estimativa, não 0,8');
    const s = ledger.charge({ usd: 0.4 }, 't');
    assert.equal(s.consumed.usd, 0.4, 'o final substitui a estimativa');
  });

  test('estimativa aberta no settle vira consumo (turno morto ainda custou)', () => {
    const ledger = new BudgetLedger('r', limits);
    ledger.reserve('t', { usd: 5 });
    ledger.estimate('t', { usd: 2 });
    const s = ledger.settle('t', { seconds: 30 });
    assert.equal(s.consumed.usd, 2);
    assert.equal(s.reserved.usd, 0);
  });

  test('project calcula burn rate e projeção final corretamente', () => {
    const ledger = new BudgetLedger('ses_root', { usd: 20, tokens: 100_000, seconds: 200 });
    ledger.charge({ usd: 2.0, tokens: 10_000 });

    // Em 20 segundos gastou 2 USD (0.10 USD/seg) -> em 200 segundos projeta 20 USD
    const proj = ledger.project(20, 200);
    assert.equal(proj.burnRateUsdPerSec, 0.1);
    assert.equal(proj.projectedUsd, 20);
    assert.equal(proj.projectedTokens, 100_000);
  });
});

