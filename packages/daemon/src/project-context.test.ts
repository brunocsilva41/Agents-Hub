import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseBrief, renderBriefAsPrompt } from '@agents-hub/core';
import {
  contextForAgent,
  loadProjectContext,
  PROJECT_CONFIG_RELATIVE,
  saveProjectContext,
} from './project-config.js';

/**
 * Memória e prompts do projeto.
 *
 * O ponto destes testes não é o parser: é garantir que o contexto chega ao
 * prompt SEM entrar no objetivo. A interface chegou a concatenar diretrizes no
 * `objective`, e o `objective` alimenta `objectiveHash`, que é como o CallGraph
 * detecta ciclo semântico — misturar os dois faz duas tarefas iguais parecerem
 * diferentes e a detecção passa a deixar passar o que deveria barrar.
 */
describe('contexto do projeto', () => {
  let raiz: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-ctx-'));
    mkdirSync(path.join(raiz, '.agents-hub'), { recursive: true });
  });

  after(() => {
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function escrever(yaml: string): void {
    writeFileSync(path.join(raiz, PROJECT_CONFIG_RELATIVE), yaml, 'utf8');
  }

  test('memória e prompt por agente são lidos', () => {
    escrever(
      [
        'memory: |',
        '  Nunca comite direto em main.',
        'prompts:',
        '  codex: "Mudanças pequenas e testáveis."',
        '  claude: "Explique antes de aplicar."',
        '',
      ].join('\n'),
    );

    const { ctx, error } = loadProjectContext(raiz);
    assert.equal(error, null);
    assert.match(String(ctx.memory), /Nunca comite/);
    assert.equal(ctx.prompts?.['codex'], 'Mudanças pequenas e testáveis.');

    const paraCodex = contextForAgent(ctx, 'codex');
    assert.equal(paraCodex.instrucoesDoAgente, 'Mudanças pequenas e testáveis.');

    // O agente que não tem instrução própria recebe só a memória — não a
    // instrução de outro agente.
    const paraKimi = contextForAgent(ctx, 'kimi');
    assert.equal(paraKimi.instrucoesDoAgente, undefined);
    assert.match(String(paraKimi.memoria), /Nunca comite/);
  });

  test('valor que não é string é ignorado em vez de virar "[object Object]"', () => {
    escrever(['prompts:', '  codex:', '    algo: 1', ''].join('\n'));
    const { ctx } = loadProjectContext(raiz);
    assert.equal(ctx.prompts, undefined);
  });

  test('YAML quebrado não derruba nada: cai no vazio, mas o erro é visível', () => {
    escrever('memory: [isto: nao: fecha');
    const { ctx, error } = loadProjectContext(raiz);
    assert.deepEqual(ctx, {});
    assert.match(String(error), /YAML inválido/);
  });

  test('projeto sem arquivo devolve vazio, sem erro', () => {
    const vazio = mkdtempSync(path.join(os.tmpdir(), 'hub-ctx-vazio-'));
    try {
      const { ctx, error } = loadProjectContext(vazio);
      assert.deepEqual(ctx, {});
      assert.equal(error, null);
    } finally {
      rmSync(vazio, { recursive: true, force: true });
    }
  });

  test('o contexto entra no prompt SEM contaminar o objetivo', () => {
    const brief = parseBrief({ agent: 'codex', objective: 'renomear a função X' });

    const semContexto = renderBriefAsPrompt(brief);
    const comContexto = renderBriefAsPrompt(brief, {
      memoria: 'Nunca comite direto em main.',
      instrucoesDoAgente: 'Mudanças pequenas.',
    });

    // O enquadramento vem ANTES da tarefa: lido depois, já não enquadra nada.
    assert.ok(comContexto.indexOf('Diretrizes do projeto') < comContexto.indexOf('# Tarefa'));
    assert.match(comContexto, /Nunca comite direto em main/);
    assert.match(comContexto, /Mudanças pequenas/);

    // E o objetivo continua sendo exatamente o que o usuário escreveu — é ele
    // que alimenta o hash de detecção de ciclo.
    assert.equal(brief.objective, 'renomear a função X');
    assert.match(semContexto, /renomear a função X/);
    assert.ok(!semContexto.includes('Diretrizes do projeto'));
  });
  test('gravar NÃO destrói comentários nem a política do arquivo', () => {
    // Regressão medida: a primeira versão usava `parse` -> objeto ->
    // `stringify`, que preserva as CHAVES e apaga os COMENTÁRIOS. Salvar o
    // contexto uma vez removeu 17 linhas do config.yaml real, incluindo a
    // explicação da regra de que o projeto só pode APERTAR a política global.
    // Nada quebrava — a documentação da regra é que sumia, e ninguém notaria
    // até precisar dela.
    const original = [
      '# Regra de ouro: o projeto só pode APERTAR a política global.',
      'policy:',
      '  commands:',
      '    # Somam à deny list global.',
      '    deny:',
      '      - npm publish',
      '',
    ].join('\n');
    escrever(original);

    saveProjectContext(raiz, { memory: 'Nunca comite em main.' });

    const depois = readFileSync(path.join(raiz, PROJECT_CONFIG_RELATIVE), 'utf8');
    assert.match(depois, /# Regra de ouro/, 'comentário de topo precisa sobreviver');
    assert.match(depois, /# Somam à deny list global/, 'comentário interno precisa sobreviver');
    assert.match(depois, /- npm publish/, 'a política precisa sobreviver');
    assert.match(depois, /memory: Nunca comite em main\./);
  });

  test('remover a memória não leva o resto do arquivo junto', () => {
    escrever(['# comentário', 'policy:', '  maxDepth: 2', 'memory: algo', ''].join('\n'));
    saveProjectContext(raiz, {});
    const depois = readFileSync(path.join(raiz, PROJECT_CONFIG_RELATIVE), 'utf8');
    assert.ok(!depois.includes('memory:'));
    assert.match(depois, /# comentário/);
    assert.match(depois, /maxDepth: 2/);
  });

  test('YAML quebrado é recusado em vez de sobrescrito', () => {
    // Sobrescrever apagaria a política junto com o erro de sintaxe.
    escrever('policy: [nao: fecha');
    assert.throws(() => saveProjectContext(raiz, { memory: 'x' }), /não é YAML válido/);
  });
});
