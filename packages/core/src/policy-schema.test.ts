import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_POLICY,
  narrowestDecision,
  PartialPolicyDocumentSchema,
  PolicyDocumentSchema,
  PolicyEngine,
  type PolicyDocument,
} from './policy.js';

/**
 * Vistoria 2026-09-25, R09-12: schemas de política aceitavam valores sem
 * sentido e `risk` parcial caía em fail-open.
 */
describe('R09-12: faixas e chaves da política', () => {
  const recusa = (layer: unknown): void => {
    assert.equal(PartialPolicyDocumentSchema.safeParse(layer).success, false, JSON.stringify(layer));
  };

  test('valores numéricos absurdos são recusados', () => {
    recusa({ maxDepth: -1 });
    recusa({ maxDepth: 1.5 });
    recusa({ maxConcurrency: 0 });
    recusa({ maxConcurrency: 0.5 });
    recusa({ maxConcurrencyPerAgent: -2 });
    recusa({ taskTimeoutSeconds: 0 });
    recusa({ sessionTimeoutSeconds: Number.POSITIVE_INFINITY });
    recusa({ heartbeatTimeoutSeconds: Number.NaN });
    recusa({ defaultBudget: { usd: -5 } });
    recusa({ defaultBudget: { tokens: Number.POSITIVE_INFINITY } });
    recusa({ retries: { max: -1 } });
    recusa({ retries: { max: 1.5 } });
    recusa({ retries: { backoffMs: -10 } });
    recusa({ validation: { commandTimeoutSeconds: 0 } });
  });

  test('chave com erro de digitação é recusada em qualquer nível', () => {
    recusa({ maxDepht: 2 });
    recusa({ defaultBudget: { uds: 1 } });
    recusa({ retries: { maximo: 1 } });
    recusa({ validation: { review: { enable: true } } });
    recusa({ risk: { escalte: 'allow' } });
  });

  test('valores com sentido continuam aceitos (inclusive os limites da faixa)', () => {
    const ok = PartialPolicyDocumentSchema.safeParse({
      maxDepth: 0,
      maxConcurrency: 1,
      defaultBudget: { usd: 0 },
      retries: { max: 0, backoffMs: 0 },
      risk: { read: 'allow' },
    });
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
    assert.equal(PolicyDocumentSchema.safeParse(DEFAULT_POLICY).success, true);
  });

  test('política COMPLETA exige os seis níveis de risco', () => {
    const semEscalate = { ...DEFAULT_POLICY, risk: { read: 'allow' } };
    assert.equal(PolicyDocumentSchema.safeParse(semEscalate).success, false);
  });

  test('nível ausente no mapa decide `approve`, não o overlay do modo (fail-open)', () => {
    const furada = {
      ...DEFAULT_POLICY,
      risk: { read: 'allow', write: 'allow', exec: 'allow' },
    } as unknown as PolicyDocument;
    const engine = new PolicyEngine(furada);
    const v = engine.decide(
      { kind: 'command', command: 'curl https://exemplo.invalido' },
      { workdir: process.cwd(), mode: 'autonomous' },
    );
    assert.equal(v.risk, 'escalate');
    assert.equal(v.decision, 'approve');
  });

  test('narrowestDecision e intersect tratam decisão ausente como `approve`', () => {
    assert.equal(narrowestDecision(undefined as never, 'allow'), 'approve');
    assert.equal(narrowestDecision('allow', undefined as never), 'approve');
    assert.equal(narrowestDecision(undefined as never, 'deny'), 'deny');
    const pai = new PolicyEngine({
      ...DEFAULT_POLICY,
      risk: { read: 'allow' } as PolicyDocument['risk'],
    });
    const filho = pai.intersect({
      ...DEFAULT_POLICY,
      risk: { ...DEFAULT_POLICY.risk, escalate: 'allow' },
    });
    assert.equal(filho.policy.risk.escalate, 'approve');
    assert.equal(filho.policy.risk.irreversible, 'approve');
  });
});
