import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_POLICY, PolicyEngine } from '@agents-hub/core';
import {
  actionsOfToolCall,
  combineVerdicts,
  explainToAgent,
  toHookPermission,
} from './pretool-gate.js';

const workdir = path.resolve('/tmp/hub/worktree');

describe('tradução de chamada de ferramenta', () => {
  test('shell vira comando', () => {
    const [acao] = actionsOfToolCall(
      { toolName: 'Bash', toolInput: { command: 'git push origin main' } },
      workdir,
    );
    assert.equal(acao?.kind, 'command');
  });

  test('escrita resolve caminho relativo contra o diretório da sessão', () => {
    const [acao] = actionsOfToolCall(
      { toolName: 'Write', toolInput: { file_path: 'src/a.ts' } },
      workdir,
    );
    assert.equal(acao?.kind, 'file.write');
    assert.equal(acao?.kind === 'file.write' && acao.path, path.join(workdir, 'src/a.ts'));
  });

  test('nome da ferramenta não é sensível a caixa', () => {
    assert.equal(
      actionsOfToolCall({ toolName: 'bash', toolInput: { command: 'ls' } }, workdir).length,
      1,
    );
  });

  test('ferramenta desconhecida NÃO vira ação', () => {
    assert.deepEqual(
      actionsOfToolCall({ toolName: 'FerramentaNovaQualquer', toolInput: { x: 1 } }, workdir),
      [],
      'negar o que não se entende faria o usuário desligar o hook no primeiro dia',
    );
  });

  test('chamada sem o campo esperado não inventa ação', () => {
    assert.deepEqual(actionsOfToolCall({ toolName: 'Bash', toolInput: {} }, workdir), []);
  });
});

describe('decisão combinada', () => {
  const engine = new PolicyEngine();
  const ctx = { workdir, mode: 'semi' as const };

  test('a pior parte da chamada define o veredito', () => {
    const acoes = [
      { kind: 'file.write' as const, path: path.join(workdir, 'ok.ts') },
      { kind: 'file.write' as const, path: '/etc/hosts' },
    ];
    const combinado = combineVerdicts(
      acoes.map((a) => {
        const v = engine.decide(a, ctx);
        return { decision: v.decision, risk: v.risk, reason: v.reason };
      }),
    );
    assert.notEqual(combinado.decision, 'allow', 'a escrita fora do worktree contamina a chamada');
  });

  test('sem ação de risco, libera', () => {
    assert.equal(combineVerdicts([]).decision, 'allow');
  });
});

describe('tradução para a permissão do hook', () => {
  test('"precisa de aprovação" vira ESCALAR, nunca NEGAR', () => {
    assert.equal(
      toHookPermission('approve'),
      'escalate',
      'virar deny faria o agente concluir que a ação é impossível e tentar contorná-la',
    );
  });

  test('allow e deny passam direto', () => {
    assert.equal(toHookPermission('allow'), 'allow');
    assert.equal(toHookPermission('deny'), 'deny');
  });
});

describe('mensagem devolvida ao agente', () => {
  test('negar diz explicitamente para não contornar', () => {
    const texto = explainToAgent(
      { decision: 'deny', risk: 'irreversible', reason: 'comando na deny list' },
      'semi',
    );
    assert.match(texto, /não tente contornar/i);
  });

  test('pedir aprovação orienta a seguir com o resto da tarefa', () => {
    const texto = explainToAgent(
      { decision: 'approve', risk: 'escalate', reason: 'fora da allow list' },
      'supervised',
    );
    assert.match(texto, /siga com o resto/i);
    assert.match(texto, /supervised/);
  });
});

describe('o gate concorda com a vigilância reativa', () => {
  const engine = new PolicyEngine(DEFAULT_POLICY);

  test('git push é barrado nos dois caminhos', () => {
    const [acao] = actionsOfToolCall(
      { toolName: 'Bash', toolInput: { command: 'git push' } },
      workdir,
    );
    assert.ok(acao);
    const v = engine.decide(acao, { workdir, mode: 'semi' });
    assert.equal(v.risk, 'irreversible');
    assert.equal(toHookPermission(v.decision), 'escalate');
  });

  test('trabalho normal no worktree passa sem atrito', () => {
    for (const call of [
      { toolName: 'Write', toolInput: { file_path: 'src/a.ts' } },
      { toolName: 'Bash', toolInput: { command: 'npm test' } },
      { toolName: 'Read', toolInput: { file_path: 'README.md' } },
    ]) {
      const [acao] = actionsOfToolCall(call, workdir);
      assert.ok(acao, `${call.toolName} deveria produzir ação`);
      assert.equal(
        engine.decide(acao, { workdir, mode: 'semi' }).decision,
        'allow',
        `${call.toolName} não pode gerar atrito no fluxo normal`,
      );
    }
  });
});
