import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { PolicyEngine } from '@agents-hub/core';
import { actionsOfToolCall, combineVerdicts } from './pretool-gate.js';

/**
 * R05-05 (resíduo): ferramenta desconhecida não vira ação no gate — o hook
 * fica sem opinião e a permissão do próprio agente decide. Mantido para
 * ferramenta desconhecida em geral (ver SECURITY.md, "Ferramenta desconhecida
 * no gate"), com UMA exceção conservadora: ferramenta de servidor MCP
 * (`mcp__<servidor>__<ferramenta>`) cujo input traz um caminho de SEGREDO
 * vira leitura desse caminho. `mcp__filesystem__read_file {path: ~/.ssh/id_rsa}`
 * é o mesmo `cat ~/.ssh/id_rsa` por outra porta.
 */

const workdir = path.resolve('/tmp/hub/worktree');
const engine = new PolicyEngine();

function decisao(toolName: string, toolInput: Record<string, unknown>): string {
  const acoes = actionsOfToolCall({ toolName, toolInput }, workdir);
  const partes = acoes.map((a) => engine.decide(a, { workdir, mode: 'autonomous' }));
  return combineVerdicts(partes).decision;
}

describe('R05-05: mcp__* com caminho de segredo no input', () => {
  const SEGREDOS: Array<[string, Record<string, unknown>]> = [
    ['mcp__filesystem__read_file', { path: '/home/ana/.ssh/id_rsa' }],
    ['mcp__filesystem__read_text_file', { path: '.env' }],
    ['mcp__fs__read_multiple_files', { paths: ['src/a.ts', 'config/.env.production'] }],
    ['mcp__qualquer__abrir', { arquivo: 'C:\\Users\\ana\\.aws\\credentials' }],
    ['mcp__agents_hub__ler', { alvo: '/home/ana/.agents-hub/operator-token' }],
  ];
  for (const [nome, input] of SEGREDOS) {
    test(`${nome} ${JSON.stringify(input)} pede aprovação mesmo em autonomous`, () => {
      assert.equal(decisao(nome, input), 'approve');
    });
  }

  test('mcp__* sem caminho de segredo continua sem ação (permissão do agente decide)', () => {
    assert.deepEqual(
      actionsOfToolCall(
        { toolName: 'mcp__fs__read_file', toolInput: { path: 'src/index.ts' } },
        workdir,
      ),
      [],
    );
    assert.deepEqual(
      actionsOfToolCall(
        {
          toolName: 'mcp__github__create_issue',
          toolInput: { title: 'arrumar leitura do .env', body: 'x' },
        },
        workdir,
      ),
      [],
      'texto livre que só MENCIONA .env não é caminho',
    );
  });

  test('ferramenta desconhecida que não é MCP segue sem ação', () => {
    assert.deepEqual(
      actionsOfToolCall({ toolName: 'Task', toolInput: { prompt: 'leia ~/.ssh/id_rsa' } }, workdir),
      [],
    );
    assert.deepEqual(
      actionsOfToolCall({ toolName: 'FerramentaNova', toolInput: { path: '.env' } }, workdir),
      [],
    );
  });
});
