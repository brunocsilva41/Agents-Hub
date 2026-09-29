import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';
import { cliHookEntrypoint } from './config.js';
import { ensureOperatorToken } from './operator-auth.js';
import { caminhoDoSettingsDaSessao, conteudoDoSettingsDaSessao } from './session-settings.js';
import { MATCHER_DE_RISCO } from './hooks-config.js';
import { TIMEOUT_DO_HOOK_SEC } from './pretool-gate.js';

/**
 * Gate pré-execução POR SESSÃO (teste real de 2026-09-26, achado ALTO): a
 * sessão do Claude subida pelo Hub só tinha gate se o usuário tivesse
 * instalado o hook no `~/.claude/settings.json`. Agora o Hub grava
 * `<home>/run/<sessão>-settings.json` com o hook e passa `--settings`.
 *
 * O agente falso faz o que o Claude faz: lê o `--settings`, executa o comando
 * do hook DE VERDADE (o `bin.js hook` desta instalação, que faz
 * `POST /hooks/pretooluse`) com o JSON do `PreToolUse` no stdin, e só
 * "executa" a ferramenta se a resposta for `allow`.
 */

const AGENTE = `
const fs = require('node:fs');
const cp = require('node:child_process');
if (process.argv.includes('--version')) { process.stdout.write('2.1.283\\n'); process.exit(0); }
const saida = process.env.SAIDA_GATE;
const i = process.argv.indexOf('--settings');
if (i < 0) { fs.writeFileSync(saida, JSON.stringify({ semSettings: true })); process.exit(0); }
const arquivo = process.argv[i + 1];
const cfg = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const entrada = cfg.hooks.PreToolUse[0];
const comando = entrada.hooks[0].command;
const pedido = JSON.stringify({
  session_id: 'nativo-falso',
  cwd: process.cwd(),
  tool_name: 'Bash',
  tool_input: { command: 'git push --force origin main' },
  tool_use_id: 'toolu_teste_1',
});
const r = cp.spawnSync(comando, { shell: true, input: pedido, encoding: 'utf8' });
let decisao = null;
try { decisao = JSON.parse(r.stdout).hookSpecificOutput; } catch {}
if (decisao && decisao.permissionDecision === 'allow') fs.writeFileSync(saida + '.executou', 'x');
fs.writeFileSync(saida, JSON.stringify({ arquivo, existia: fs.existsSync(arquivo), cfg, decisao, status: r.status, stderr: r.stderr }));
process.stdout.write('fim\\n');
process.exit(0);
`;

