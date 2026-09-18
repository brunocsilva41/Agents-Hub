import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_POLICY, PolicyEngine } from '@agents-hub/core';
import {
  actionsOfToolCall,
  combineVerdicts,
  explainToAgent,
  resumoDaChamada,
  toCodexHookOutput,
  toHookPermission,
} from './pretool-gate.js';

const workdir = path.resolve('/tmp/hub/worktree');

describe('resumo da chamada para a fila de aprovações', () => {
  test('shell mostra o comando, que é o que decide a aprovação', () => {
    assert.equal(
      resumoDaChamada('Bash', { command: 'git push origin main' }),
      'git push origin main',
    );
  });

  test('escrita mostra o caminho', () => {
    assert.equal(resumoDaChamada('Write', { file_path: 'src/a.ts', content: '...' }), 'src/a.ts');
  });

  test('corta pelo fim: a intenção de um comando está no começo', () => {
    const longo = `rm -rf /alvo/importante ${'x'.repeat(300)}`;
    const resumo = resumoDaChamada('Bash', { command: longo }, 40);
    assert.equal(resumo.length, 40);
    assert.ok(resumo.startsWith('rm -rf /alvo/importante'));
    assert.ok(resumo.endsWith('…'));
  });

  test('quebra de linha vira espaço — a fila mostra uma linha só', () => {
    assert.equal(resumoDaChamada('Bash', { command: 'a\n  b\n\tc' }), 'a b c');
  });

  test('ferramenta desconhecida lista os campos em vez de ficar muda', () => {
    // Uma aprovação que não diz o que está aprovando é uma aprovação dada no
    // automático. Os nomes dos campos são pouco, mas não são nada.
    assert.equal(resumoDaChamada('FerramentaNova', { alvo: 'x', modo: 'y' }), 'campos: alvo, modo');
  });

  test('sem argumento nenhum ainda diz algo', () => {
    assert.equal(resumoDaChamada('FerramentaNova', {}), '(sem argumentos)');
    assert.equal(resumoDaChamada('Bash', {}), '(comando vazio)');
    assert.equal(resumoDaChamada('Write', {}), '(caminho não informado)');
  });

  test('não é sensível a caixa, como o resto do gate', () => {
    assert.equal(resumoDaChamada('bash', { command: 'ls' }), 'ls');
  });
});

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

describe('dialeto do hook do Codex', () => {
  // Contrato sondado contra o codex 0.149.1, com --dangerously-bypass-hook-trust.
  // Ver os comentários em `toCodexHookOutput` para o porquê de cada regra.

  test('permitir é NÃO escrever nada: "allow" faz o Codex marcar o hook como Failed', () => {
    const saida = toCodexHookOutput(
      { decision: 'allow', risk: 'read', reason: 'leitura de arquivo do projeto' },
      'semi',
    );
    assert.equal(saida, null);
  });

  test('negar leva motivo obrigatório — o binário recusa deny sem motivo', () => {
    const saida = toCodexHookOutput(
      { decision: 'deny', risk: 'irreversible', reason: 'git push para remoto' },
      'semi',
    );
    assert.ok(saida);
    assert.equal(saida.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(saida.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.ok(saida.hookSpecificOutput.permissionDecisionReason.length > 0);
  });

  test('aprovação humana também vira deny: o Codex não tem "ask"', () => {
    const saida = toCodexHookOutput(
      { decision: 'approve', risk: 'escalate', reason: 'escrita fora do worktree' },
      'semi',
    );
    assert.ok(saida);
    // A decisão do Hub é "approve", mas no dialeto do Codex a única forma de
    // parar a ação é negar — e o motivo precisa mandar o agente falar com o
    // humano, senão ele tenta outro caminho para o mesmo efeito.
    assert.equal(saida.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(saida.hookSpecificOutput.permissionDecisionReason, /aprovação humana/i);
  });
});
