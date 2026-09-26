import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AgentDiscovery } from '@agents-hub/core';
import { createHub, type Hub } from '@agents-hub/daemon';
import { HubClient } from './client.js';
import {
  buildImportRequest,
  discoverCommand,
  importCommand,
  parseKinds,
  parseTargets,
  renderDiscoveryTable,
  renderImportResult,
} from './discover-cmd.js';
import { MCP_TARGETS } from './mcp-install.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}
const args = (positional: string[], flags: Args['flags'] = {}): Args => ({ command: 'import', positional, flags });

function d(id: string, over: Partial<AgentDiscovery> = {}): AgentDiscovery {
  return {
    agentId: id,
    installed: true,
    version: '2.0.1',
    binPath: `/bin/${id}`,
    auth: { state: 'present', evidence: [] },
    defaults: { model: 'modelo-x' },
    files: [],
    mcpServers: [
      { name: 'fs', transport: 'stdio', command: 'npx', source: '/x', isHub: false },
      { name: 'agents-hub', transport: 'stdio', command: 'node', source: '/x', isHub: true },
    ],
    instructionFiles: [{ path: '/h/CLAUDE.md', bytes: 10 }],
    warnings: [],
    ...over,
  };
}

describe('hub import — parsing de argumentos', () => {
  test('parseKinds valida cada item e recusa desconhecido', () => {
    assert.deepEqual(parseKinds('instructions,env'), ['instructions', 'env']);
    assert.deepEqual(parseKinds('env,env'), ['env']);
    assert.ok(parseKinds('env,tudo') instanceof Error);
    assert.ok(parseKinds(true) instanceof Error);
    assert.equal(parseKinds(undefined), undefined);
  });

  test('parseTargets separa por vírgula e tira duplicatas', () => {
    assert.deepEqual(parseTargets('codex, cursor,codex'), ['codex', 'cursor']);
    assert.ok(parseTargets(true) instanceof Error);
  });

  test('sem --write é dry-run; com --write não é', () => {
    const plano = buildImportRequest(args(['claude']));
    assert.ok(!(plano instanceof Error));
    assert.equal(plano.dryRun, true);
    const real = buildImportRequest(args(['claude'], { write: true }));
    assert.ok(!(real instanceof Error));
    assert.equal(real.dryRun, false);
  });

  test('kinds padrão = instructions,env; com --to inclui mcp; mcp sem --to é erro', () => {
    const a = buildImportRequest(args(['claude']));
    assert.ok(!(a instanceof Error));
    assert.deepEqual(a.kinds, ['instructions', 'env']);

    const b = buildImportRequest(args(['claude'], { to: 'codex,cursor' }));
    assert.ok(!(b instanceof Error));
    assert.deepEqual(b.kinds, ['instructions', 'env', 'mcp']);
    assert.deepEqual(b.targetAgents, ['codex', 'cursor']);

    const c = buildImportRequest(args(['claude'], { kinds: 'mcp' }));
    assert.ok(c instanceof Error);
    assert.match(c.message, /--to/);
  });

  test('includeEnv/overwrite só vão quando pedidos; agentId é obrigatório', () => {
    const r = buildImportRequest(args(['claude'], { 'include-env': true, overwrite: true, to: 'codex' }));
    assert.ok(!(r instanceof Error));
    assert.equal(r.includeEnv, true);
    assert.equal(r.overwrite, true);
    const s = buildImportRequest(args(['claude'], { to: 'codex' }));
    assert.ok(!(s instanceof Error));
    assert.equal(s.includeEnv, undefined);
    assert.ok(buildImportRequest(args([])) instanceof Error);
  });
});

describe('hub discover / import — renderização', () => {
  test('tabela mostra instalado, versão, auth, modelo, nº de MCP (sem o Hub) e instruções', () => {
    const texto = renderDiscoveryTable([
      d('claude'),
      d('codex', { installed: false, version: null, auth: { state: 'absent', evidence: [] }, defaults: {}, instructionFiles: [], warnings: ['leitor parcial'] }),
    ]);
    const [cab, l1, l2] = texto.split('\n');
    for (const col of ['AGENTE', 'INSTALADO', 'VERSÃO', 'AUTH', 'MODELO PADRÃO', 'MCP', 'INSTRUÇÕES']) assert.ok(cab?.includes(col), col);
    assert.match(l1 ?? '', /claude\s+sim\s+2\.0\.1\s+presente\s+modelo-x\s+1\s+1 arquivo\(s\)/);
    assert.match(l2 ?? '', /codex\s+não\s+-\s+ausente\s+-\s+1\s+-|codex\s+não\s+-\s+ausente\s+-\s+1/);
    assert.ok(texto.includes('leitor parcial'));
  });

  test('plano de dry-run diz que nada foi gravado e mostra o comando para aplicar', () => {
    const texto = renderImportResult(
      {
        agentId: 'claude',
        dryRun: true,
        items: [{ kind: 'mcp', description: 'adicionar 1 servidor(es) MCP: fs', target: '/h/.cursor/mcp.json', applied: false }],
        skipped: [{ what: 'mcp:web → cursor', reason: 'já existe no destino; mantido como está' }],
      },
      'hub import claude --write',
    );
    assert.match(texto, /dry-run/);
    assert.match(texto, /adicionar 1 servidor/);
    assert.match(texto, /\.cursor[\\/]mcp\.json|\.cursor\/mcp\.json/);
    assert.match(texto, /já existe no destino/);
    assert.match(texto, /nada foi gravado/);
    assert.match(texto, /hub import claude --write/);
  });

  test('resultado gravado não promete "nada foi gravado"', () => {
    const texto = renderImportResult({ agentId: 'claude', dryRun: false, items: [{ kind: 'env', description: 'X=1', target: 'project-env', applied: true }], skipped: [] }, 'x');
    assert.ok(!texto.includes('nada foi gravado'));
    assert.ok(texto.includes('✓'));
  });
});

