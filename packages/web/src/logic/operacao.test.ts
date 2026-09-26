import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentSummary, BudgetSummary, SessionSummary, TaskSummary, WorkflowRunSummary } from '@agents-hub/client';
import {
  diagnosticarAgente,
  execucaoEmCurso,
  formDoOrcamento,
  lerFormOrcamento,
  lerOrcamentoWorkflow,
  motivoDaTarefa,
  podeDesanexar,
  raizDe,
  resumoDaExecucao,
  separarDiff,
} from './operacao.js';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  '+const z = 4;',
  '\\ No newline at end of file',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n');

describe('separarDiff', () => {
  test('um arquivo por cabeçalho, com + e − contados só dentro do hunk', () => {
    const arquivos = separarDiff(PATCH);
    assert.deepEqual(
      arquivos.map((a) => [a.caminho, a.adicoes, a.remocoes, a.binario]),
      [
        ['src/a.ts', 2, 1, false],
        ['img.png', 0, 0, true],
      ],
    );
    // `--- a/` e `+++ b/` são cabeçalho, não remoção/adição.
    const tipos = arquivos[0]!.linhas.map((l) => l.tipo);
    assert.deepEqual(tipos, ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add', 'meta']);
  });

  test('CRLF e patch sem cabeçalho não somem', () => {
    const arquivos = separarDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n');
    assert.equal(arquivos.length, 1);
    assert.equal(arquivos[0]!.caminho, '(patch)');
    assert.equal(arquivos[0]!.adicoes, 1);
    assert.equal(arquivos[0]!.linhas.at(-1)!.texto, '+b');
  });

  test('vazio: nenhum arquivo', () => {
    assert.deepEqual(separarDiff(''), []);
  });
});

const ORC: BudgetSummary = {
  limits: { usd: 2, tokens: 500000, seconds: 3600 },
  consumed: { usd: 0.84, tokens: 96426, seconds: 812 },
  reserved: { usd: 0.5, tokens: 0, seconds: 0 },
  remaining: { usd: 0.66, tokens: 403574, seconds: 2788 },
  pressure: 0.67,
  exhausted: false,
};

describe('orçamento editável', () => {
  test('o formulário nasce com o teto atual e, sem mudança, não manda nada', () => {
    const f = formDoOrcamento(ORC);
    assert.deepEqual(f, { usd: '2', tokens: '500000', minutos: '60' });
    const r = lerFormOrcamento(f, ORC);
    assert.equal(r.ok, false);
  });

  test('só os campos alterados vão no corpo; minutos viram segundos; vírgula decimal', () => {
    const r = lerFormOrcamento({ usd: '5,5', tokens: '500000', minutos: '90' }, ORC);
    assert.deepEqual(r, { ok: true, limits: { usd: 5.5, seconds: 5400 } });
  });

  test('campo vazio não mexe; baixar acima do gasto é permitido', () => {
    assert.deepEqual(lerFormOrcamento({ usd: '1', tokens: '', minutos: '' }, ORC), { ok: true, limits: { usd: 1 } });
  });

  test('recusa abaixo do já gasto, zero, negativo, texto e tokens fracionários', () => {
    for (const form of [
      { usd: '0.5', tokens: '', minutos: '' },
      { usd: '0', tokens: '', minutos: '' },
      { usd: '-3', tokens: '', minutos: '' },
      { usd: 'abc', tokens: '', minutos: '' },
      { usd: '', tokens: '10.5', minutos: '' },
      { usd: '', tokens: '1000', minutos: '' },
      { usd: '', tokens: '', minutos: '5' },
    ]) {
      const r = lerFormOrcamento(form, ORC);
      assert.equal(r.ok, false, JSON.stringify(form));
    }
    const abaixo = lerFormOrcamento({ usd: '0.5', tokens: '', minutos: '' }, ORC);
    assert.match(abaixo.ok ? '' : abaixo.erro, /já gastou US\$ 0\.8400/);
  });

  test('orçamento do workflow: vazio é sem teto; inválido é erro', () => {
    assert.deepEqual(lerOrcamentoWorkflow(' '), { ok: true });
    assert.deepEqual(lerOrcamentoWorkflow('2,5'), { ok: true, usd: 2.5 });
    assert.equal(lerOrcamentoWorkflow('0').ok, false);
    assert.equal(lerOrcamentoWorkflow('x').ok, false);
  });
});

function sessao(extra: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'ses_a',
    projectId: 'prj_a',
    agentId: 'claude',
    nativeSessionId: null,
    rootId: 'ses_a',
    parentId: null,
    depth: 0,
    state: 'running',
    mode: 'semi',
    isolation: 'none',
    title: null,
    workdir: '/x',
    createdAt: '',
    updatedAt: '',
    endedAt: null,
    ...extra,
  };
}

