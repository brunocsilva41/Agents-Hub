import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { filtrarEnvDeProjeto, variaveisLidasPeloAgente, variavelDoAgente } from './agent-env.js';

describe('variáveis que cada agente lê de fato', () => {
  test('claude lê ANTHROPIC_*, nunca OPENAI_* nem MODEL', () => {
    const nomes = variaveisLidasPeloAgente('claude').map((v) => v.nome);
    assert.ok(nomes.includes('ANTHROPIC_BASE_URL'));
    assert.ok(!nomes.some((n) => n.startsWith('OPENAI_')));
    assert.ok(!nomes.includes('MODEL'));
  });

  test('nenhum agente anuncia a variável genérica MODEL (sem consumidor em adapter nenhum)', () => {
    for (const id of [
      'claude',
      'openclaude',
      'antigravity',
      'codex',
      'opencode',
      'kimi',
      'copilot',
      'cursor',
      'mimo',
    ]) {
      assert.ok(!variaveisLidasPeloAgente(id).some((v) => v.nome === 'MODEL'), id);
    }
  });

  test('toda variável da tabela passa pela lista de permissão', () => {
    // Uma variável que o filtro recusa seria gravada e descartada ao carregar:
    // outro controle fantasma.
    for (const id of ['claude', 'openclaude', 'antigravity', 'codex', 'opencode', 'kimi']) {
      for (const v of variaveisLidasPeloAgente(id)) {
        assert.deepEqual(filtrarEnvDeProjeto({ [v.nome]: 'x' }).recusadas, [], `${id}:${v.nome}`);
      }
    }
  });

  test('agente sem variável conhecida devolve vazio/null', () => {
    assert.deepEqual(variaveisLidasPeloAgente('copilot'), []);
    assert.equal(variavelDoAgente('codex', 'model'), null);
    assert.equal(variavelDoAgente('antigravity', 'model'), 'GEMINI_MODEL');
  });
});

describe('ambiente que o projeto pode passar ao agente', () => {
  test('variáveis de provedor passam', () => {
    const { aceitas, recusadas } = filtrarEnvDeProjeto({
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_API_KEY: 'ollama',
      OLLAMA_HOST: 'http://localhost:11434',
    });
    assert.equal(aceitas['OPENAI_BASE_URL'], 'http://localhost:11434/v1');
    assert.equal(Object.keys(aceitas).length, 3);
    assert.deepEqual(recusadas, []);
  });

  test('NODE_OPTIONS é recusada — seria execução arbitrária', () => {
    // `.agents-hub/config.yaml` é versionado. Um repositório clonado com
    // `NODE_OPTIONS=--require ./payload.js` executaria código na máquina de
    // quem clonou, no instante em que o Hub lançasse qualquer agente Node.
    const { aceitas, recusadas } = filtrarEnvDeProjeto({
      NODE_OPTIONS: '--require ./payload.js',
    });
    assert.deepEqual(aceitas, {});
    assert.deepEqual(recusadas, ['NODE_OPTIONS']);
  });

  test('PATH é recusada — trocaria o binário do agente', () => {
    const { aceitas } = filtrarEnvDeProjeto({ PATH: '/tmp/fake' });
    assert.deepEqual(aceitas, {});
  });

  test('outros vetores conhecidos também caem', () => {
    const { aceitas, recusadas } = filtrarEnvDeProjeto({
      LD_PRELOAD: '/tmp/x.so',
      PYTHONSTARTUP: '/tmp/x.py',
      GIT_SSH_COMMAND: 'sh -c evil',
      BROWSER: 'evil',
    });
    assert.deepEqual(aceitas, {});
    assert.equal(recusadas.length, 4);
  });

  test('AGENTS_HUB_ não passa: o projeto não pode se passar por outra sessão', () => {
    // É o namespace que o Hub usa para dizer ao agente em que sessão ele está.
    // Deixar o projeto sobrescrever permitiria forjar identidade no gate.
    const { aceitas } = filtrarEnvDeProjeto({ AGENTS_HUB_SESSION_ID: 'ses_outra' });
    assert.deepEqual(aceitas, {});
  });

  test('valor que não é string é recusado, não convertido', () => {
    // Converter viraria "[object Object]" no ambiente do processo.
    const { aceitas, recusadas } = filtrarEnvDeProjeto({
      OPENAI_BASE_URL: { url: 'x' },
    });
    assert.deepEqual(aceitas, {});
    assert.deepEqual(recusadas, ['OPENAI_BASE_URL']);
  });

  test('a recusa é reportada, não silenciosa', () => {
    // Quem escreveu PATH no config precisa descobrir que não teve efeito ali,
    // e não horas depois achando que a configuração estava valendo.
    const { recusadas } = filtrarEnvDeProjeto({ PATH: '/x', OPENAI_API_KEY: 'k' });
    assert.deepEqual(recusadas, ['PATH']);
  });
});
