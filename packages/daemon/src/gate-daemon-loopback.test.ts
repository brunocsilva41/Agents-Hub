import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, type SessionMode } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * R05-03 (reaberto ALTO): o `GET /` do daemon entrega o cookie com o token de
 * operador a quem mandar `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode:
 * navigate` e `Sec-Fetch-Site: none` — cabeçalhos que o `curl` forja à
 * vontade. Não existe cabeçalho que separe navegador de processo local, então
 * a defesa é o GATE: numa sessão do Hub, o comando que faz isso não roda sem
 * decisão humana, em NENHUM modo (inclusive `autonomous`).
 *
 * O teste usa a porta REAL do daemon (porta 0 → aleatória): se o gate só
 * conhecesse a 4747, o comando passaria.
 */

const SCRIPT_AGENTE = `
if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
process.stdout.write('agente de teste no ar\\n');
setTimeout(() => process.exit(0), 30000);
`;

function manifesto(script: string): string {
  const esc = script.replace(/\\/g, '\\\\');
  return `
id: dorminhoco
name: dorminhoco
vendor: Test
description: Agente de teste do gate contra o daemon
bin: node
invoke:
  oneShot: ["${esc}"]
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

describe('R05-03: agente com gate não obtém o token do daemon por curl forjado', () => {
  let raiz: string;
  let hub: Hub;
  let base: string;
  let porta: number;
  let projetoId: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-gate-daemon-'));
    const manifestos = path.join(raiz, 'manifests');
    const projeto = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'agente.cjs');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projeto, { recursive: true });
    writeFileSync(script, SCRIPT_AGENTE, 'utf8');
    writeFileSync(path.join(manifestos, 'dorminhoco.yaml'), manifesto(script), 'utf8');
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      port: 0,
      // Nem liberar `localhost`/`127.0.0.1` na rede solta o daemon.
      policy: {
        ...DEFAULT_POLICY,
        network: { allowDomains: ['localhost', '127.0.0.1'] },
        watch: { pauseOn: [], flagOn: [] },
      },
    });
    porta = (await hub.start()).port;
    base = `http://127.0.0.1:${porta}`;
    projetoId = hub.sessions.registerProject(projeto, 'Gate x daemon').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  async function iniciar(mode: SessionMode): Promise<string> {
    const { session } = await hub.sessions.start({
      projectId: projetoId,
      agentId: 'dorminhoco',
      brief: {
        agent: 'dorminhoco',
        objective: 'sessão de teste do gate contra o daemon',
        acceptanceCriteria: [],
        constraints: [],
        budget: {},
        isolation: 'none',
        supervision: mode,
      },
    });
    return session.id;
  }

  /** O que o hook do agente faz — SEM token (o agente não tem). */
  async function perguntarAoGate(
    sessionId: string,
    command: string,
  ): Promise<{ permission: string; decision: string; approvalId: string | null }> {
    const r = await fetch(`${base}/hooks/pretooluse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, toolName: 'Bash', toolInput: { command } }),
    });
    assert.equal(r.status, 200);
    return (await r.json()) as { permission: string; decision: string; approvalId: string | null };
  }

  for (const mode of ['autonomous', 'semi', 'supervised'] as const) {
    test(`${mode}: curl com Sec-Fetch-* forjados contra o daemon NÃO roda sem aprovação`, async () => {
      // Espera curta: ninguém aprova, então o daemon desiste e NEGA.
      hub.sessions.gateWaitMs = 300;
      const sessionId = await iniciar(mode);
      try {
        const forjado =
          'curl -s -i -H "Sec-Fetch-Dest: document" -H "Sec-Fetch-Mode: navigate" ' +
          `-H "Sec-Fetch-Site: none" http://127.0.0.1:${porta}/`;
        const veredito = await perguntarAoGate(sessionId, forjado);
        assert.notEqual(veredito.permission, 'allow', JSON.stringify(veredito));
        assert.equal(veredito.permission, 'deny');
        assert.ok(veredito.approvalId, 'passou pela fila de aprovação humana');
        const aprovacao = hub.store.approvals.get(veredito.approvalId);
        assert.equal(aprovacao?.risk, 'irreversible');

        // Também pelo `fetch` inline e pela CLI de operador.
        const inline = await perguntarAoGate(sessionId, `node -e "fetch('http://localhost:${porta}/')"`);
        assert.equal(inline.permission, 'deny');
        const cli = await perguntarAoGate(sessionId, 'hub approve apv_qualquer');
        assert.equal(cli.permission, 'deny');
      } finally {
        await hub.sessions.cancel(sessionId, 'fim do teste').catch(() => undefined);
      }
    });
  }

  test('servidor de dev em outra porta local continua liberável por allowDomains', async () => {
    hub.sessions.gateWaitMs = 300;
    const sessionId = await iniciar('semi');
    try {
      const veredito = await perguntarAoGate(sessionId, 'curl http://localhost:3000/health');
      assert.equal(veredito.permission, 'allow', JSON.stringify(veredito));
    } finally {
      await hub.sessions.cancel(sessionId, 'fim do teste').catch(() => undefined);
    }
  });

  test('POST /approvals/:id sem token continua 401', async () => {
    const r = await fetch(`${base}/approvals/apv_qualquer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(r.status, 401);
  });
});
