import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { newId, nowIso, type Session } from '@agents-hub/core';
import { createHub, type Hub } from '@agents-hub/daemon';
import { HubClient } from '@agents-hub/client';
import { CallerIdentity } from './caller.js';
import { buildMcpServer } from './server.js';

/**
 * `port: 0` não basta: a guarda de borda do daemon compara o `Host` da
 * requisição contra `config.port`, só conhecido depois do `listen`. Mesma
 * técnica de `sse-http.test.ts` no pacote do daemon.
 */
function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const endereco = srv.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      srv.close(() => resolve(porta));
    });
  });
}

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const r = result as ToolTextResult;
  return r.content.map((c) => c.text).join('\n');
}

/**
 * As duas ferramentas novas do audit de consistência: `hub_session_pause`
 * (rota HTTP e client já existiam, nenhuma superfície MCP expunha) e
 * `hub_workflow_run` (o motor de workflow só era acionável pela CLI). Os dois
 * testes rodam contra um daemon real — via `InMemoryTransport`, sem stdio —
 * porque é o daemon quem decide os desfechos que importam (estado terminal,
 * validação do workflow, orquestração de passos).
 */
describe('MCP: hub_session_pause e hub_workflow_run', () => {
  let hub: Hub;
  let raiz: string;
  let client: Client;
  let hubClient: HubClient;
  let projectId: string;
  let projetoPath: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });

    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(
      script,
      `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.stdout.write('AGENTE OK\\n');
process.exit(0);
`,
      'utf8',
    );
    writeFileSync(
      path.join(manifestos, 'agente-mcp.yaml'),
      `
id: agente-mcp
name: agente-mcp
vendor: Test
description: Agente de teste para as tools de MCP
bin: node
invoke:
  oneShot: ["${script.replace(/\\/g, '\\\\')}"]
  interactive: false
detect:
  args: ["${script.replace(/\\/g, '\\\\')}", "--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 30
`,
      'utf8',
    );

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      port: await portaLivre(),
    });
    const { host, port } = await hub.start();
    hubClient = new HubClient(`http://${host}:${port}`);
    projectId = hub.sessions.registerProject(projetoPath, 'Projeto MCP').id;

    const caller = new CallerIdentity(hubClient, 'agente-mcp', projetoPath, 'sessao-de-teste-fixa');
    const server = buildMcpServer(hubClient, caller);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'teste', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function semearRodando(): Session {
    const id = newId('ses');
    const session: Session = {
      id,
      projectId,
      agentId: 'agente-mcp',
      parentId: null,
      rootId: id,
      depth: 0,
      path: [`agente-mcp:${id}`],
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: projetoPath,
      nativeSessionId: null,
      title: 'sessão de teste do MCP',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);
    return session;
  }

  test('hub_session_pause pausa uma sessão rodando', async () => {
    const session = semearRodando();

    const result = await client.callTool({
      name: 'hub_session_pause',
      arguments: { session_id: session.id },
    });

    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /pausada/);
    assert.equal(hub.store.sessions.get(session.id)?.state, 'paused');
  });

  test('hub_session_pause devolve erro descritivo para sessão já terminada', async () => {
    const id = newId('ses');
    hub.store.sessions.create({
      id,
      projectId,
      agentId: 'agente-mcp',
      parentId: null,
      rootId: id,
      depth: 0,
      path: [`agente-mcp:${id}`],
      state: 'completed',
      mode: 'semi',
      isolation: 'none',
      workdir: projetoPath,
      nativeSessionId: null,
      title: 'sessão já concluída',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: nowIso(),
      pid: null,
    });

    const result = await client.callTool({
      name: 'hub_session_pause',
      arguments: { session_id: id },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /já terminou/i);
    assert.equal(hub.store.sessions.get(id)?.state, 'completed');
  });

  test('hub_workflow_run recusa YAML inválido sem despachar nenhuma sessão', async () => {
    const antes = hub.store.sessions.list().length;

    const result = await client.callTool({
      name: 'hub_workflow_run',
      arguments: {
        yaml: 'name: workflow-quebrado\nsteps: []\n',
        project: projetoPath,
      },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /inválido/i);
    assert.equal(hub.store.sessions.list().length, antes, 'não deveria ter criado nenhuma sessão');
  });

  test(
    'hub_workflow_run executa um workflow de um passo só até o fim',
    { timeout: 30_000 },
    async () => {
      const yaml = `
name: workflow-de-um-passo
steps:
  - id: unico
    agent: agente-mcp
    objective: "Fazer a única coisa que este workflow pede, de ponta a ponta"
    isolation: none
`;

      const result = await client.callTool({
        name: 'hub_workflow_run',
        arguments: { yaml, project: projetoPath },
      });

      const texto = textOf(result);
      assert.equal(result.isError, undefined, texto);
      assert.match(texto, /workflow "workflow-de-um-passo"/);
      assert.match(texto, /1\/1 passos concluídos/);
      assert.match(texto, /unico \(agente-mcp\): ok/);
    },
  );
});
