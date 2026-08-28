import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AdoptSessionSchema,
  ApprovalIdSchema,
  CancelSchema,
  CreateProjectSchema,
  ResolveApprovalSchema,
  SendMessageSchema,
  SessionIdSchema,
  StartSessionSchema,
  inteiroOpcional,
} from './http-schemas.js';

describe('ids de rota', () => {
  test('aceita id gerado pelo Hub', () => {
    assert.equal(SessionIdSchema.safeParse('ses_dd3b39062941461faea543eb').success, true);
  });

  test('recusa caminho disfarçado de id', () => {
    for (const lixo of ['../../etc/passwd', 'ses_../x', '', 'tsk_123', 'DROP TABLE']) {
      assert.equal(SessionIdSchema.safeParse(lixo).success, false, `deveria recusar: ${lixo}`);
    }
  });

  test('não confunde prefixo de um tipo com o de outro', () => {
    assert.equal(ApprovalIdSchema.safeParse('ses_abc123').success, false);
  });
});

describe('corpos das rotas', () => {
  test('campo desconhecido é recusado, não ignorado em silêncio', () => {
    const r = CreateProjectSchema.safeParse({ path: 'C:/tmp', evil: 'x' });
    assert.equal(r.success, false, 'strict evita que um typo passe despercebido');
  });

  test('mensagem vazia não vira turno', () => {
    assert.equal(SendMessageSchema.safeParse({ text: '' }).success, false);
  });

  test('mensagem tem teto: cliente com bug não empurra megabytes ao agente', () => {
    assert.equal(SendMessageSchema.safeParse({ text: 'x'.repeat(200_001) }).success, false);
  });

  test('decisão de aprovação só aceita os dois valores possíveis', () => {
    assert.equal(ResolveApprovalSchema.safeParse({ decision: 'approved' }).success, true);
    assert.equal(ResolveApprovalSchema.safeParse({ decision: 'talvez' }).success, false);
  });

  test('cancelar sem motivo é válido — é o caso comum', () => {
    assert.equal(CancelSchema.safeParse({}).success, true);
  });

  test('orçamento negativo ou absurdo é recusado na borda', () => {
    assert.equal(
      AdoptSessionSchema.safeParse({ agentId: 'claude', budget: { usd: -5 } }).success,
      false,
    );
    assert.equal(
      AdoptSessionSchema.safeParse({ agentId: 'claude', budget: { usd: 999_999 } }).success,
      false,
    );
  });

  test('início de sessão exige projeto e brief', () => {
    assert.equal(
      StartSessionSchema.safeParse({ projectId: 'prj_abc123', brief: { agent: 'codex' } }).success,
      true,
    );
    assert.equal(StartSessionSchema.safeParse({ projectId: 'prj_abc123' }).success, false);
  });
});

describe('query params', () => {
  test('lixo vira ausência em vez de NaN chegando ao SQL', () => {
    assert.equal(inteiroOpcional('abc', 100), undefined);
    assert.equal(inteiroOpcional('-5', 100), undefined);
    assert.equal(inteiroOpcional(null, 100), undefined);
  });

  test('valor acima do teto é aparado, não recusado', () => {
    assert.equal(inteiroOpcional('999999', 5000), 5000);
  });

  test('valor normal passa inteiro', () => {
    assert.equal(inteiroOpcional('42', 5000), 42);
  });
});
