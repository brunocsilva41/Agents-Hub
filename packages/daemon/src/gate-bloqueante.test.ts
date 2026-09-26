import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';
import { ensureOperatorToken } from './operator-auth.js';
import { ESPERA_DO_GATE_MS, TETO_HTTP_DO_HOOK_MS, TIMEOUT_DO_HOOK_SEC } from './pretool-gate.js';

/**
 * Caminho BLOQUEANTE do gate pré-execução, de ponta a ponta pela API HTTP:
 * o hook fica pendurado em `POST /hooks/pretooluse` enquanto a política pede
 * aprovação humana, e a resposta dele depende de `POST /approvals/:id` (ou da
 * falta dela). Até a vistoria de 2026-09-25 nenhum teste passava por aqui, e
 * o caminho tinha três defeitos: negar matava a sessão, o agente recebia "a
 * política proíbe" em vez do motivo real, e `hub approve` respondia erro depois
 * de já ter liberado a ferramenta.
 */

/** Agente falso: dorme o tempo pedido no 1º argumento e sai com sucesso. */
const SCRIPT_AGENTE = `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
const ms = Number(process.argv[2]) || 1000;
process.stdout.write('agente de teste no ar\\n');
setTimeout(() => process.exit(0), ms);
`;


function manifesto(id: string, script: string, dormirMs: number): string {
  const esc = script.replace(/\\/g, '\\\\');
  return `
id: ${id}
name: ${id}
vendor: Test
description: Agente de teste do gate bloqueante
bin: node
invoke:
  oneShot: ["${esc}", "${dormirMs}"]
  interactive: false
detect:
  args: ["${esc}", "--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 60
`;
}

interface RespostaDoGate {
  permission: string;
  decision: string;
  explanation: string;
  approvalId: string | null;
  sessionId: string | null;
}

