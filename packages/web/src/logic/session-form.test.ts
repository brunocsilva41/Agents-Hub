import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lerTeto, semErros, validarSessao, type EntradaSessao } from './session-form.js';

const AGENTES = [
  { id: 'claude', name: 'Claude Code', probe: null },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    probe: {
      agentId: 'cursor',
      installed: false,
      version: null,
      binPath: null,
      error: 'binário não encontrado',
      checkedAt: '2026-09-28T00:00:00.000Z',
    },
  },
];

function entrada(mudar: Partial<EntradaSessao> = {}): EntradaSessao {
  return {
    agentId: 'claude',
    agentes: AGENTES,
    objetivo: 'Corrigir o login',
    projectId: 'prj_alfa',
    delegando: false,
    tetoUsd: '2.00',
    ...mudar,
  };
}

describe('Nova Sessão: validação (R03-11)', () => {
  test('formulário completo com agente instalado é válido', () => {
    assert.equal(semErros(validarSessao(entrada())), true);
  });

  test('agente NÃO instalado pré-selecionado não pode ser enviado, com mensagem clara', () => {
    const erros = validarSessao(entrada({ agentId: 'cursor' }));
    assert.equal(semErros(erros), false);
    assert.match(erros.agente ?? '', /Cursor Agent não está instalado/);
  });

  test('agente que não existe na lista é recusado', () => {
    assert.equal(validarSessao(entrada({ agentId: 'fantasma' })).agente, 'Escolha um agente.');
  });

  for (const teto of ['0', '0.00', '-1', 'abc', '', '   ', 'NaN', 'Infinity', '0.05', '51']) {
    test(`teto "${teto}" é inválido e diz a faixa`, () => {
      const erros = validarSessao(entrada({ tetoUsd: teto }));
      assert.equal(semErros(erros), false);
      assert.match(erros.teto ?? '', /US\$ 0\.10 e US\$ 50\.00/);
    });
  }

  test('teto na faixa, inclusive com vírgula decimal, é aceito', () => {
    assert.deepEqual(lerTeto('0.10'), { ok: true, usd: 0.1 });
    assert.deepEqual(lerTeto('1,50'), { ok: true, usd: 1.5 });
    assert.deepEqual(lerTeto('50'), { ok: true, usd: 50 });
  });

  test('sem projeto só vale ao delegar', () => {
    assert.ok(validarSessao(entrada({ projectId: '' })).projeto);
    assert.equal(semErros(validarSessao(entrada({ projectId: '', delegando: true }))), true);
  });

  test('objetivo curto é recusado', () => {
    assert.ok(validarSessao(entrada({ objetivo: '  abc ' })).objetivo);
  });
});
