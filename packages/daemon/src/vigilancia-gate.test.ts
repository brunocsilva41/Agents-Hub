import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Vigilância reativa × gate pré-execução (teste real de 2026-09-29, claude
 * 2.1.285, achado ALTO): o Claude emite o `tool_use` no stream ANTES de
 * chamar o PreToolUse. A vigilância via o `git push`, abria aprovação "watch"
 * dizendo que JÁ tinha executado (falso) e matava a sessão — negar o push
 * matava tudo, contra "negar nega só a chamada, a sessão segue".
 *
 * O agente falso reproduz a ordem do real: escreve o `tool_use` no stdout,
 * espera o daemon lê-lo, e só então roda o comando do hook do `--settings`
 * (o `bin.js hook` desta instalação, de verdade). Executa a ferramenta só se
 * o hook permitir, devolve o `tool_result` e termina o turno com `result`.
 * Sem `--settings` (agente sem gate) ele fica "rodando o push" até ser morto.
 */

const AGENTE = `
const fs = require('node:fs');
const cp = require('node:child_process');
if (process.argv.includes('--version')) { process.stdout.write('2.1.285\\n'); process.exit(0); }
const saida = process.env.SAIDA_AGENTE;
const linha = (o) => fs.writeSync(1, JSON.stringify(o) + '\\n');
const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
linha({ type: 'system', subtype: 'init', session_id: 'nativo-falso', tools: ['Bash', 'PowerShell'] });
linha({ type: 'assistant', message: { id: 'msg_1', content: [
  { type: 'tool_use', id: 'toolu_push_1', name: 'Bash', input: { command: 'git push origin main' } },
] } });
dormir(500);
const i = process.argv.indexOf('--settings');
if (i < 0) { dormir(60000); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
const comando = cfg.hooks.PreToolUse[0].hooks[0].command;
const pedido = JSON.stringify({
  session_id: 'nativo-falso',
  cwd: process.cwd(),
  tool_name: 'Bash',
  tool_input: { command: 'git push origin main' },
  tool_use_id: 'toolu_push_1',
});
const r = cp.spawnSync(comando, { shell: true, input: pedido, encoding: 'utf8' });
let decisao = null;
try { decisao = JSON.parse(r.stdout).hookSpecificOutput; } catch {}
const permitiu = decisao !== null && decisao.permissionDecision === 'allow';
if (permitiu) fs.writeFileSync(saida + '.executou', 'x');
fs.writeFileSync(saida, JSON.stringify({ decisao, status: r.status, stderr: r.stderr }));
linha({ type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: 'toolu_push_1', is_error: !permitiu,
    content: permitiu ? 'ok' : String(decisao && decisao.permissionDecisionReason) },
] } });
linha({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'o push foi negado; relato e paro' }] } });
linha({ type: 'result', subtype: 'success', is_error: false, result: 'push negado pelo humano', session_id: 'nativo-falso', total_cost_usd: 0, usage: {} });
process.exit(0);
`;

function manifesto(id: string, script: string, saida: string, comGate: boolean): string {
  const esc = (s: string): string => s.replaceAll('\\', '\\\\');
  return [
    `id: ${id}`,
    `name: ${id}`,
    'bin: node',
    'detect:',
    `  args: ["${esc(script)}", "--version"]`,
    'invoke:',
    `  oneShot: ["${esc(script)}"]`,
    '  stdinPrompt: true',
    '  env:',
    `    SAIDA_AGENTE: "${esc(saida)}"`,
    ...(comGate ? ['gate:', '  settingsArgs: ["--settings", "{{settingsFile}}"]'] : []),
    'session:',
    '  strategy: native',
    'stream:',
    '  format: jsonl',
    '  mapper: claude',
    'defaults:',
    '  isolation: none',
    '  timeoutSeconds: 120',
    '',
  ].join('\n');
}

