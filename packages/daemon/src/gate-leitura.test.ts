import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';
import { ensureOperatorToken } from './operator-auth.js';

/**
 * `Read` no matcher do gate (decisão de 2026-09-28): antes, ler
 * `~/.ssh/id_rsa` pela ferramenta de leitura do Claude nem chamava o hook — o
 * matcher só tinha shell/escrita/rede —, enquanto o mesmo `cat` pelo shell
 * parava no gate.
 *
 * O agente falso faz o que o Claude faz com o `--settings`: só chama o hook se
 * o `matcher` da entrada casar o nome da ferramenta; sem casar, a ferramenta
 * roda direto. Com o matcher antigo, este teste fica vermelho (a leitura do
 * segredo "executa" sem pergunta nenhuma); com o novo, a leitura do segredo
 * abre aprovação e a leitura comum passa sem abrir nada.
 */

const AGENTE = `
const fs = require('node:fs');
const cp = require('node:child_process');
if (process.argv.includes('--version')) { process.stdout.write('2.1.283\\n'); process.exit(0); }
const saida = process.env.SAIDA_GATE;
const i = process.argv.indexOf('--settings');
const cfg = i < 0 ? { hooks: { PreToolUse: [] } } : JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
const chamadas = [
  { tool_name: 'Read', tool_input: { file_path: process.env.SEGREDO_GATE }, tool_use_id: 'toolu_segredo' },
  { tool_name: 'Read', tool_input: { file_path: 'src/app.ts' }, tool_use_id: 'toolu_comum' },
];
const resultados = [];
for (const c of chamadas) {
  const entradas = cfg.hooks.PreToolUse.filter((e) => new RegExp('^(?:' + e.matcher + ')$').test(c.tool_name));
  if (entradas.length === 0) { resultados.push({ tool: c.tool_use_id, hook: false, executou: true }); continue; }
  const pedido = JSON.stringify({ session_id: 'nativo-falso', cwd: process.cwd(), ...c });
  const r = cp.spawnSync(entradas[0].hooks[0].command, { shell: true, input: pedido, encoding: 'utf8' });
  let decisao = null;
  try { decisao = r.stdout.trim() === '' ? null : JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch {}
  // Silêncio ou allow: a ferramenta roda (o agente segue a própria permissão).
  const executou = decisao === null || decisao === 'allow';
  resultados.push({ tool: c.tool_use_id, hook: true, decisao, executou, status: r.status, stderr: r.stderr });
}
fs.writeFileSync(saida, JSON.stringify(resultados));
process.stdout.write('fim\\n');
process.exit(0);
`;

interface Resultado {
  tool: string;
  hook: boolean;
  decisao?: string | null;
  executou: boolean;
}

describe('gate de leitura: Read de segredo para no hook, leitura comum passa', () => {
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
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-gate-leitura-'));
    home = path.join(raiz, 'home');
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'claude-falso.cjs');
    // O "segredo" mora num HOME falso: nada aqui toca o `~/.ssh` de verdade.
    const segredo = path.join(raiz, 'home-falso', '.ssh', 'id_rsa');
    saida = path.join(raiz, 'saida.json');
    for (const d of [manifestos, path.join(projeto, 'src'), path.dirname(segredo)]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(segredo, 'chave falsa', 'utf8');
    writeFileSync(path.join(projeto, 'src', 'app.ts'), 'export {};\n', 'utf8');
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
        `    SEGREDO_GATE: "${esc(segredo)}"`,
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
    projetoId = hub.sessions.registerProject(projeto, 'gate de leitura').id;
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

  test('Read de ~/.ssh/id_rsa abre aprovação e, negada, não roda; Read de src/app.ts não abre nada e roda', async () => {
    hub.sessions.gateWaitMs = 30_000;
    const { session, task } = await hub.sessions.start({
      projectId: projetoId,
      agentId: 'claude-falso',
      brief: {
        agent: 'claude-falso',
        objective: 'ler uma chave e um arquivo do projeto',
        isolation: 'none',
        supervision: 'autonomous',
      },
    });

    // Com o matcher antigo, o agente nem chamaria o hook para `Read`: a saída
    // apareceria sem aprovação nenhuma. Esperar pelos dois acusa isso cedo.
    const apv = await esperarAte(
      () =>
        hub.sessions.pendingApprovals(session.id)[0] ??
        (existsSync(saida) ? { id: null, action: readFileSync(saida, 'utf8') } : null),
      'aprovação do gate para a leitura do segredo',
    );
    assert.notEqual(apv.id, null, `o Read do segredo passou sem gate: ${apv.action}`);
    assert.match(apv.action, /id_rsa/);

    const token = ensureOperatorToken(home).token;
    const r = await fetch(`${base}/approvals/${apv.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'denied', by: 'teste' }),
    });
    assert.equal(r.status, 200);

    const resultados = await esperarAte(
      () => (existsSync(saida) ? (JSON.parse(readFileSync(saida, 'utf8')) as Resultado[]) : null),
      'saída do agente falso',
    );
    const [segredo, comum] = resultados;
    assert.equal(segredo?.hook, true, JSON.stringify(resultados));
    assert.equal(segredo?.decisao, 'deny', JSON.stringify(resultados));
    assert.equal(segredo?.executou, false, 'a leitura do segredo NÃO pode ter rodado');

    assert.equal(comum?.hook, true, 'Read comum também passa pelo hook (o matcher é por ferramenta)');
    assert.equal(comum?.decisao, null, 'leitura comum: o hook fica calado, sem allow nem ask');
    assert.equal(comum?.executou, true);

    // Nenhuma aprovação pendente: a do segredo foi negada, e a leitura comum
    // não abriu outra (se tivesse aberto, o hook dela ainda estaria esperando).
    const todas = hub.store.approvals.listPending({ sessionId: session.id });
    assert.equal(todas.length, 0, JSON.stringify(todas));

    await esperarAte(() => {
      const t = hub.store.tasks.get(task.id);
      return t && ['completed', 'failed', 'canceled', 'rejected'].includes(t.state);
    }, 'fim da tarefa');
  });
});
