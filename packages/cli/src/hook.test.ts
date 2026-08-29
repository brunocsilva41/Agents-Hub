import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decideToolCall } from './hook.js';

/**
 * Porta inexistente de propósito: exercita o caminho de "daemon indisponível",
 * que é o mais frequente na vida real (o hook fica instalado e dispara mesmo
 * quando o Hub não está no ar) e também o mais perigoso de errar — se ele
 * bloqueasse, a pessoa desinstalaria o hook no primeiro dia.
 */
const SEM_DAEMON = 'http://127.0.0.1:9';

describe('ponte do hook: dois dialetos, saídas opostas para "permitir"', () => {
  test('Claude: permitir é um JSON com permissionDecision allow', async () => {
    const { saida, codigo } = await decideToolCall(
      { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: process.cwd() },
      SEM_DAEMON,
      'claude',
    );
    assert.equal(codigo, 0);
    const json = JSON.parse(saida) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(json.hookSpecificOutput.permissionDecision, 'allow');
  });

  test('Codex: permitir é NÃO escrever nada', async () => {
    const { saida, codigo } = await decideToolCall(
      { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: process.cwd() },
      SEM_DAEMON,
      'codex',
    );
    assert.equal(codigo, 0);
    // Medido contra o codex 0.149.1: devolver `permissionDecision: "allow"`
    // faz ele registrar `hook: PreToolUse Failed`. Saída vazia dá
    // `hook: PreToolUse Completed` e a ferramenta roda.
    assert.equal(saida, '');
  });

  test('chamada sem nome de ferramenta também respeita o dialeto', async () => {
    const claude = await decideToolCall({}, SEM_DAEMON, 'claude');
    assert.match(claude.saida, /allow/);

    const codex = await decideToolCall({}, SEM_DAEMON, 'codex');
    assert.equal(codex.saida, '');
  });

  test('o padrão é o dialeto do Claude, para não mudar o comportamento existente', async () => {
    const { saida } = await decideToolCall(
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      SEM_DAEMON,
    );
    assert.match(saida, /permissionDecision/);
  });

  test('daemon fora do ar NUNCA bloqueia: falha aberta é decisão de projeto', async () => {
    // Um gate que trava o agente quando o Hub cai vira dependência do editor, e
    // a primeira reação de qualquer pessoa é desinstalar o hook — que é o pior
    // desfecho possível para um controle de segurança.
    const { saida, codigo } = await decideToolCall(
      { tool_name: 'Bash', tool_input: { command: 'git push --force' } },
      SEM_DAEMON,
      'claude',
    );
    assert.equal(codigo, 0);
    assert.doesNotMatch(saida, /"deny"/);
  });
});
