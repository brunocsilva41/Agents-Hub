import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseToml } from '@agents-hub/adapters';
import {
  addMcpServers,
  existingServerNames,
  mcpTargets,
  tomlServerNames,
  upsertMcpServer,
  type PortableMcpServer,
} from './mcp-config.js';

describe('addMcpServers — merge sem duplicar nem apagar', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-mcpcfg-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const targets = mcpTargets('/h');
  const cursor = targets.find((t) => t.agentId === 'cursor')!;
  const codex = targets.find((t) => t.agentId === 'codex')!;
  const opencode = targets.find((t) => t.agentId === 'opencode')!;

  test('JSON: nome existente fica intacto, novo entra, duplicata na entrada conta uma vez, .bak criado', () => {
    const f = path.join(dir, 'a', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    const original = JSON.stringify({ x: 1, mcpServers: { a: { command: 'ORIGINAL' } } });
    writeFileSync(f, original);

    const out = addMcpServers(cursor, f, [
      { name: 'a', transport: 'stdio', command: 'NOVO' },
      { name: 'b', transport: 'stdio', command: 'b', args: ['1'] },
      { name: 'b', transport: 'stdio', command: 'b2' },
    ]);
    const doc = JSON.parse(readFileSync(f, 'utf8')) as { x: number; mcpServers: Record<string, { command: string }> };
    assert.equal(doc.x, 1);
    assert.equal(doc.mcpServers['a']?.command, 'ORIGINAL');
    assert.equal(doc.mcpServers['b']?.command, 'b');
    assert.deepEqual(out.added, ['b']);
    assert.deepEqual(out.existing.sort(), ['a', 'b']);
    assert.equal(out.action, 'merged');
    assert.match(out.backup ?? '', /mcp\.json\.bak-\d{8}-\d{6}$/);
    assert.equal(readFileSync(out.backup!, 'utf8'), original);
  });

  test('nada a adicionar -> unchanged, arquivo intocado e sem .bak novo', () => {
    const f = path.join(dir, 'b', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    const original = '{"mcpServers":{"a":{"command":"x"}}}';
    writeFileSync(f, original);
    const out = addMcpServers(cursor, f, [{ name: 'a', transport: 'stdio', command: 'y' }]);
    assert.equal(out.action, 'unchanged');
    assert.equal(readFileSync(f, 'utf8'), original);
    assert.deepEqual(backupsDe(f), []);
  });

  test('arquivo inexistente é criado (sem .bak)', () => {
    const f = path.join(dir, 'c', 'mcp.json');
    const out = addMcpServers(cursor, f, [{ name: 'a', transport: 'http', url: 'https://x/mcp' }]);
    assert.equal(out.action, 'created');
    assert.equal(out.backup, null);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { mcpServers: { a: { url: 'https://x/mcp' } } });
  });

  test('OpenCode usa a chave "mcp" e o formato local/remote', () => {
    const f = path.join(dir, 'd', 'opencode.json');
    addMcpServers(opencode, f, [
      { name: 'l', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } },
      { name: 'r', transport: 'http', url: 'https://x' },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), {
      mcp: {
        l: { type: 'local', command: ['npx', '-y', 'x'], environment: { K: 'v' }, enabled: true },
        r: { type: 'remote', url: 'https://x', enabled: true },
      },
    });
  });

  test('TOML: detecta nomes (nu, entre aspas e subtabela) e não duplica', () => {
    const texto = '[mcp_servers.a]\ncommand="x"\n\n[mcp_servers."b.c"]\ncommand="y"\n\n[mcp_servers.d.env]\nK="v"\n';
    assert.deepEqual([...tomlServerNames(texto)].sort(), ['a', 'b.c', 'd']);

    const f = path.join(dir, 'e', 'config.toml');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, texto);
    const out = addMcpServers(codex, f, [
      { name: 'a', transport: 'stdio', command: 'NOVO' },
      { name: 'e', transport: 'stdio', command: 'npx', args: ['z'], env: { T: 'q' } },
    ]);
    const novo = readFileSync(f, 'utf8');
    assert.ok(novo.startsWith(texto));
    assert.deepEqual(out.added, ['e']);
    assert.match(novo, /\[mcp_servers\.e\]\ncommand = "npx"\nargs = \["z"\]\nenv = \{ T = "q" \}/);
    assert.equal((novo.match(/\[mcp_servers\.a\]/g) ?? []).length, 1);
    assert.equal(readFileSync(out.backup!, 'utf8'), texto);
    assert.deepEqual([...existingServerNames(codex, f)].sort(), ['a', 'b.c', 'd', 'e']);
  });

  test('JSON inválido: lança e não toca no arquivo', () => {
    const f = path.join(dir, 'f', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '{oops');
    assert.throws(() => addMcpServers(cursor, f, [{ name: 'a', transport: 'stdio', command: 'x' }]), /JSON válido/);
    assert.equal(readFileSync(f, 'utf8'), '{oops');
    assert.deepEqual(backupsDe(f), []);
  });
});

