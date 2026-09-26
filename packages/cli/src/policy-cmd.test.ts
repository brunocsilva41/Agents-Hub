import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { definirCaminho, formatarEntrada, interpretarValor, removerCaminho } from './policy-cmd.js';

describe('hub policy / hub audit — auxiliares (item 1.10)', () => {
  test('interpretarValor: JSON quando dá, texto quando não', () => {
    assert.equal(interpretarValor('2'), 2);
    assert.equal(interpretarValor('true'), true);
    assert.equal(interpretarValor('null'), null);
    assert.deepEqual(interpretarValor('["a","b"]'), ['a', 'b']);
    assert.equal(interpretarValor('approve'), 'approve');
    assert.equal(interpretarValor('npm test'), 'npm test');
  });

  test('definirCaminho cria os objetos intermediários sem apagar irmãos', () => {
    const doc: Record<string, unknown> = { defaultBudget: { tokens: 10 } };
    definirCaminho(doc, 'defaultBudget.usd', 2);
    definirCaminho(doc, 'risk.exec', 'approve');
    assert.deepEqual(doc, { defaultBudget: { tokens: 10, usd: 2 }, risk: { exec: 'approve' } });
  });

  test('removerCaminho apaga o campo e os pais que ficaram vazios', () => {
    const doc: Record<string, unknown> = { risk: { exec: 'approve' }, defaultBudget: { usd: 1, tokens: 2 } };
    removerCaminho(doc, 'risk.exec');
    removerCaminho(doc, 'defaultBudget.usd');
    removerCaminho(doc, 'nao.existe');
    assert.deepEqual(doc, { defaultBudget: { tokens: 2 } });
  });

  test('formatarEntrada mostra autor, tipo, decisão e motivo', () => {
    const linha = formatarEntrada({
      id: 'aud_1',
      ts: '2026-09-26T10:00:00.000Z',
      actor: 'cli:bruno',
      kind: 'approval.resolved',
      sessionId: 'ses_1',
      projectId: null,
      approvalId: 'apv_1',
      action: 'Bash: git push',
      decision: 'denied',
      risk: null,
      reason: 'não agora',
      detail: {},
    });
    // Sem depender das cores do terminal.
    const limpa = linha.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(limpa, /2026-09-26 10:00:00 cli:bruno approval\.resolved denied/);
    assert.match(limpa, /Bash: git push/);
    assert.match(limpa, /não agora/);
  });
});