describe('sessões', () => {
  test('desanexar só aparece para sessão adotada e viva', () => {
    assert.equal(podeDesanexar(sessao({ adopted: true })), true);
    assert.equal(podeDesanexar(sessao({ adopted: true, state: 'completed' })), false);
    assert.equal(podeDesanexar(sessao({ adopted: false })), false);
    // Daemon antigo, sem o campo: não oferece o controle.
    assert.equal(podeDesanexar(sessao({})), false);
  });

  test('orçamento é lido da raiz', () => {
    assert.equal(raizDe(sessao({ id: 'ses_f', rootId: 'ses_r' })), 'ses_r');
  });
});

function tarefa(extra: Partial<TaskSummary>): TaskSummary {
  return {
    id: 'tsk_a',
    sessionId: 'ses_a',
    requesterSessionId: null,
    state: 'working',
    brief: { agent: 'claude', objective: 'x', acceptanceCriteria: [] },
    attempts: [],
    result: null,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

describe('motivoDaTarefa', () => {
  test('erro da última tentativa vence; depois validação; depois o estado', () => {
    assert.equal(
      motivoDaTarefa(tarefa({ state: 'failed', attempts: [{ n: 1, agentId: 'a', outcome: 'x', error: 'caiu' }] })),
      'caiu',
    );
    assert.match(
      motivoDaTarefa(
        tarefa({
          state: 'failed',
          result: {
            summary: '',
            artifacts: [],
            usage: { usd: 0, tokens: 0, seconds: 0 },
            validation: { passed: false, checks: [{ name: 'npm test', passed: false, detail: '3 falhas' }] },
          },
        }),
      ) ?? '',
      /npm test — 3 falhas/,
    );
    assert.equal(motivoDaTarefa(tarefa({ state: 'canceled' })), 'terminou em cancelada');
    assert.equal(motivoDaTarefa(tarefa({ state: 'working' })), null);
  });
});

describe('workflow', () => {
  const run = (estados: string[], state: WorkflowRunSummary['state'] = 'running'): WorkflowRunSummary => ({
    id: 'wfr_a',
    name: 'w',
    description: null,
    projectId: 'prj_a',
    state,
    budgetUsd: null,
    batches: [],
    currentBatch: 0,
    steps: estados.map((s, i) => ({
      stepId: `s${i}`,
      agent: 'claude',
      dependsOn: [],
      state: s as WorkflowRunSummary['steps'][number]['state'],
      sessionId: null,
      taskId: null,
      summary: null,
      detail: null,
      usd: 0,
      capUsd: null,
    })),
    totalUsd: 0,
    startedAt: '',
    endedAt: null,
    error: null,
  });

  test('resumo de uma linha', () => {
    assert.equal(
      resumoDaExecucao(run(['completed', 'running', 'failed', 'pending'])),
      '1/4 concluídos · 1 rodando · 1 falhou · 1 aguardando',
    );
  });

  test('só a execução em curso pede nova consulta', () => {
    assert.equal(execucaoEmCurso(run([], 'running')), true);
    assert.equal(execucaoEmCurso(run([], 'completed')), false);
    assert.equal(execucaoEmCurso(null), false);
  });
});

function agente(extra: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'claude',
    name: 'Claude',
    vendor: 'x',
    description: '',
    capabilities: [],
    sessionStrategy: 'resume',
    streamFormat: 'jsonl',
    caveats: [],
    loginHint: '',
    model: { supported: true, format: 'x' },
    verified: { status: 'verified', version: '2.0.1', date: '', notes: '' },
    probe: { agentId: 'claude', installed: true, version: '2.0.1', binPath: 'C:/bin/claude.exe', error: null, checkedAt: '' },
    ...extra,
  };
}

describe('diagnosticarAgente', () => {
  test('instalado na versão conferida: ok', () => {
    const d = diagnosticarAgente(agente({ loginHint: 'claude login' }));
    assert.equal(d.nivel, 'ok');
    assert.equal(d.estado, 'instalado 2.0.1');
    assert.ok(d.notas.includes('login: claude login'));
    assert.ok(d.notas.includes('aceita escolher modelo por sessão'));
  });

  test('não instalado: erro com o motivo do probe', () => {
    const d = diagnosticarAgente(
      agente({ probe: { agentId: 'x', installed: false, version: null, binPath: null, error: 'binário não encontrado', checkedAt: '' } }),
    );
    assert.equal(d.nivel, 'erro');
    assert.ok(d.notas.includes('binário não encontrado'));
  });

  test('versão diferente da conferida: aviso; sem probe: aviso', () => {
    assert.equal(
      diagnosticarAgente(agente({ probe: { agentId: 'x', installed: true, version: '3.0.0', binPath: null, error: null, checkedAt: '' } })).nivel,
      'aviso',
    );
    assert.equal(diagnosticarAgente(agente({ probe: null })).nivel, 'aviso');
    assert.ok(
      diagnosticarAgente(agente({ model: { supported: false, format: '' } })).notas.includes('não aceita escolher modelo pelo Hub'),
    );
  });
});
