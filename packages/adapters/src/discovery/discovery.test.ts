import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { discoverAgent } from './index.js';
import { parseJsonTolerant } from './util.js';
import { parseToml } from './toml.js';

const SECRET = 'sk-SEGREDO123';
const roots: string[] = [];

/** Monta um home falso com os arquivos dados (caminho relativo -> conteúdo). */
function fakeHome(files: Record<string, string> = {}): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hub-disc-'));
  roots.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(home, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return home;
}

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const INSTALLED = { version: '1.2.3', binPath: '/bin/x' };
const NOENV = {};
const run = (agent: string, home: string, extra: { projectDir?: string; env?: Record<string, string> } = {}) =>
  discoverAgent(agent, { home, installed: INSTALLED, env: NOENV, ...extra });

describe('parsers', () => {
  it('JSON tolerante: comentários, vírgula final e lixo após o objeto', () => {
    assert.deepEqual(parseJsonTolerant('// c\n{"a":1,}').value, { a: 1 });
    const r = parseJsonTolerant('{"a":1}\n}');
    assert.deepEqual(r.value, { a: 1 });
    assert.ok(r.note);
    assert.ok(parseJsonTolerant('{"a":').error);
  });

  it('TOML mínimo: tabelas, aspas, arrays multilinha, inline', () => {
    const t = parseToml(`
model = "x"  # c
list = [
  "a", 'b',
]
[a.'b c']
n = 3
inl = { k = "v", z = true }
[[arr]]
i = 1
[[arr]]
i = 2
`) as Record<string, any>;
    assert.equal(t.model, 'x');
    assert.deepEqual(t.list, ['a', 'b']);
    assert.equal(t.a['b c'].n, 3);
    assert.deepEqual(t.a['b c'].inl, { k: 'v', z: true });
    assert.deepEqual(t.arr, [{ i: 1 }, { i: 2 }]);
    assert.throws(() => parseToml('a = "sem fim'));
    assert.throws(() => parseToml('[x\ny=1'));
  });
});

describe('claude', () => {
  it('config feliz: defaults, auth, MCP de usuário/local/projeto, instruções', async () => {
    const proj = fakeHome({
      '.mcp.json': JSON.stringify({ mcpServers: { projsrv: { type: 'http', url: 'https://x.dev/mcp' } } }),
    });
    const home = fakeHome({
      '.claude/settings.json': JSON.stringify({
        env: { ANTHROPIC_MODEL: 'cc/sonnet', ANTHROPIC_BASE_URL: 'http://localhost:20128' },
      }),
      '.claude/.credentials.json': '{}',
      '.claude/CLAUDE.md': '12345',
      '.claude.json': JSON.stringify({
        mcpServers: {
          hub: { command: 'agents-hub', args: ['mcp'], env: { K: 'v' } },
          other: { type: 'stdio', command: 'node', args: ['x.js'] },
        },
        projects: { [proj.replace(/\\/g, '/')]: { mcpServers: { loc: { command: 'l' } } } },
      }),
    });
    const d = await run('claude', home, { projectDir: proj });
    assert.equal(d.installed, true);
    assert.equal(d.auth.state, 'present');
    assert.equal(d.defaults.model, 'cc/sonnet');
    assert.equal(d.defaults.baseUrl, 'http://localhost:20128');
    assert.deepEqual(d.mcpServers.map((s) => s.name).sort(), ['hub', 'loc', 'other', 'projsrv']);
    const hub = d.mcpServers.find((s) => s.name === 'hub')!;
    assert.equal(hub.isHub, true);
    assert.deepEqual(hub.env, { K: '***' });
    assert.equal(d.mcpServers.find((s) => s.name === 'other')!.isHub, false);
    assert.equal(d.mcpServers.find((s) => s.name === 'projsrv')!.transport, 'http');
    assert.deepEqual(d.instructionFiles.map((f) => f.bytes), [5]);
  });

  it('arquivos ausentes: auth absent, sem exceção', async () => {
    const d = await run('claude', fakeHome());
    assert.equal(d.auth.state, 'absent');
    assert.deepEqual(d.mcpServers, []);
    assert.ok(d.files.every((f) => !f.exists));
  });

  it('malformado vira warning', async () => {
    const home = fakeHome({ '.claude.json': '{"mcpServers": {', '.claude/settings.json': 'nope' });
    const d = await run('claude', home);
    assert.ok(d.warnings.some((w) => w.includes('.claude.json') && w.includes('malformado')));
    assert.ok(d.warnings.some((w) => w.includes('settings.json')));
  });

  it('variável de ambiente conhecida conta como auth', async () => {
    const d = await run('claude', fakeHome(), { env: { ANTHROPIC_API_KEY: 'x' } });
    assert.equal(d.auth.state, 'present');
    assert.ok(d.auth.evidence.some((e) => e.includes('ANTHROPIC_API_KEY')));
  });
});