describe('hub discover / import — contra o daemon', () => {
  let raiz: string;
  let hub: Hub;
  let client: HubClient;
  let projeto: string;
  let home: string;
  const SEGREDO = 'SEGREDO-CLI-0123456789abcdef';


  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-abs-'));
    home = path.join(raiz, 'home');
    projeto = path.join(raiz, 'projeto');
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projeto, { recursive: true });
    mkdirSync(home, { recursive: true });
    const script = path.join(raiz, 'a.cjs').replace(/\\/g, '\\\\');
    writeFileSync(path.join(raiz, 'a.cjs'), "if (process.argv.includes('--version')) process.stdout.write('1\\n');\n");
    for (const id of ['claude', 'cursor']) {
      writeFileSync(
        path.join(manifestos, `${id}.yaml`),
        `id: ${id}\nname: ${id}\nvendor: T\ndescription: t\nbin: node\ninvoke:\n  oneShot: ["${script}"]\n  interactive: false\ndetect:\n  args: ["${script}", "--version"]\ncapabilities:\n  - code-edit\nsession:\n  strategy: replay\nstream:\n  format: text\n  mapper: generic-text\ndefaults:\n  isolation: none\n  timeoutSeconds: 30\n`,
      );
    }
    hub = createHub(
      { home: path.join(raiz, 'hh'), manifestsDir: manifestos, port: 0 },
      {
        homeDir: home,
        discoverAgent: async (id) =>
          d(id, {
            mcpServers: [{ name: 'fs', transport: 'stdio', command: 'npx', env: { K: SEGREDO }, source: '/x', isHub: false }],
            instructionFiles: [],
          }),
      },
    );
    const { host, port } = await hub.start();
    client = new HubClient(`http://${host}:${port}`, { token: hub.operatorToken });
  });

  after(async () => {
    await hub.shutdown();
    rmSync(raiz, { recursive: true, force: true });
  });

  async function capturar(fn: () => Promise<void>): Promise<string> {
    const linhas: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void linhas.push(a.join(' '));
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return linhas.join('\n');
  }

  test('hub discover --json não contém o segredo e lista os agentes', async () => {
    const saida = await capturar(() => discoverCommand(client, { command: 'discover', positional: [], flags: { json: true } }));
    assert.ok(!saida.includes(SEGREDO));
    const lista = JSON.parse(saida) as AgentDiscovery[];
    assert.equal(lista.length, 2);
  });

  test('hub import sem --write imprime o plano e não grava; com --write grava com .bak/merge', async () => {
    const resolver = async (): Promise<string> => (await client.addProject(projeto)).project.id;

    const plano = await capturar(() =>
      importCommand(client, args(['claude'], { kinds: 'mcp', to: 'cursor' }), resolver),
    );
    assert.match(plano, /dry-run/);
    assert.match(plano, /nada foi gravado/);
    assert.ok(!plano.includes(SEGREDO));
    assert.ok(!existsSync(path.join(home, '.cursor', 'mcp.json')), 'dry-run não escreveu');

    const feito = await capturar(() =>
      importCommand(client, args(['claude'], { kinds: 'mcp', to: 'cursor', write: true }), resolver),
    );
    assert.ok(!feito.includes(SEGREDO));
    assert.ok(existsSync(path.join(home, '.cursor', 'mcp.json')), '--write gravou');
  });
});

describe('reexport do mcp-install após a extração para o daemon', () => {
  test('MCP_TARGETS continua com todos os agentes e caminhos', () => {
    assert.deepEqual(
      MCP_TARGETS.map((t) => t.agentId),
      ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'kimi', 'mimo', 'antigravity', 'openclaude'],
    );
    assert.equal(MCP_TARGETS.find((t) => t.agentId === 'opencode')?.format, 'json-mcp');
  });
});