async function esperar<T>(
  sonda: () => T | undefined | null | false,
  descricao: string,
  timeoutMs = 10_000,
): Promise<T> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const valor = sonda();
    if (valor) return valor;
    if (Date.now() > limite) throw new Error(`tempo esgotado esperando: ${descricao}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('gate pré-execução: fluxo bloqueante via HTTP', () => {
  let raiz: string;
  let hub: Hub;
  let base: string;
  let projetoId: string;
  let projetoPath: string;

  async function http(
    method: string,
    caminho: string,
    corpo?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // O teste faz o papel do operador (CLI): rotas de aprovação exigem o
    // token do item 1.6. Idempotente — reaproveita o arquivo do daemon.
    const token = ensureOperatorToken(path.join(raiz, 'home')).token;
    const resposta = await fetch(`${base}${caminho}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    const texto = await resposta.text();
    return { status: resposta.status, body: texto ? (JSON.parse(texto) as Record<string, unknown>) : {} };
  }

  /** O que o hook do agente faz: pergunta e fica esperando o veredito. */
  function perguntarAoGate(sessionId: string, command = 'git push origin main'): Promise<RespostaDoGate> {
    return http('POST', '/hooks/pretooluse', {
      sessionId,
      toolName: 'Bash',
      toolInput: { command },
    }).then((r) => {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body as unknown as RespostaDoGate;
    });
  }

  async function aprovacaoPendente(sessionId: string): Promise<string> {
    return esperar(() => {
      const [pendente] = hub.sessions.pendingApprovals(sessionId);
      return pendente?.id;
    }, `aprovação pendente de ${sessionId}`);
  }

  async function iniciar(agentId: string): Promise<{ sessionId: string; taskId: string }> {
    const { session, task } = await hub.sessions.start({
      projectId: projetoId,
      agentId,
      brief: {
        agent: agentId,
        objective: `sessão de teste do gate (${agentId})`,
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: 'semi',
      },
    });
    return { sessionId: session.id, taskId: task.id };
  }

  async function encerrar(sessionId: string): Promise<void> {
    const s = hub.store.sessions.get(sessionId);
    if (s && s.state !== 'killed' && s.state !== 'completed' && s.state !== 'failed') {
      await hub.sessions.cancel(sessionId, 'fim do teste').catch(() => undefined);
    }
  }

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-gate-bloqueante-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'agente.cjs');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    writeFileSync(script, SCRIPT_AGENTE, 'utf8');
    writeFileSync(path.join(manifestos, 'dorminhoco.yaml'), manifesto('dorminhoco', script, 30_000), 'utf8');
    writeFileSync(path.join(manifestos, 'rapido.yaml'), manifesto('rapido', script, 800), 'utf8');

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      port: 0,
      policy: { ...DEFAULT_POLICY, watch: { pauseOn: [], flagOn: [] } },
    });
    const porta = (await hub.start()).port;
    base = `http://127.0.0.1:${porta}`;
    projetoId = hub.sessions.registerProject(projetoPath, 'Gate bloqueante').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('os três relógios: daemon desiste antes do hook, e o hook antes do agente', () => {
    // Se esta ordem inverte, o agente desiste do hook primeiro e RODA a
    // ferramenta que esperava aprovação (medido com o `claude` real).
    assert.ok(ESPERA_DO_GATE_MS + 10_000 <= TETO_HTTP_DO_HOOK_MS);
    assert.ok(TETO_HTTP_DO_HOOK_MS + 10_000 <= TIMEOUT_DO_HOOK_SEC * 1000);
    assert.equal(hub.sessions.gateWaitMs, ESPERA_DO_GATE_MS);
  });

  test('aprovar: o hook recebe allow, POST /approvals responde 200 e a sessão segue viva', async () => {
    hub.sessions.gateWaitMs = 20_000;
    const { sessionId, taskId } = await iniciar('dorminhoco');
    const pidAntes = await esperar(() => hub.store.sessions.get(sessionId)?.pid, 'pid da run');

    const gate = perguntarAoGate(sessionId);
    const apv = await aprovacaoPendente(sessionId);
    assert.equal(hub.store.sessions.get(sessionId)?.state, 'waiting_approval');

    const aprovar = await http('POST', `/approvals/${apv}`, { decision: 'approved', by: 'teste' });
    // Antes: 409 ILLEGAL_STATE ("turno que não aceita mensagem ao vivo") com a
    // ferramenta já liberada.
    assert.equal(aprovar.status, 200, JSON.stringify(aprovar.body));

    const veredito = await gate;
    assert.equal(veredito.permission, 'allow');
    assert.equal(veredito.approvalId, apv);
    assert.match(veredito.explanation, /Liberado por decisão humana/);

    const sessao = hub.store.sessions.get(sessionId);
    assert.equal(sessao?.state, 'running');
    assert.equal(sessao?.pid, pidAntes, 'a run bloqueada no hook é a mesma — nada foi relançado');
    assert.equal(hub.store.tasks.get(taskId)?.state, 'working');

    await encerrar(sessionId);
  });

  test('negar: o hook recebe deny com o motivo humano, e a sessão NÃO é cancelada', async () => {
    hub.sessions.gateWaitMs = 20_000;
    const { sessionId, taskId } = await iniciar('dorminhoco');
    const pidAntes = await esperar(() => hub.store.sessions.get(sessionId)?.pid, 'pid da run');

    const gate = perguntarAoGate(sessionId);
    const apv = await aprovacaoPendente(sessionId);

    const negar = await http('POST', `/approvals/${apv}`, { decision: 'denied', by: 'teste' });
    assert.equal(negar.status, 200, JSON.stringify(negar.body));

    const veredito = await gate;
    assert.equal(veredito.permission, 'deny');
    assert.match(veredito.explanation, /humano negou/i);
    assert.doesNotMatch(veredito.explanation, /política do projeto proíbe/i);

    const sessao = hub.store.sessions.get(sessionId);
    assert.equal(sessao?.state, 'running', 'negar UMA chamada não encerra a sessão');
    assert.equal(sessao?.pid, pidAntes);
    assert.equal(hub.store.tasks.get(taskId)?.state, 'working');

    await encerrar(sessionId);
  });

  test('ninguém responde: deny por falta de resposta, sem matar a sessão', async () => {
    hub.sessions.gateWaitMs = 700;
    const { sessionId, taskId } = await iniciar('dorminhoco');
    await esperar(() => hub.store.sessions.get(sessionId)?.pid, 'pid da run');

    const veredito = await perguntarAoGate(sessionId);
    assert.equal(veredito.permission, 'deny');
    assert.match(veredito.explanation, /ninguém respondeu/i);
    assert.match(veredito.explanation, /não por proibição/i);
    assert.doesNotMatch(veredito.explanation, /política do projeto proíbe/i);
    assert.ok(veredito.approvalId);

    const apv = hub.store.approvals.get(veredito.approvalId!);
    assert.equal(apv?.state, 'denied');
    assert.equal(apv?.resolvedBy, 'tempo esgotado');

    // Antes: sessão `killed` e task `rejected` após o timeout.
    assert.equal(hub.store.sessions.get(sessionId)?.state, 'running');
    assert.equal(hub.store.tasks.get(taskId)?.state, 'working');

    await encerrar(sessionId);
  });

  test('negado pela política: resposta imediata com o texto de proibição', async () => {
    hub.sessions.gateWaitMs = 20_000;
    const original = hub.config.policy;
    // A política padrão não nega nada; um projeto endurecido nega o irreversível.
    hub.config.policy = { ...original, risk: { ...original.risk, irreversible: 'deny' } };
    try {
      const { sessionId } = await iniciar('dorminhoco');
      const inicio = Date.now();
      const veredito = await perguntarAoGate(sessionId);
      assert.ok(Date.now() - inicio < 5_000, 'deny da política não espera ninguém');
      assert.equal(veredito.permission, 'deny');
      assert.equal(veredito.approvalId, null);
      assert.match(veredito.explanation, /política do projeto proíbe/i);
      await encerrar(sessionId);
    } finally {
      hub.config.policy = original;
    }
  });

  test('send e handoff em sessão waiting_approval são recusados citando a aprovação', async () => {
    hub.sessions.gateWaitMs = 20_000;
    const { sessionId } = await iniciar('rapido');

    const gate = perguntarAoGate(sessionId);
    const apv = await aprovacaoPendente(sessionId);

    // A run termina com a aprovação aberta — o cenário da vistoria.
    await esperar(
      () =>
        hub.sessions
          .listEvents(sessionId)
          .some((e) => e.type === 'session.ended' && e.payload['approvalId'] === apv),
      'fim da run com aprovação pendente',
    );
    assert.equal(hub.store.sessions.get(sessionId)?.state, 'waiting_approval');

    const send = await http('POST', `/sessions/${sessionId}/send`, { text: 'faz outra coisa' });
    assert.equal(send.status, 400, JSON.stringify(send.body));
    const erroSend = send.body['error'] as { code: string; message: string };
    assert.equal(erroSend.code, 'ILLEGAL_STATE');
    assert.ok(erroSend.message.includes(apv), erroSend.message);

    const handoff = await http('POST', `/sessions/${sessionId}/handoff`, { agentId: 'dorminhoco' });
    assert.equal(handoff.status, 400, JSON.stringify(handoff.body));
    assert.ok((handoff.body['error'] as { message: string }).message.includes(apv));

    // Nada foi relançado por cima da pendência.
    assert.equal(hub.store.sessions.get(sessionId)?.state, 'waiting_approval');
    assert.equal(hub.store.approvals.get(apv)?.state, 'pending');

    const negar = await http('POST', `/approvals/${apv}`, { decision: 'denied', by: 'teste' });
    assert.equal(negar.status, 200, JSON.stringify(negar.body));
    assert.equal((await gate).permission, 'deny');

    await encerrar(sessionId);
  });

  test('sessão já encerrada: approve vira deny imediato, sem ressuscitar a sessão', async () => {
    hub.sessions.gateWaitMs = 20_000;
    const { sessionId } = await iniciar('dorminhoco');
    await hub.sessions.cancel(sessionId, 'teste');
    const terminal = (st: string | undefined): boolean =>
      st === 'killed' || st === 'failed' || st === 'completed';
    await esperar(() => terminal(hub.store.sessions.get(sessionId)?.state), 'sessão encerrada');

    const inicio = Date.now();
    const veredito = await perguntarAoGate(sessionId);
    assert.ok(Date.now() - inicio < 5_000);
    assert.equal(veredito.permission, 'deny');
    assert.match(veredito.explanation, /já terminou/);
    // Continua terminal: antes, abrir a aprovação a devolvia a `waiting_approval`.
    assert.ok(terminal(hub.store.sessions.get(sessionId)?.state));
    assert.equal(hub.sessions.pendingApprovals(sessionId).length, 0);
  });

  test('por diretório, a raiz ADOTADA de um agente externo não captura o Claude do usuário', async () => {
    const outro = path.join(raiz, 'projeto-adotado');
    mkdirSync(outro, { recursive: true });
    const prj = hub.sessions.registerProject(outro, 'Adotado');
    const adotada = hub.sessions.adoptExternal({ agentId: 'dorminhoco', projectId: prj.id });

    const r = await http('POST', '/hooks/pretooluse', {
      cwd: outro,
      toolName: 'Bash',
      toolInput: { command: 'git push origin main' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body['permission'], 'allow');
    assert.equal(r.body['sessionId'], null);
    assert.equal(hub.sessions.pendingApprovals(adotada.id).length, 0);
  });
});