describe('openclaude', () => {
  it('perfil ativo define defaults; .mcp.json de projeto lido', async () => {
    const proj = fakeHome({ '.mcp.json': JSON.stringify({ mcpServers: { p: { command: 'c' } } }) });
    const home = fakeHome({
      '.openclaude.json': JSON.stringify({
        activeProviderProfileId: 'a',
        providerProfiles: [
          { id: 'a', provider: 'nvidia-nim', baseUrl: 'https://nim/v1', model: 'm1', apiKey: SECRET },
        ],
        mcpServers: { g: { command: 'x' } },
      }),
      '.openclaude/.credentials.json': '{}',
    });
    const d = await run('openclaude', home, { projectDir: proj });
    assert.equal(d.defaults.provider, 'nvidia-nim');
    assert.equal(d.defaults.model, 'm1');
    assert.equal(d.defaults.baseUrl, 'https://nim/v1');
    assert.equal(d.auth.state, 'present');
    assert.deepEqual(d.mcpServers.map((s) => s.name).sort(), ['g', 'p']);
  });
  it('ausente e malformado', async () => {
    assert.equal((await run('openclaude', fakeHome())).auth.state, 'absent');
    const d = await run('openclaude', fakeHome({ '.openclaude.json': '[[' }));
    assert.ok(d.warnings.some((w) => w.includes('.openclaude.json')));
    assert.equal(d.warnings.filter((w) => w.includes('.openclaude.json: JSON malformado')).length, 1);
  });
});