/** Backups versionados (`<arquivo>.bak-*`) ao lado de `file`, em ordem. */
function backupsDe(file: string): string[] {
  const dir = path.dirname(file);
  if (!existsSync(dir)) return [];
  const base = `${path.basename(file)}.bak`;
  return readdirSync(dir)
    .filter((n) => n.startsWith(base))
    .sort()
    .map((n) => path.join(dir, n));
}

// ------------------------------------------------ upsert do servidor do Hub

const HUB = (over: Partial<PortableMcpServer> = {}): PortableMcpServer => ({
  name: 'agents-hub',
  transport: 'stdio',
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\hub\\packages\\mcp\\dist\\main.js'],
  env: { AGENTS_HUB_URL: 'http://127.0.0.1:4747', AGENTS_HUB_MCP_AGENT: 'x' },
  ...over,
});

describe('upsertMcpServer — OpenCode (schema estrito do opencode.json)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-upsert-oc-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const opencode = mcpTargets('/h').find((t) => t.agentId === 'opencode')!;

  test('gera {type:"local", command:[...], environment, enabled} e preserva os outros servidores', () => {
    const f = path.join(dir, 'opencode.json');
    // Fixture no formato que o próprio `opencode mcp add` grava, com outros servidores.
    const original = JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        theme: 'tokyonight',
        mcp: {
          context7: { type: 'remote', url: 'https://mcp.context7.com/mcp', enabled: true },
          fs: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-filesystem'], enabled: false },
        },
      },
      null,
      2,
    );
    writeFileSync(f, original);

    const t1 = new Date(2026, 8, 26, 10, 0, 0);
    const out = upsertMcpServer(opencode, f, HUB(), t1);
    assert.equal(out.action, 'merged');
    const doc = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown> & {
      mcp: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(doc.mcp['agents-hub'], {
      type: 'local',
      command: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\hub\\packages\\mcp\\dist\\main.js'],
      environment: { AGENTS_HUB_URL: 'http://127.0.0.1:4747', AGENTS_HUB_MCP_AGENT: 'x' },
      enabled: true,
    });
    // Nenhuma chave do formato do Claude (o OpenCode rejeita a config INTEIRA com elas).
    for (const v of Object.values(doc.mcp)) {
      assert.ok(v['type'] === 'local' || v['type'] === 'remote');
      assert.ok(!('args' in v) && !('env' in v));
      if (v['type'] === 'local') assert.ok(Array.isArray(v['command']));
    }
    const orig = JSON.parse(original) as Record<string, unknown> & { mcp: Record<string, unknown> };
    assert.equal(doc['theme'], 'tokyonight');
    assert.equal(doc['$schema'], orig['$schema']);
    assert.deepEqual(doc.mcp['context7'], orig.mcp['context7']);
    assert.deepEqual(doc.mcp['fs'], orig.mcp['fs']);
    assert.equal(readFileSync(out.backup!, 'utf8'), original);

    // Idempotente: segunda execução não grava nem cria backup.
    const depois1 = readFileSync(f, 'utf8');
    const out2 = upsertMcpServer(opencode, f, HUB(), new Date(2026, 8, 26, 10, 0, 5));
    assert.equal(out2.action, 'unchanged');
    assert.equal(out2.backup, null);
    assert.equal(readFileSync(f, 'utf8'), depois1);
    assert.equal(backupsDe(f).length, 1);
  });

  test('backups distintos preservados: mudar a porta 2x no mesmo segundo não sobrescreve nenhum', () => {
    const f = path.join(dir, 'b', 'opencode.json');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '{"mcp":{}}');
    const t = new Date(2026, 8, 26, 11, 0, 0);
    const a = upsertMcpServer(opencode, f, HUB({ env: { AGENTS_HUB_URL: 'http://127.0.0.1:1' } }), t);
    const estadoA = readFileSync(f, 'utf8');
    const b = upsertMcpServer(opencode, f, HUB({ env: { AGENTS_HUB_URL: 'http://127.0.0.1:2' } }), t);
    assert.notEqual(a.backup, b.backup);
    assert.match(a.backup!, /opencode\.json\.bak-20260926-110000$/);
    assert.match(b.backup!, /opencode\.json\.bak-20260926-110000-2$/);
    assert.equal(readFileSync(a.backup!, 'utf8'), '{"mcp":{}}', 'o original sobrevive à 2ª execução');
    assert.equal(readFileSync(b.backup!, 'utf8'), estadoA);
    assert.equal(backupsDe(f).length, 2);
  });

  test('JSONC (comentário e vírgula final) é aceito; lixo no fim é recusado sem gravar', () => {
    const f = path.join(dir, 'c', 'opencode.json');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '{\n  // meu tema\n  "theme": "x",\n  "mcp": { "fs": { "type": "remote", "url": "https://a", }, },\n}\n');
    const out = upsertMcpServer(opencode, f, HUB());
    assert.equal(out.avisos.length, 1);
    const doc = JSON.parse(readFileSync(f, 'utf8')) as { theme: string; mcp: Record<string, unknown> };
    assert.equal(doc.theme, 'x');
    assert.deepEqual(doc.mcp['fs'], { type: 'remote', url: 'https://a' });

    const g = path.join(dir, 'd', 'opencode.json');
    mkdirSync(path.dirname(g), { recursive: true });
    const lixo = '{"theme":"x","mcp":{}}\n}garbage\n';
    writeFileSync(g, lixo);
    assert.throws(() => upsertMcpServer(opencode, g, HUB()), /não é JSON válido.*Nada foi gravado/s);
    assert.equal(readFileSync(g, 'utf8'), lixo);
    assert.deepEqual(backupsDe(g), []);
  });
});

