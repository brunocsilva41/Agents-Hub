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
  return (JSON.parse(saida) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
    .permissionDecision;
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

  test('sessão do Hub + daemon fora do ar: leitura comum continua liberada', async () => {
    // Liberada no próprio hook, sem ida ao daemon: a resposta é o silêncio
    // (nenhuma objeção), não um `allow` que atropelaria a permissão do agente.
    const { saida } = await decideToolCall(
      { tool_name: 'Read', tool_input: { file_path: 'README.md' } },
      SEM_DAEMON,
      'claude',
      { sessionId: SESSAO },
    );
    assert.equal(saida, '');
  });

  test('sessão do Hub + daemon fora do ar: leitura de SEGREDO é negada (Read e Grep)', async () => {
    for (const entrada of [
      { tool_name: 'Read', tool_input: { file_path: '~/.ssh/id_rsa' } },
      { tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '.env' } },
      { tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '.', glob: '.env*' } },
    ]) {
      const { saida } = await decideToolCall(entrada, SEM_DAEMON, 'claude', { sessionId: SESSAO });
      assert.equal(decisao(saida), 'deny', JSON.stringify(entrada));
    }
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
      {
        permission: 'escalate',
        explanation: 'precisa de gente',
        reason: 'r',
        risk: 'escalate',
        sessionId: null,
      },
      async (url) => {
        const { saida } = await decideToolCall(
          { tool_name: 'Bash', tool_input: { command: 'x' } },
          url,
          'claude',
        );
        assert.equal(decisao(saida), 'ask');
      },
    );
  });

  test('o motivo repassado ao agente é a explicação do daemon', async () => {
    await comDaemon(
      {
        permission: 'deny',
        explanation: 'ninguém respondeu em 55s',
        reason: 'r',
        risk: 'escalate',
        sessionId: SESSAO,
      },
      async (url) => {
        const { saida } = await decideToolCall(
          { tool_name: 'Bash', tool_input: { command: 'x' } },
          url,
          'claude',
          {
            sessionId: SESSAO,
          },
        );
        assert.match(saida, /ninguém respondeu em 55s/);
      },
    );
  });
});

describe('leitura no gate: comum sai no próprio hook, segredo vai ao daemon', () => {
  /** Daemon falso que conta as perguntas e manda aprovar (`ask`). */
  async function comDaemonContador(
    corpo: (url: string, pedidos: string[]) => Promise<void>,
  ): Promise<void> {
    const pedidos: string[] = [];
    const srv: Server = criarHttp((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        pedidos.push(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            permission: 'ask',
            explanation: 'leitura de segredo',
            reason: 'r',
            risk: 'irreversible',
            sessionId: SESSAO,
          }),
        );
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const porta = (srv.address() as { port: number }).port;
    try {
      await corpo(`http://127.0.0.1:${porta}`, pedidos);
    } finally {
      srv.close();
    }
  }

  test('Read/Grep/Glob comuns não perguntam ao daemon nem abrem aprovação', async () => {
    await comDaemonContador(async (url, pedidos) => {
      for (const entrada of [
        { tool_name: 'Read', tool_input: { file_path: 'src/app.ts' }, cwd: process.cwd() },
        { tool_name: 'Read', tool_input: { file_path: '.env.example' }, cwd: process.cwd() },
        { tool_name: 'Grep', tool_input: { pattern: 'x', path: 'src', glob: '*.ts' } },
        { tool_name: 'Grep', tool_input: { pattern: 'x' } },
        { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } },
      ]) {
        for (const dialeto of ['claude', 'codex'] as const) {
          const { saida, codigo } = await decideToolCall(entrada, url, dialeto, { sessionId: SESSAO });
          assert.equal(codigo, 0);
          assert.equal(saida, '', `${dialeto}: ${JSON.stringify(entrada)}`);
        }
      }
      assert.equal(pedidos.length, 0, 'leitura comum não pode custar a ida ao daemon');
    });
  });

  test('Read/Grep de segredo chegam ao daemon, e a resposta dele vale', async () => {
    await comDaemonContador(async (url, pedidos) => {
      for (const entrada of [
        { tool_name: 'Read', tool_input: { file_path: '/home/u/.ssh/id_rsa' } },
        { tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\u\\.aws\\credentials' } },
        { tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: process.cwd() },
        { tool_name: 'Grep', tool_input: { pattern: 'TOKEN', path: '.', glob: '.env*' } },
      ]) {
        const { saida } = await decideToolCall(entrada, url, 'claude', { sessionId: SESSAO });
        assert.equal(decisao(saida), 'ask', JSON.stringify(entrada));
      }
      assert.equal(pedidos.length, 4);
      assert.match(pedidos[0] ?? '', /id_rsa/);
    });
  });
});

describe('timeout do hook instalado', () => {
  test('instalação grava timeout maior que a espera do daemon', () => {
    const cfg = mergeHooks({}, '"node" "C:/x/main.js" hook');
    const pre = (cfg['hooks'] as { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> })
      .PreToolUse;
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
          {
            matcher: 'Bash|Write',
            hooks: [{ type: 'command', command: '"node" "C:/x/main.js" hook', timeout: 10 }],
          },
        ],
      },
    };
    assert.match(avisoDeTimeoutDoHook(antiga) ?? '', /timeout 10 s/);

    const reinstalada = mergeHooks(antiga, '"node" "C:/x/main.js" hook');
    assert.equal(avisoDeTimeoutDoHook(reinstalada), null);
    const pre = (reinstalada['hooks'] as { PreToolUse: unknown[] }).PreToolUse;
    assert.equal(pre.length, 2, 'o hook de terceiros fica; o nosso é substituído, não duplicado');
  });

  test('instalação antiga (matcher sem Read/Grep) é acusada, e reinstalar corrige', () => {
    const antiga = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch',
            hooks: [
              { type: 'command', command: '"node" "C:/x/bin.js" hook', timeout: TIMEOUT_DO_HOOK_SEC },
            ],
          },
        ],
      },
    };
    const aviso = avisoDeTimeoutDoHook(antiga) ?? '';
    assert.match(aviso, /matcher antigo, sem Read\/Grep/);
    assert.doesNotMatch(aviso, /timeout/, 'o timeout desta instalação está certo');
    assert.equal(avisoDeTimeoutDoHook(mergeHooks(antiga, '"node" "C:/x/bin.js" hook')), null);
    // Matcher que cobre tudo (`*`) não é instalação antiga.
    const tudo = { hooks: { PreToolUse: [{ ...antiga.hooks.PreToolUse[0], matcher: '*' }] } };
    assert.equal(avisoDeTimeoutDoHook(tudo), null);
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
    const pre = (nova['hooks'] as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> })
      .PreToolUse;
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