describe('codex', () => {
  it('config feliz: modelo, provedor, baseUrl, MCP, AGENTS.md, auth.json', async () => {
    const home = fakeHome({
      '.codex/config.toml': `model = "gpt-x"
model_provider = "openrouter"
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
[mcp_servers.agents-hub]
command = "node"
args = ["hub.js", "mcp"]
[mcp_servers.agents-hub.env]
TOKEN = "${SECRET}"
[mcp_servers.remote]
url = "https://r.dev/mcp"
`,
      '.codex/auth.json': '{"OPENAI_API_KEY":"x"}',
      '.codex/AGENTS.md': 'abc',
    });
    const d = await run('codex', home);
    assert.equal(d.defaults.model, 'gpt-x');
    assert.equal(d.defaults.provider, 'openrouter');
    assert.equal(d.defaults.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(d.auth.state, 'present');
    const hub = d.mcpServers.find((s) => s.name === 'agents-hub')!;
    assert.equal(hub.isHub, true);
    assert.deepEqual(hub.env, { TOKEN: '***' });
    assert.equal(d.mcpServers.find((s) => s.name === 'remote')!.transport, 'http');
    assert.equal(d.instructionFiles[0]!.bytes, 3);
  });
  it('ausente', async () => {
    const d = await run('codex', fakeHome());
    assert.equal(d.auth.state, 'absent');
    assert.equal(d.defaults.model, undefined);
  });
  it('TOML malformado vira warning', async () => {
    const d = await run('codex', fakeHome({ '.codex/config.toml': 'model = "sem fim\n[x' }));
    assert.ok(d.warnings.some((w) => w.includes('config.toml')));
    assert.deepEqual(d.mcpServers, []);
  });
});

describe('opencode', () => {
  it('feliz: json + jsonc, MCP local/remote, defaults, auth', async () => {
    const home = fakeHome({
      '.config/opencode/opencode.json': JSON.stringify({
        model: 'zai/glm',
        provider: { zai: { options: { baseURL: 'https://zai/v1', apiKey: SECRET } } },
        mcp: { a: { type: 'local', command: ['node', 'a.js', '--token', SECRET], environment: { X: SECRET } } },
      }),
      '.config/opencode/opencode.jsonc': '{\n // c\n "mcp": { "b": { "type": "remote", "url": "https://b/mcp" }, }\n}',
      '.local/share/opencode/auth.json': '{}',
      '.config/opencode/AGENTS.md': 'zz',
    });
    const d = await run('opencode', home);
    assert.equal(d.defaults.provider, 'zai');
    assert.equal(d.defaults.baseUrl, 'https://zai/v1');
    assert.equal(d.auth.state, 'present');
    const a = d.mcpServers.find((s) => s.name === 'a')!;
    assert.equal(a.command, 'node');
    assert.deepEqual(a.args, ['a.js', '--token', '***']);
    assert.deepEqual(a.env, { X: '***' });
    assert.equal(d.mcpServers.find((s) => s.name === 'b')!.transport, 'http');
    assert.equal(d.instructionFiles.length, 1);
  });
  it('ausente e malformado', async () => {
    assert.equal((await run('opencode', fakeHome())).auth.state, 'absent');
    const d = await run('opencode', fakeHome({ '.config/opencode/opencode.json': '{oops' }));
    assert.ok(d.warnings.some((w) => w.includes('opencode.json')));
  });
});

describe('copilot', () => {
  it('feliz: config.json com comentários, settings, mcp-config', async () => {
    const home = fakeHome({
      '.copilot/config.json': '// managed\n{ "loggedInUsers": [{"login":"u"}] }',
      '.copilot/settings.json': '{"model":"gemini-x"}',
      '.copilot/mcp-config.json': JSON.stringify({ mcpServers: { s: { type: 'local', command: 'c', args: ['a'], env: { E: SECRET }, tools: ['*'] } } }),
      '.copilot/copilot-instructions.md': 'hi',
    });
    const d = await run('copilot', home);
    assert.equal(d.defaults.model, 'gemini-x');
    assert.equal(d.auth.state, 'present');
    assert.equal(d.mcpServers[0]!.transport, 'stdio');
    assert.deepEqual(d.mcpServers[0]!.env, { E: '***' });
    assert.equal(d.instructionFiles[0]!.bytes, 2);
    assert.equal(d.warnings.length, 0);
  });
  it('ausente = unknown (chaveiro do SO não inspecionável); malformado = warning', async () => {
    assert.equal((await run('copilot', fakeHome())).auth.state, 'unknown');
    const d = await run('copilot', fakeHome({ '.copilot/mcp-config.json': 'x{' }));
    assert.ok(d.warnings.some((w) => w.includes('mcp-config.json')));
  });
});

describe('antigravity', () => {
  it('feliz: settings.json + mcp_config.json', async () => {
    const home = fakeHome({
      '.gemini/settings.json': JSON.stringify({
        model: { name: 'gemini-3' },
        security: { auth: { selectedType: 'oauth-personal' } },
        mcpServers: { u: { command: 'node', args: ['s.js'] } },
      }),
      '.gemini/config/mcp_config.json': JSON.stringify({ mcpServers: { v: { httpUrl: 'https://v/mcp?key=' + SECRET } } }),
      '.gemini/google_accounts.json': '{}',
      '.gemini/GEMINI.md': 'g',
    });
    const d = await run('antigravity', home);
    assert.equal(d.defaults.model, 'gemini-3');
    assert.equal(d.defaults.provider, 'google');
    assert.equal(d.auth.state, 'present');
    assert.deepEqual(d.mcpServers.map((s) => s.name).sort(), ['u', 'v']);
    assert.equal(d.mcpServers.find((s) => s.name === 'v')!.url, 'https://v/mcp?***');
    assert.equal(d.instructionFiles.length, 1);
  });
  it('ausente e malformado', async () => {
    assert.equal((await run('antigravity', fakeHome())).auth.state, 'absent');
    const d = await run('antigravity', fakeHome({ '.gemini/settings.json': '{{' }));
    assert.ok(d.warnings.some((w) => w.includes('settings.json')));
  });
});

describe('kimi', () => {
  it('feliz: default_model resolve provedor e baseUrl; credenciais por existência', async () => {
    const home = fakeHome({
      '.kimi-code/config.toml': `default_model = "or/m"
[providers.or]
type = "openai"
base_url = "http://localhost:20128/v1"
api_key = "${SECRET}"
[models."or/m"]
provider = "or"
model = "M"
`,
      '.kimi-code/credentials/kimi-code.json': `{"access_token":"${SECRET}"}`,
      '.kimi-code/AGENTS.md': 'kk',
    });
    const d = await run('kimi', home);
    assert.equal(d.defaults.model, 'M');
    assert.equal(d.defaults.provider, 'or');
    assert.equal(d.defaults.baseUrl, 'http://localhost:20128/v1');
    assert.equal(d.auth.state, 'present');
    assert.ok(d.warnings.some((w) => w.includes('MCP')));
    assert.equal(d.instructionFiles.length, 1);
  });
  it('ausente e malformado', async () => {
    assert.equal((await run('kimi', fakeHome())).auth.state, 'absent');
    const d = await run('kimi', fakeHome({ '.kimi-code/config.toml': 'default_model = ' }));
    assert.ok(d.warnings.some((w) => w.includes('config.toml')));
  });
});

describe('mimo', () => {
  it('feliz: config estilo OpenCode em ~/.config/mimocode', async () => {
    const home = fakeHome({
      '.config/mimocode/mimocode.jsonc': '{ // c\n "model": "xiaomi/mimo", "mcp": { "m": { "type": "local", "command": ["x"] } } }',
      '.local/share/mimocode/auth.json': '{}',
    });
    const d = await run('mimo', home);
    assert.equal(d.defaults.provider, 'xiaomi');
    assert.equal(d.mcpServers[0]!.name, 'm');
    assert.equal(d.auth.state, 'present');
  });
  it('ausente = unknown com warning; malformado = warning', async () => {
    const d = await run('mimo', fakeHome());
    assert.equal(d.auth.state, 'unknown');
    assert.ok(d.warnings.some((w) => w.includes('MiMo')));
    const m = await run('mimo', fakeHome({ '.config/mimocode/mimocode.jsonc': '{{{' }));
    assert.ok(m.warnings.some((w) => w.includes('mimocode.jsonc')));
  });
});

describe('cursor', () => {
  it('feliz: mcp.json', async () => {
    const home = fakeHome({ '.cursor/mcp.json': JSON.stringify({ mcpServers: { c: { url: 'https://c/sse' } } }) });
    const d = await run('cursor', home, { env: { CURSOR_API_KEY: 'x' } });
    assert.equal(d.mcpServers[0]!.transport, 'sse');
    assert.equal(d.auth.state, 'present');
  });
  it('ausente = unknown; malformado = warning', async () => {
    assert.equal((await run('cursor', fakeHome())).auth.state, 'unknown');
    const d = await run('cursor', fakeHome({ '.cursor/mcp.json': '}{' }));
    assert.ok(d.warnings.some((w) => w.includes('mcp.json')));
  });
});

describe('agente desconhecido', () => {
  it('não lança; devolve warning', async () => {
    const d = await run('nao-existe', fakeHome());
    assert.equal(d.auth.state, 'unknown');
    assert.ok(d.warnings[0]);
  });
});

describe('SEGURANÇA: segredo plantado nunca aparece no resultado', () => {
  it('nenhum agente vaza o segredo (env de MCP, auth.json, args, URL, chaves de provedor)', async () => {
    const mcp = { s: { command: 'node', args: ['x', '--api-key', SECRET, `KEY=${SECRET}`, `--t=${SECRET}`], env: { A: SECRET, B: SECRET }, url: `https://u:${SECRET}@h/mcp?k=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } } };
    const home = fakeHome({
      '.claude.json': JSON.stringify({ mcpServers: mcp, oauthAccount: { accessToken: SECRET } }),
      '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }),
      '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_MODEL: 'm' } }),
      '.openclaude.json': JSON.stringify({ mcpServers: mcp, activeProviderProfileId: 'a', providerProfiles: [{ id: 'a', apiKey: SECRET, model: 'm' }] }),
      '.openclaude/.openclaude-profile.json': JSON.stringify({ env: { OPENAI_API_KEY: SECRET } }),
      '.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: SECRET, tokens: { access_token: SECRET } }),
      '.codex/config.toml': `[mcp_servers.s]\ncommand = "node"\nargs = ["--token", "${SECRET}"]\n[mcp_servers.s.env]\nA = "${SECRET}"\n`,
      '.config/opencode/opencode.json': JSON.stringify({ provider: { p: { options: { apiKey: SECRET } } }, mcp: { s: { type: 'local', command: ['n', `--password=${SECRET}`], environment: { A: SECRET } } } }),
      '.local/share/opencode/auth.json': JSON.stringify({ p: { key: SECRET } }),
      '.copilot/mcp-config.json': JSON.stringify({ mcpServers: mcp }),
      '.copilot/config.json': JSON.stringify({ loggedInUsers: [{ token: SECRET }] }),
      '.gemini/settings.json': JSON.stringify({ mcpServers: mcp }),
      '.gemini/config/mcp_config.json': JSON.stringify({ mcpServers: mcp }),
      '.kimi-code/config.toml': `[providers.p]\napi_key = "${SECRET}"\n`,
      '.kimi-code/credentials/kimi-code.json': JSON.stringify({ access_token: SECRET }),
      '.kimi-code/mcp.json': JSON.stringify({ mcpServers: mcp }),
      '.config/mimocode/mimocode.jsonc': JSON.stringify({ mcp: { s: { type: 'local', command: ['n'], environment: { A: SECRET } } } }),
      '.cursor/mcp.json': JSON.stringify({ mcpServers: mcp }),
    });
    for (const agent of ['claude', 'openclaude', 'codex', 'opencode', 'copilot', 'antigravity', 'kimi', 'mimo', 'cursor']) {
      const d = await run(agent, home, { projectDir: home, env: { ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: SECRET } });
      const dump = JSON.stringify(d);
      assert.ok(!dump.includes(SECRET), `${agent} vazou o segredo`);
      assert.ok(!dump.includes('SEGREDO'), `${agent} vazou parte do segredo`);
    }
    // sanidade: o teste só vale se os servidores foram de fato lidos e mascarados
    const c = await run('codex', home);
    assert.deepEqual(c.mcpServers[0]!.env, { A: '***' });
    assert.deepEqual(c.mcpServers[0]!.args, ['--token', '***']);
    const o = await run('opencode', home);
    assert.equal(o.auth.state, 'present');
    const cl = await run('claude', home);
    assert.deepEqual(cl.mcpServers[0]!.env, { A: '***', B: '***' });
    assert.equal(cl.mcpServers[0]!.url, 'https://h/mcp?***');
  });
});
