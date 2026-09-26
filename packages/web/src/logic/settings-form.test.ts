import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentSummary } from '@agents-hub/client';
import {
  camposDeEnvDoAgente,
  chaveEhPermitida,
  estadoInicial,
  extrasDoAgente,
  podeEditar,
  podeSalvar,
  precisaDeBoasVindas,
  reduzirForm,
  valorParaExibir,
  variavelConhecidaDoAgente,
  type EstadoForm,
} from './settings-form.js';

const CTX_A = {
  memory: 'regras de A',
  prompts: { claude: 'prompt de A' },
  env: { codex: { OPENAI_API_KEY: 'sk-segredo-de-A' } },
};

function carregadoEmA(): EstadoForm {
  return reduzirForm(estadoInicial('prj_a'), { tipo: 'carregou', projectId: 'prj_a', ctx: CTX_A });
}

describe('formulário de configurações: troca de projeto e falha de carga', () => {
  test('falha ao carregar B NÃO deixa a config de A na tela nem permite salvar', () => {
    let e = reduzirForm(carregadoEmA(), { tipo: 'trocar-projeto', projectId: 'prj_b' });
    e = reduzirForm(e, { tipo: 'falhou', projectId: 'prj_b', erro: 'HTTP 500' });
    assert.deepEqual(e.ctx, {}, 'ctx de A não pode sobreviver sob o id de B');
    assert.equal(e.status, 'falhou');
    assert.equal(e.erroCarga, 'HTTP 500');
    // Editar não liga "sujo", então "Salvar" continua travado.
    e = reduzirForm(e, { tipo: 'editar', mudar: (c) => ({ ...c, memory: 'x' }) });
    assert.equal(podeEditar(e), false);
    assert.equal(podeSalvar(e), false);
    assert.deepEqual(e.ctx, {});
  });

  test('trocar de projeto limpa o ctx imediatamente, antes da resposta', () => {
    const e = reduzirForm(carregadoEmA(), { tipo: 'trocar-projeto', projectId: 'prj_b' });
    assert.deepEqual(e.ctx, {});
    assert.equal(e.status, 'carregando');
    assert.equal(podeEditar(e), false, 'digitar durante a carga seria sobrescrito pela resposta');
  });

  test('resposta atrasada do projeto anterior é ignorada', () => {
    let e = reduzirForm(carregadoEmA(), { tipo: 'trocar-projeto', projectId: 'prj_b' });
    e = reduzirForm(e, { tipo: 'carregou', projectId: 'prj_a', ctx: CTX_A });
    assert.deepEqual(e.ctx, {});
    e = reduzirForm(e, { tipo: 'carregou', projectId: 'prj_b', ctx: { memory: 'B' } });
    assert.deepEqual(e.ctx, { memory: 'B' });
    assert.equal(podeEditar(e), true);
  });

  test('salvar do projeto anterior que termina depois da troca não contamina o novo', () => {
    let e = reduzirForm(carregadoEmA(), { tipo: 'trocar-projeto', projectId: 'prj_b' });
    e = reduzirForm(e, { tipo: 'carregou', projectId: 'prj_b', ctx: { memory: 'B' } });
    e = reduzirForm(e, { tipo: 'salvou', projectId: 'prj_a', ctx: CTX_A });
    assert.deepEqual(e.ctx, { memory: 'B' });
  });

  test('editar e salvar no caminho feliz', () => {
    let e = reduzirForm(carregadoEmA(), { tipo: 'editar', mudar: (c) => ({ ...c, memory: 'nova' }) });
    assert.equal(podeSalvar(e), true);
    e = reduzirForm(e, { tipo: 'salvou', projectId: 'prj_a', ctx: { memory: 'nova' } });
    assert.equal(e.sujo, false);
    assert.equal(podeSalvar(e), false);
  });

  test('sem projeto não há o que carregar nem salvar', () => {
    const e = estadoInicial('');
    assert.equal(e.status, 'sem-projeto');
    assert.equal(podeEditar(e), false);
  });
});

