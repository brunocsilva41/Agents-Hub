import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { addMcpServers, existingServerNames, mcpTargets, tomlServerNames } from './mcp-config.js';

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
    assert.equal(readFileSync(`${f}.bak`, 'utf8'), original);
  });

  test('nada a adicionar -> unchanged, arquivo intocado e sem .bak novo', () => {
    const f = path.join(dir, 'b', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    const original = '{"mcpServers":{"a":{"command":"x"}}}';
    writeFileSync(f, original);
    const out = addMcpServers(cursor, f, [{ name: 'a', transport: 'stdio', command: 'y' }]);
    assert.equal(out.action, 'unchanged');
    assert.equal(readFileSync(f, 'utf8'), original);
    assert.ok(!existsSync(`${f}.bak`));
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
        l: { type: 'local', command: ['npx', '-y', 'x'], environment: { K: 'v' } },
        r: { type: 'remote', url: 'https://x' },
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
    assert.equal(readFileSync(`${f}.bak`, 'utf8'), texto);
    assert.deepEqual([...existingServerNames(codex, f)].sort(), ['a', 'b.c', 'd', 'e']);
  });

  test('JSON inválido: lança e não toca no arquivo', () => {
    const f = path.join(dir, 'f', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '{oops');
    assert.throws(() => addMcpServers(cursor, f, [{ name: 'a', transport: 'stdio', command: 'x' }]), /JSON válido/);
    assert.equal(readFileSync(f, 'utf8'), '{oops');
    assert.ok(!existsSync(`${f}.bak`));
  });
});