describe('vigilância não atropela o gate pré-execução', () => {
  let raiz: string;
  let home: string;
  let hub: Hub;
  let projetoId: string;
  let saidaGateado: string;
  const envAntes = {
    home: process.env['AGENTS_HUB_HOME'],
    porta: process.env['AGENTS_HUB_PORT'],
    auto: process.env['AGENTS_HUB_NO_AUTOSTART'],
  };

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-vigilancia-gate-'));
    home = path.join(raiz, 'home');
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'claude-falso.cjs');
    saidaGateado = path.join(raiz, 'saida-gateado.json');
    for (const d of [manifestos, projeto]) mkdirSync(d, { recursive: true });
    writeFileSync(script, AGENTE, 'utf8');
    writeFileSync(
      path.join(manifestos, 'claude-gateado.yaml'),
      manifesto('claude-gateado', script, saidaGateado, true),
      'utf8',
    );
    writeFileSync(
      path.join(manifestos, 'agente-sem-gate.yaml'),
      manifesto('agente-sem-gate', script, path.join(raiz, 'saida-sem-gate.json'), false),
      'utf8',
    );

    // Política PADRÃO, vigilância inclusa (pauseOn: irreversible): é ela que
    // pausava o push antes do hook.
    hub = createHub({
      home,
      manifestsDir: manifestos,
      port: 0,
      webRoot: path.join(raiz, 'sem-web'),
      policy: DEFAULT_POLICY,
    });
    const porta = (await hub.start()).port;
    // O hook (processo neto do teste) acha o daemon pelo ambiente herdado.
    process.env['AGENTS_HUB_HOME'] = home;
    process.env['AGENTS_HUB_PORT'] = String(porta);
    process.env['AGENTS_HUB_NO_AUTOSTART'] = '1';
    projetoId = hub.sessions.registerProject(projeto, 'vigilância × gate').id;
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

  test('agente gateado: tool_use de git push no stream não abre "watch"; o gate pergunta, a negativa chega ao agente e a sessão conclui', async () => {
    hub.sessions.gateWaitMs = 30_000;
    const { session, task } = await hub.sessions.start({
      projectId: projetoId,
      agentId: 'claude-gateado',
      brief: {
        agent: 'claude-gateado',
        objective: 'empurrar para a main',
        isolation: 'none',
        supervision: 'semi',
      },
    });

    const apv = await esperarAte(
      () => hub.sessions.pendingApprovals(session.id)[0],
      'aprovação para o git push',
    );
    assert.equal(
      apv.detail['kind'],
      'tool-call',
      `quem pergunta é o gate, não a vigilância: ${JSON.stringify(apv)}`,
    );
    assert.match(apv.action, /git push origin main/);
    assert.doesNotMatch(apv.action, /executou/);

    await hub.sessions.resolveApproval(apv.id, 'denied', 'teste');

    const resultado = await esperarAte(
      () =>
        existsSync(saidaGateado)
          ? (JSON.parse(readFileSync(saidaGateado, 'utf8')) as {
              decisao: { permissionDecision?: string } | null;
            })
          : null,
      'resposta do hook no agente falso',
    );
    assert.equal(resultado.decisao?.permissionDecision, 'deny', JSON.stringify(resultado));
    assert.equal(existsSync(`${saidaGateado}.executou`), false, 'o push NÃO pode ter rodado');

    const fim = await esperarAte(() => {
      const t = hub.store.tasks.get(task.id);
      return t && ['completed', 'failed', 'canceled', 'rejected'].includes(t.state) ? t : null;
    }, 'fim da tarefa');
    assert.equal(fim.state, 'completed', 'negar a chamada não pode derrubar a tarefa');
    const estado = hub.store.sessions.get(session.id)?.state;
    assert.ok(estado !== 'killed' && estado !== 'failed', `sessão não pode ser morta: ${estado}`);

    const vigilancia = hub.store.events
      .list({ sessionId: session.id, types: ['approval.requested'] })
      .filter((e) => e.payload['kind'] === 'watch');
    assert.deepEqual(vigilancia, [], 'nenhuma aprovação "watch" para o evento que o gate decide');
  });

  test('agente SEM gate: o mesmo tool_use continua pausando pela vigilância (não afrouxou)', async () => {
    const { session, task } = await hub.sessions.start({
      projectId: projetoId,
      agentId: 'agente-sem-gate',
      brief: {
        agent: 'agente-sem-gate',
        objective: 'empurrar para a main',
        isolation: 'none',
        supervision: 'semi',
      },
    });

    const apv = await esperarAte(
      () => hub.sessions.pendingApprovals(session.id)[0],
      'aprovação da vigilância',
    );
    assert.equal(apv.detail['kind'], 'watch');
    assert.equal(apv.detail['alreadyExecuted'], true);
    assert.match(apv.action, /git push origin main/);

    await hub.sessions.resolveApproval(apv.id, 'denied', 'teste');
    await esperarAte(() => {
      const t = hub.store.tasks.get(task.id);
      return t && ['completed', 'failed', 'canceled', 'rejected'].includes(t.state);
    }, 'fim da tarefa');
  });
});