describe('upsertMcpServer — Codex (config.toml com servidor de `codex mcp add`)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-upsert-cx-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = mcpTargets('/h').find((t) => t.agentId === 'codex')!;

  // Exatamente o que `codex mcp add agents-hub --env AGENTS_HUB_URL=http://x -- node foo.js`
  // grava: env como SUB-TABELA, não inline. Mais config do usuário ao redor.
  const FIXTURE = [
    '# config do usuário',
    'model = "gpt-5-codex"',
    'approval_policy = "on-request"',
    '',
    '[mcp_servers.agents-hub]',
    'command = "node"',
    'args = ["foo.js"]',
    '',
    '[mcp_servers.agents-hub.env]',
    'AGENTS_HUB_URL = "http://x"',
    '',
    '[mcp_servers.outro]',
    'command = "npx"',
    'args = ["-y", "outro"]',
    '',
    '[mcp_servers.outro.env]',
    'TOKEN_NAME = "abc"',
    '',
    '[profiles.rapido]',
    'model = "gpt-5-mini"',
    '',
  ].join('\n');

  test('substitui a tabela inteira (com sub-tabelas): TOML reparseável, sem chave duplicada', () => {
    const f = path.join(dir, 'config.toml');
    writeFileSync(f, FIXTURE);
    const out = upsertMcpServer(codex, f, HUB(), new Date(2026, 8, 26, 12, 0, 0));
    assert.equal(out.action, 'merged');
    const texto = readFileSync(f, 'utf8');
    const doc = parseToml(texto) as {
      model: string;
      approval_policy: string;
      mcp_servers: Record<string, Record<string, unknown>>;
      profiles: Record<string, unknown>;
    };
    assert.deepEqual(doc.mcp_servers['agents-hub'], {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\hub\\packages\\mcp\\dist\\main.js'],
      env: { AGENTS_HUB_URL: 'http://127.0.0.1:4747', AGENTS_HUB_MCP_AGENT: 'x' },
    });
    assert.equal(doc.model, 'gpt-5-codex');
    assert.equal(doc.approval_policy, 'on-request');
    assert.deepEqual(doc.mcp_servers['outro'], { command: 'npx', args: ['-y', 'outro'], env: { TOKEN_NAME: 'abc' } });
    assert.deepEqual(doc.profiles, { rapido: { model: 'gpt-5-mini' } });
    assert.ok(!texto.includes('[mcp_servers.agents-hub.env]'), 'sub-tabela antiga removida');
    assert.ok(texto.startsWith('# config do usuário\nmodel = "gpt-5-codex"'), 'comentários e ordem preservados');
    assert.equal(readFileSync(out.backup!, 'utf8'), FIXTURE);

    // Idempotente.
    const out2 = upsertMcpServer(codex, f, HUB(), new Date(2026, 8, 26, 12, 0, 1));
    assert.equal(out2.action, 'unchanged');
    assert.equal(readFileSync(f, 'utf8'), texto);
    assert.equal((texto.match(/\[mcp_servers\.agents-hub\]/g) ?? []).length, 1);
    assert.equal(backupsDe(f).length, 1);
  });

  test('o parser reprova a saída do bug antigo (env inline + sub-tabela .env)', () => {
    const quebrado =
      '[mcp_servers.agents-hub]\ncommand = "n"\nargs = []\nenv = { A = "1" }\n[mcp_servers.agents-hub.env]\nA = "2"\n';
    assert.throws(() => parseToml(quebrado), /TOML inválido/);
    assert.throws(() => parseToml('[a]\nx = 1\n[a]\ny = 2\n'), /declarada duas vezes/);
    assert.throws(() => parseToml('x = 1\nx = 2\n'), /duas vezes/);
    assert.deepEqual(parseToml('[a.b]\nx = 1\n[a]\ny = 2\n'), { a: { b: { x: 1 }, y: 2 } });
  });

  test('servidor inline em [mcp_servers] (formato que não sei substituir): recusa sem gravar', () => {
    const f = path.join(dir, 'inline', 'config.toml');
    mkdirSync(path.dirname(f), { recursive: true });
    const texto = '[mcp_servers]\nagents-hub = { command = "old", args = [] }\n';
    writeFileSync(f, texto);
    assert.throws(() => upsertMcpServer(codex, f, HUB()), /nada foi gravado/i);
    assert.equal(readFileSync(f, 'utf8'), texto);
    assert.deepEqual(backupsDe(f), []);
  });

  test('config.toml inválido: recusa sem gravar', () => {
    const f = path.join(dir, 'inv', 'config.toml');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, 'model = "sem fim\n');
    assert.throws(() => upsertMcpServer(codex, f, HUB()), /não é TOML válido/);
    assert.equal(readFileSync(f, 'utf8'), 'model = "sem fim\n');
  });

  test('arquivo novo e servidor ao final quando ainda não existe', () => {
    const f = path.join(dir, 'novo', 'config.toml');
    const out = upsertMcpServer(codex, f, HUB());
    assert.equal(out.action, 'created');
    assert.equal(out.backup, null);
    assert.ok(parseToml(readFileSync(f, 'utf8'))['mcp_servers']);

    const g = path.join(dir, 'fim', 'config.toml');
    mkdirSync(path.dirname(g), { recursive: true });
    writeFileSync(g, 'model = "m"');
    upsertMcpServer(codex, g, HUB());
    const texto = readFileSync(g, 'utf8');
    assert.ok(texto.startsWith('model = "m"\n\n[mcp_servers.agents-hub]\n'));
  });
});