describe('gate por sessão via --settings (Claude/OpenClaude)', () => {
  let raiz: string;
  let home: string;
  let hub: Hub;
  let base: string;
  let projetoId: string;
  let saida: string;
  const envAntes = {
    home: process.env['AGENTS_HUB_HOME'],
    porta: process.env['AGENTS_HUB_PORT'],
    auto: process.env['AGENTS_HUB_NO_AUTOSTART'],
  };

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-gate-sessao-'));
    home = path.join(raiz, 'home');
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'claude-falso.cjs');
    saida = path.join(raiz, 'saida.json');
    for (const d of [manifestos, projeto]) mkdirSync(d, { recursive: true });
    writeFileSync(script, AGENTE, 'utf8');
    const esc = (s: string): string => s.replaceAll('\\', '\\\\');
    writeFileSync(
      path.join(manifestos, 'claude-falso.yaml'),
      [
        'id: claude-falso',
        'name: Claude Falso',
        'bin: node',
        'detect:',
        `  args: ["${esc(script)}", "--version"]`,
        'invoke:',
        `  oneShot: ["${esc(script)}"]`,
        '  stdinPrompt: true',
        '  env:',
        `    SAIDA_GATE: "${esc(saida)}"`,
        'gate:',
        '  settingsArgs: ["--settings", "{{settingsFile}}"]',
        'session:',
        '  strategy: replay',
        'stream:',
        '  format: text',
        '  mapper: generic-text',
        'defaults:',
        '  isolation: none',
        '  timeoutSeconds: 120',
        '',
      ].join('\n'),
      'utf8',
    );

    hub = createHub({
      home,
      manifestsDir: manifestos,
      port: 0,
      webRoot: path.join(raiz, 'sem-web'),
      policy: { ...DEFAULT_POLICY, watch: { pauseOn: [], flagOn: [] } },
    });
    const porta = (await hub.start()).port;
    base = `http://127.0.0.1:${porta}`;
    // O hook (processo neto do teste) acha o daemon pelo ambiente herdado.
    process.env['AGENTS_HUB_HOME'] = home;
    process.env['AGENTS_HUB_PORT'] = String(porta);
    process.env['AGENTS_HUB_NO_AUTOSTART'] = '1';
    projetoId = hub.sessions.registerProject(projeto, 'gate por sessão').id;
  });

  after(async () => {
    for (const [k, v] of [
      ['AGENTS_HUB_HOME', envAntes.home],
      ['AGENTS_HUB_PORT', envAntes.porta],
      ['AGENTS_HUB_NO_AUTOSTART', envAntes.auto],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza oportunista */
    }
  });

  test('conteúdo do arquivo = o que `hub hooks install` gravaria (bin.js, matcher de risco, 120 s)', () => {
    const cfg = conteudoDoSettingsDaSessao(process.execPath, cliHookEntrypoint()) as {
      hooks: {
        PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>;
      };
    };
    const [entrada] = cfg.hooks.PreToolUse;
    assert.equal(entrada?.matcher, MATCHER_DE_RISCO);
    assert.equal(entrada?.hooks[0]?.timeout, TIMEOUT_DO_HOOK_SEC);
    assert.match(entrada?.hooks[0]?.command ?? '', /bin\.js" hook$/);
  });

  test('agente falso que chama o hook de verdade é BLOQUEADO num comando irreversível; o arquivo existe durante a sessão e some depois', async () => {
    hub.sessions.gateWaitMs = 30_000;
    const { session, task } = await hub.sessions.start({
      projectId: projetoId,
      agentId: 'claude-falso',
      brief: {
        agent: 'claude-falso',
        objective: 'tentar um push forçado',
        isolation: 'none',
        supervision: 'semi',
      },
    });
    const arquivo = caminhoDoSettingsDaSessao(home, session.id);

    // O hook chegou ao daemon: aprovação real aberta para o push forçado.
    const apv = await esperarAte(
      () => hub.sessions.pendingApprovals(session.id)[0],
      'aprovação do gate',
    );
    assert.match(apv.action, /git push --force/);
    assert.ok(existsSync(arquivo), 'o arquivo de settings deve existir enquanto a sessão roda');

    const token = ensureOperatorToken(home).token;
    const r = await fetch(`${base}/approvals/${apv.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'denied', by: 'teste' }),
    });
    assert.equal(r.status, 200);

    const resultado = await esperarAte(
      () =>
        existsSync(saida) ? (JSON.parse(readFileSync(saida, 'utf8')) as Record<string, unknown>) : null,
      'saída do agente falso',
    );
    assert.equal(resultado['semSettings'], undefined, 'o agente não recebeu --settings');
    assert.equal(resultado['arquivo'], arquivo);
    assert.equal(resultado['existia'], true);
    const decisao = resultado['decisao'] as {
      permissionDecision?: string;
      permissionDecisionReason?: string;
    } | null;
    assert.equal(decisao?.permissionDecision, 'deny', JSON.stringify(resultado));
    assert.match(decisao?.permissionDecisionReason ?? '', /humano negou/i);
    assert.equal(existsSync(`${saida}.executou`), false, 'a ferramenta NÃO pode ter rodado');

    await esperarAte(() => {
      const t = hub.store.tasks.get(task.id);
      return t && ['completed', 'failed', 'canceled', 'rejected'].includes(t.state);
    }, 'fim da tarefa');
    await esperarAte(() => !existsSync(arquivo), 'arquivo de settings apagado no fim da sessão');
  });

  test('mesmo tool_use_id vindo de dois hooks (settings do Hub + do usuário): UMA aprovação, mesma decisão', async () => {
    hub.sessions.gateWaitMs = 30_000;
    const { session } = await hub.sessions.start({
      projectId: projetoId,
      agentId: 'claude-falso',
      brief: {
        agent: 'claude-falso',
        objective: 'duas perguntas iguais',
        isolation: 'none',
        supervision: 'semi',
      },
    });
    const corpo = JSON.stringify({
      sessionId: session.id,
      toolName: 'Bash',
      toolInput: { command: 'git push --force origin dev' },
      toolUseId: 'toolu_duplicado',
    });
    const perguntar = (): Promise<Record<string, unknown>> =>
      fetch(`${base}/hooks/pretooluse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: corpo,
      }).then((r) => r.json() as Promise<Record<string, unknown>>);
    // Conta as chegadas ao gate. O trecho síncrono de `gateToolCall` já abre a
    // aprovação (ou encosta na que está em voo), então, quando as DUAS
    // chamadas chegaram, uma segunda aprovação indevida já estaria no banco —
    // sem janela de tempo adivinhada.
    let chegadas = 0;
    const gateOriginal = hub.sessions.gateToolCall.bind(hub.sessions);
    hub.sessions.gateToolCall = (input) => {
      const veredito = gateOriginal(input);
      chegadas += 1;
      return veredito;
    };
    try {
      const a = perguntar();
      const b = perguntar();
      await esperarAte(() => chegadas === 2, 'as duas chamadas do hook chegarem ao gate');
      const doGate = hub.store.approvals
        .listPending({ sessionId: session.id })
        .filter((x) => /origin dev/.test(x.action));
      assert.equal(doGate.length, 1, 'duas aprovações para a mesma chamada');
      await hub.sessions.resolveApproval(doGate[0]!.id, 'approved', 'teste');
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra['permission'], 'allow');
      assert.equal(rb['permission'], 'allow');
      assert.equal(ra['approvalId'], rb['approvalId']);
    } finally {
      hub.sessions.gateToolCall = gateOriginal;
    }
    await hub.sessions.cancel(session.id, 'fim do teste').catch(() => undefined);
  });
});