describe('Modelos locais: só as variáveis que o agente lê', () => {
  test('claude não recebe OPENAI_* nem MODEL', () => {
    const nomes = camposDeEnvDoAgente('claude').map((c) => c.nome);
    assert.ok(!nomes.some((n) => n.startsWith('OPENAI_')), nomes.join());
    assert.ok(!nomes.includes('MODEL'));
    assert.deepEqual(nomes, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']);
  });

  test('codex tem endereço e chave OPENAI_*, mas nenhum campo de modelo', () => {
    const campos = camposDeEnvDoAgente('codex');
    assert.deepEqual(
      campos.map((c) => c.nome),
      ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    );
    assert.ok(!campos.some((c) => c.papel === 'model'));
  });

  test('agente que não lê variável aceita (copilot) não ganha campo nenhum', () => {
    assert.deepEqual(camposDeEnvDoAgente('copilot'), []);
  });

  test('a chave é campo secreto', () => {
    assert.equal(camposDeEnvDoAgente('claude').find((c) => c.papel === 'apiKey')?.secreto, true);
  });

  test('extras excluem os campos fixos DO AGENTE (MODEL gravado antes aparece como extra)', () => {
    const extras = extrasDoAgente(
      { ANTHROPIC_BASE_URL: 'http://x', MODEL: 'legado', OPENAI_API_KEY: 'k' },
      'claude',
    );
    assert.deepEqual(extras.map(([k]) => k).sort(), ['MODEL', 'OPENAI_API_KEY']);
  });

  test('permissão ecoa a regra do daemon', () => {
    assert.equal(chaveEhPermitida('OPENAI_BASE_URL'), true);
    assert.equal(chaveEhPermitida('NODE_OPTIONS'), false);
    assert.equal(chaveEhPermitida('AGENTS_HUB_SESSION_ID'), false);
    assert.equal(chaveEhPermitida(''), false);
  });

  test('valor de chave não aparece em claro na lista de extras', () => {
    assert.equal(valorParaExibir('OPENAI_API_KEY', 'sk-123456789'), '••••6789');
    assert.equal(valorParaExibir('GITHUB_TOKEN', 'ab'), '••••');
    assert.equal(valorParaExibir('OPENAI_BASE_URL', 'http://x'), 'http://x');
  });

  test('variável conhecida: pela tabela ou pelo texto do manifesto', () => {
    const claude = {
      id: 'claude',
      description: 'Claude Code',
      caveats: [],
    } as unknown as AgentSummary;
    assert.equal(variavelConhecidaDoAgente('ANTHROPIC_MODEL', claude), true);
    assert.equal(variavelConhecidaDoAgente('OPENAI_BASE_URL', claude), false);
  });
});

describe('campo de modelo por agente (item 4.3: só quando model.supported)', () => {
  const comModelo = { model: { supported: true, format: 'provider/model' } };
  const semModelo = { model: { supported: false, format: '' } };

  test('agente com suporte ganha "Modelo" que grava MODEL (vira a flag do manifesto)', () => {
    const campos = camposDeEnvDoAgente('opencode', comModelo);
    const modelo = campos.find((c) => c.papel === 'model');
    assert.equal(modelo?.nome, 'MODEL');
    assert.equal(modelo?.viaFlag, true);
    assert.equal(modelo?.formato, 'provider/model');
  });

  test('agente sem suporte não ganha campo de modelo — nem o da variável própria', () => {
    assert.ok(!camposDeEnvDoAgente('claude', semModelo).some((c) => c.papel === 'model'));
    assert.deepEqual(camposDeEnvDoAgente('cursor', semModelo), []);
  });

  test('com suporte, a variável própria de modelo sai dos fixos (um campo só) e vira extra se gravada', () => {
    const nomes = camposDeEnvDoAgente('claude', comModelo).map((c) => c.nome);
    assert.deepEqual(nomes, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'MODEL']);
    const extras = extrasDoAgente({ MODEL: 'opus', ANTHROPIC_MODEL: 'legado' }, 'claude', comModelo);
    assert.deepEqual(extras.map(([k]) => k), ['ANTHROPIC_MODEL']);
  });

  test('daemon sem o campo `model` (anterior ao 4.3): comportamento antigo, sem quebrar', () => {
    assert.deepEqual(
      camposDeEnvDoAgente('claude', {}).map((c) => c.nome),
      ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'],
    );
  });
});

describe('primeira execução', () => {
  test('boas-vindas só depois de carregar e sem projeto nenhum', () => {
    assert.equal(precisaDeBoasVindas(false, 0), false);
    assert.equal(precisaDeBoasVindas(true, 0), true);
    assert.equal(precisaDeBoasVindas(true, 2), false);
  });
});
