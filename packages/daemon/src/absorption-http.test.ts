import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AgentDiscovery } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

const SEGREDO = 'SEGREDO-HTTP-plantado-9876543210';


function manifesto(id: string, script: string): string {
  const s = script.replace(/\\/g, '\\\\');
  return `
id: ${id}
name: ${id}
vendor: Test
description: Agente de teste ${id}
bin: node
invoke:
  oneShot: ["${s}"]
  interactive: false
detect:
  args: ["${s}", "--version"]
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
`;
}

/**
 * Rotas de descoberta e importação contra o daemon HTTP de verdade, com o leitor
 * de descoberta substituído por um fake (o real lê o disco do usuário).
 */
describe('GET /discovery e POST /projects/:id/import', () => {
  let raiz: string;
  let home: string;
  let projetoPath: string;
  let hub: Hub;
  let baseUrl: string;
  let projectId: string;
  let chamadas = 0;

  const post = (url: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      // Import exige o token de operador (item 1.6).
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hub.operatorToken}` },
      body: JSON.stringify(body),
    });

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-abs-http-'));
    home = path.join(raiz, 'home');
    projetoPath = path.join(raiz, 'projeto');
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    mkdirSync(home, { recursive: true });

    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(script, "if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); } process.exit(0);\n");
    for (const id of ['claude', 'cursor']) writeFileSync(path.join(manifestos, `${id}.yaml`), manifesto(id, script));

    const instr = path.join(raiz, 'CLAUDE.md');
    writeFileSync(instr, 'Explique a decisão antes de aplicar.');

    const fake = async (id: string): Promise<AgentDiscovery> => {
      chamadas += 1;
      const vazado = id === 'claude';
      return {
        agentId: id,
        installed: true,
        version: '9.9.9',
        binPath: `/bin/${id}`,
        auth: { state: 'present', evidence: [] },
        defaults: id === 'claude' ? { model: 'claude-x' } : {},
        files: [],
        // O fake VAZA um valor de propósito: a rota tem de mascarar mesmo assim.
        mcpServers: vazado
          ? [{ name: 'fs', transport: 'stdio', command: 'npx', args: ['fs'], env: { FS_TOKEN: SEGREDO }, source: '/x', isHub: false }]
          : [],
        instructionFiles: vazado ? [{ path: instr, bytes: 36 }] : [],
        warnings: [],
      };
    };

    hub = createHub(
      { home: path.join(raiz, 'hubhome'), manifestsDir: manifestos, port: 0 },
      { discoverAgent: fake, homeDir: home },
    );
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;
    projectId = hub.sessions.registerProject(projetoPath, 'Projeto').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza oportunista */
    }
  });

  test('GET /discovery lista todos, mascara env vazado e usa cache; ?refresh=1 relê', async () => {
    chamadas = 0;
    const r1 = await fetch(`${baseUrl}/discovery`);
    assert.equal(r1.status, 200);
    const texto = await r1.text();
    assert.ok(!texto.includes(SEGREDO), 'segredo vazado pelo leitor não pode sair na resposta');
    const corpo = JSON.parse(texto) as { agents: AgentDiscovery[] };
    assert.deepEqual(corpo.agents.map((a) => a.agentId).sort(), ['claude', 'cursor']);
    const fs = corpo.agents.find((a) => a.agentId === 'claude')?.mcpServers[0];
    assert.deepEqual(fs?.env, { FS_TOKEN: '***' });

    const depois1 = chamadas;
    assert.equal(depois1, 2);
    await fetch(`${baseUrl}/discovery`);
    assert.equal(chamadas, depois1, 'segunda chamada vem do cache');
    await fetch(`${baseUrl}/discovery?refresh=1`);
    assert.equal(chamadas, depois1 + 2, 'refresh=1 relê tudo');
  });

  test('GET /discovery/:agentId e 404 para agente desconhecido', async () => {
    const ok = await fetch(`${baseUrl}/discovery/claude`);
    assert.equal(ok.status, 200);
    const { agent } = (await ok.json()) as { agent: AgentDiscovery };
    assert.equal(agent.version, '9.9.9');

    const nao = await fetch(`${baseUrl}/discovery/nao-existe`);
    assert.equal(nao.status, 404);
  });

  test('import: dryRun é o PADRÃO (omitido) e não escreve nada em disco', async () => {
    const res = await post(`/projects/${projectId}/import`, {
      agentId: 'claude',
      kinds: ['instructions', 'env', 'mcp'],
      targetAgents: ['cursor'],
      includeEnv: true,
    });
    assert.equal(res.status, 200);
    const texto = await res.text();
    assert.ok(!texto.includes(SEGREDO));
    const corpo = JSON.parse(texto) as { dryRun: boolean; items: { applied: boolean }[] };
    assert.equal(corpo.dryRun, true);
    assert.ok(corpo.items.length >= 3);
    assert.ok(corpo.items.every((i) => !i.applied));
    assert.ok(!existsSync(path.join(projetoPath, '.agents-hub', 'config.yaml')));
    assert.ok(!existsSync(path.join(home, '.cursor')));
  });

  test('import com dryRun:false grava instrução e env no projeto e MCP no cursor (sem valor de env)', async () => {
    const res = await post(`/projects/${projectId}/import`, {
      agentId: 'claude',
      kinds: ['instructions', 'env', 'mcp'],
      targetAgents: ['cursor'],
      dryRun: false,
    });
    assert.equal(res.status, 200);
    const texto = await res.text();
    assert.ok(!texto.includes(SEGREDO));
    const corpo = JSON.parse(texto) as { dryRun: boolean; items: { kind: string; applied: boolean }[] };
    assert.equal(corpo.dryRun, false);
    assert.ok(corpo.items.every((i) => i.applied));

    // Item 1.9 do GOAL: o que o usuário importa pelo Hub vai para o banco do
    // Hub (contexto confiável), não para o config.yaml versionado do repo.
    const ctxRes = await fetch(`${baseUrl}/projects/${projectId}/context`);
    const { context } = (await ctxRes.json()) as {
      context: { prompts?: Record<string, string>; env?: Record<string, Record<string, string>> };
    };
    assert.match(Object.values(context.prompts ?? {}).join(' '), /Explique a decisão antes de aplicar\./);
    assert.equal(
      Object.values(context.env ?? {}).find((e) => e['ANTHROPIC_MODEL'] !== undefined)?.['ANTHROPIC_MODEL'],
      'claude-x',
    );
    assert.equal(existsSync(path.join(projetoPath, '.agents-hub', 'config.yaml')), false);
    const cursor = readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8');
    assert.ok(cursor.includes('"fs"'));
    assert.ok(!cursor.includes(SEGREDO));
  });

  test('import: validação — projeto inexistente 404, mcp sem targetAgents 422, corpo inválido 422', async () => {
    const semProjeto = await post('/projects/prj_naoexiste/import', { agentId: 'claude', kinds: ['env'] });
    assert.equal(semProjeto.status, 404);

    const semAlvo = await post(`/projects/${projectId}/import`, { agentId: 'claude', kinds: ['mcp'] });
    assert.equal(semAlvo.status, 422);

    const invalido = await post(`/projects/${projectId}/import`, { agentId: 'claude', kinds: ['tudo'] });
    assert.equal(invalido.status, 422);

    const extra = await post(`/projects/${projectId}/import`, { agentId: 'claude', kinds: ['env'], path: '/etc' });
    assert.equal(extra.status, 422);
  });
});
