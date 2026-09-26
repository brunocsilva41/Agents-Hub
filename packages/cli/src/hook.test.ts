import assert from 'node:assert/strict';
import { createServer as criarHttp, type Server } from 'node:http';
import { createServer as criarTcp, type Socket } from 'node:net';
import { describe, test } from 'node:test';
import { TIMEOUT_DO_HOOK_SEC } from '@agents-hub/daemon';
import { decideToolCall, modoDeFalhaEfetivo } from './hook.js';
import { avisoDeTimeoutDoHook, hookCommand, hookInstalado, mergeHooks } from './hooks-install.js';

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

  test('FORA de sessão do Hub, daemon fora do ar não bloqueia (falha aberta)', async () => {
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

function decisao(saida: string): string | undefined {
  if (saida === '') return undefined;
  return (JSON.parse(saida) as { hookSpecificOutput: { permissionDecision: string } })
    .hookSpecificOutput.permissionDecision;
}

const SESSAO = 'ses_abc123';

describe('modo de falha do gate (daemon não responde)', () => {
  test('padrão: fechado em sessão do Hub, aberto fora dela; config explícita vence', () => {
    assert.equal(modoDeFalhaEfetivo(undefined, true), 'closed');
    assert.equal(modoDeFalhaEfetivo(undefined, false), 'open');
    assert.equal(modoDeFalhaEfetivo('open', true), 'open');
    assert.equal(modoDeFalhaEfetivo('closed', false), 'closed');
  });

  test('sessão do Hub + daemon fora do ar: ação de risco é NEGADA (Claude e Codex)', async () => {
    const entrada = { tool_name: 'Bash', tool_input: { command: 'git push --force' } };
    const claude = await decideToolCall(entrada, SEM_DAEMON, 'claude', { sessionId: SESSAO });
    assert.equal(claude.codigo, 0);
    assert.equal(decisao(claude.saida), 'deny');
    assert.match(claude.saida, /FECHADO/);

    const codex = await decideToolCall(entrada, SEM_DAEMON, 'codex', { sessionId: SESSAO });
    assert.equal(decisao(codex.saida), 'deny', 'no Codex, silêncio seria permitir');
  });

  test('sessão do Hub + daemon fora do ar: leitura continua liberada', async () => {
    const { saida } = await decideToolCall(
      { tool_name: 'Read', tool_input: { file_path: 'README.md' } },
      SEM_DAEMON,
      'claude',
      { sessionId: SESSAO },
    );
    assert.equal(decisao(saida), 'allow');
  });

  test('failMode "open" explícito libera mesmo em sessão do Hub; "closed" nega fora dela', async () => {
    const entrada = { tool_name: 'Write', tool_input: { file_path: 'a.txt' } };
    const aberto = await decideToolCall(entrada, SEM_DAEMON, 'claude', {
      sessionId: SESSAO,
      failMode: 'open',
    });
    assert.equal(decisao(aberto.saida), 'allow');

    const fechado = await decideToolCall(entrada, SEM_DAEMON, 'claude', { failMode: 'closed' });
    assert.equal(decisao(fechado.saida), 'deny');
  });

  test('id de sessão malformado não conta como sessão do Hub', async () => {
    const { saida } = await decideToolCall(
      { tool_name: 'Bash', tool_input: { command: 'git push' } },
      SEM_DAEMON,
      'claude',
      { sessionId: '../shutdown' },
    );
    assert.equal(decisao(saida), 'allow');
  });

  test('daemon que aceita a conexão e não responde: o hook decide pelo próprio teto', async () => {
    const conexoes: Socket[] = [];
    const mudo = criarTcp((c) => conexoes.push(c));
    await new Promise<void>((r) => mudo.listen(0, '127.0.0.1', () => r()));
    const porta = (mudo.address() as { port: number }).port;
    try {
      const inicio = Date.now();
      const { saida } = await decideToolCall(
        { tool_name: 'Bash', tool_input: { command: 'git push' } },
        `http://127.0.0.1:${porta}`,
        'claude',
        { sessionId: SESSAO, tetoMs: 300 },
      );
      assert.ok(Date.now() - inicio < 5_000, 'o hook não pode esperar o agente desistir dele');
      assert.equal(decisao(saida), 'deny');
    } finally {
      for (const c of conexoes) c.destroy();
      mudo.close();
    }
  });
});

describe('resposta do daemon no dialeto do Claude', () => {
  async function comDaemon(
    resposta: Record<string, unknown>,
    corpo: (url: string) => Promise<void>,
  ): Promise<void> {
    const srv: Server = criarHttp((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resposta));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const porta = (srv.address() as { port: number }).port;
    try {
      await corpo(`http://127.0.0.1:${porta}`);
    } finally {
      srv.close();
    }
  }

  test('"escalate" (nome antigo) vira "ask", que é o que o Claude Code aceita', async () => {
    await comDaemon(
      { permission: 'escalate', explanation: 'precisa de gente', reason: 'r', risk: 'escalate', sessionId: null },
      async (url) => {
        const { saida } = await decideToolCall({ tool_name: 'Bash', tool_input: { command: 'x' } }, url, 'claude');
        assert.equal(decisao(saida), 'ask');
      },
    );
  });

  test('o motivo repassado ao agente é a explicação do daemon', async () => {
    await comDaemon(
      { permission: 'deny', explanation: 'ninguém respondeu em 55s', reason: 'r', risk: 'escalate', sessionId: SESSAO },
      async (url) => {
        const { saida } = await decideToolCall({ tool_name: 'Bash', tool_input: { command: 'x' } }, url, 'claude', {
          sessionId: SESSAO,
        });
        assert.match(saida, /ninguém respondeu em 55s/);
      },
    );
  });
});

describe('timeout do hook instalado', () => {
  test('instalação grava timeout maior que a espera do daemon', () => {
    const cfg = mergeHooks({}, '"node" "C:/x/main.js" hook');
    const pre = (cfg['hooks'] as { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> }).PreToolUse;
    assert.equal(pre[0]?.hooks[0]?.timeout, TIMEOUT_DO_HOOK_SEC);
    assert.ok(TIMEOUT_DO_HOOK_SEC >= 120);
    assert.equal(avisoDeTimeoutDoHook(cfg), null);
  });

  test('instalação antiga (timeout 10) é acusada, e reinstalar corrige', () => {
    const antiga = {
      model: 'x',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'outro-hook' }] },
          { matcher: 'Bash|Write', hooks: [{ type: 'command', command: '"node" "C:/x/main.js" hook', timeout: 10 }] },
        ],
      },
    };
    assert.match(avisoDeTimeoutDoHook(antiga) ?? '', /timeout 10 s/);

    const reinstalada = mergeHooks(antiga, '"node" "C:/x/main.js" hook');
    assert.equal(avisoDeTimeoutDoHook(reinstalada), null);
    const pre = (reinstalada['hooks'] as { PreToolUse: unknown[] }).PreToolUse;
    assert.equal(pre.length, 2, 'o hook de terceiros fica; o nosso é substituído, não duplicado');
  });

  test('sem hook do Hub instalado, não há aviso', () => {
    assert.equal(avisoDeTimeoutDoHook({}), null);
  });
});

// Item 5.7: o hook passa a apontar para `bin.js` (entrada leve, com a flag do
// SQLite quando o Node precisa). Instalações antigas gravaram `main.js`.
describe('comando do hook instalado', () => {
  test('aponta para bin.js da própria instalação', () => {
    assert.match(hookCommand(), /[\\/]bin\.js" hook$/);
  });

  test('reinstalar sobre a entrada antiga (main.js) substitui em vez de duplicar', () => {
    const antiga = mergeHooks({}, '"node" "C:/x/main.js" hook');
    const nova = mergeHooks(antiga, '"node" "C:/y/bin.js" hook');
    const pre = (nova['hooks'] as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse;
    assert.equal(pre.length, 1);
    assert.equal(pre[0]?.hooks[0]?.command, '"node" "C:/y/bin.js" hook');
  });

  test('reinstalar duas vezes com bin.js não duplica, e conta como instalado', () => {
    const uma = mergeHooks({}, '"node" "C:/y/bin.js" hook');
    const duas = mergeHooks(uma, '"node" "C:/y/bin.js" hook');
    assert.equal((duas['hooks'] as { PreToolUse: unknown[] }).PreToolUse.length, 1);
    assert.equal(hookInstalado(duas), true);
  });
});
