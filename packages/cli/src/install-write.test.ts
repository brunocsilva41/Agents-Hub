import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { parseToml } from '@agents-hub/adapters';

/**
 * Regressão de perda de dados em `hub hooks install ... --write` e
 * `hub mcp install ... --write` (GOAL 0.4 e 0.5), exercitando a CLI de verdade.
 *
 * Tudo roda com HOME/USERPROFILE/AGENTS_HUB_HOME apontando para um diretório
 * temporário: nenhuma config real (~/.claude, ~/.codex, opencode) é tocada.
 */

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));

let raiz: string;
let home: string;
let hubHome: string;

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) {
    if (/^(AGENTS_HUB_|CODEX_HOME$|XDG_CONFIG_HOME$|OPENCODE_CONFIG)/.test(k)) delete e[k];
  }
  return {
    ...e,
    HOME: home,
    USERPROFILE: home,
    AGENTS_HUB_HOME: hubHome,
    AGENTS_HUB_NO_AUTOSTART: '1',
    NO_COLOR: '1',
  };
}

function hub(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', MAIN, ...args], {
    env: env(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function backupsDe(file: string): string[] {
  const dir = path.dirname(file);
  if (!existsSync(dir)) return [];
  const base = `${path.basename(file)}.bak`;
  return readdirSync(dir)
    .filter((n) => n.startsWith(base))
    .sort()
    .map((n) => path.join(dir, n));
}

before(() => {
  raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-install-write-'));
  home = path.join(raiz, 'home');
  hubHome = path.join(raiz, 'hub-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(hubHome, { recursive: true });
  // Trava de segurança: se o HOME injetado não valer para o processo filho,
  // os testes escreveriam na config REAL. Nesse caso, falha antes de tudo.
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], {
    env: env(),
    encoding: 'utf8',
  });
  assert.equal(path.resolve(r.stdout), path.resolve(home), 'HOME temporário não foi respeitado');
});
after(() => rmSync(raiz, { recursive: true, force: true }));

describe('hub hooks install claude --write — nunca perde a config do usuário', () => {
  test('settings.json com lixo no fim (como o real desta máquina): recusa, exit 1, arquivo intacto, sem backup', () => {
    const projeto = path.join(raiz, 'proj-lixo');
    const file = path.join(projeto, '.claude', 'settings.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const original =
      '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(git status)"] },\n  "env": { "X": "1" }\n}\n}\n';
    writeFileSync(file, original);

    const r = hub('hooks', 'install', 'claude', '--write', '--project', projeto);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /não é JSON válido/);
    assert.match(r.out, /Nada foi gravado/);
    assert.equal(readFileSync(file, 'utf8'), original, 'arquivo byte a byte intacto');
    assert.deepEqual(backupsDe(file), []);

    // O dry-run também avisa, em vez de mostrar "só o hook do Hub".
    const seco = hub('hooks', 'install', 'claude', '--project', projeto);
    assert.equal(seco.code, 1, seco.out);
    assert.match(seco.out, /não é JSON válido/);
  });

  test('JSONC (comentário + vírgula final): preserva todas as chaves e hooks; backups versionados nunca sobrescritos; idempotente', () => {
    const projeto = path.join(raiz, 'proj-jsonc');
    const file = path.join(projeto, '.claude', 'settings.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const original = [
      '{',
      '  // preferências pessoais',
      '  "model": "opus",',
      '  "permissions": { "allow": ["Bash(git status)", "Read",], "deny": ["Bash(rm -rf *)"] },',
      '  "hooks": {',
      '    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "meu-hook.sh" }] }],',
      '    "Stop": [{ "hooks": [{ "type": "command", "command": "notify.sh" }] }]',
      '  },',
      '}',
      '',
    ].join('\n');
    writeFileSync(file, original);

    const r1 = hub('hooks', 'install', 'claude', '--write', '--project', projeto);
    assert.equal(r1.code, 0, r1.out);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      model: string;
      permissions: { allow: string[]; deny: string[] };
      hooks: {
        PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
        Stop: unknown[];
      };
    };
    assert.equal(doc.model, 'opus');
    assert.deepEqual(doc.permissions, { allow: ['Bash(git status)', 'Read'], deny: ['Bash(rm -rf *)'] });
    assert.equal(doc.hooks.Stop.length, 1, 'outros eventos de hook preservados');
    assert.equal(doc.hooks.PreToolUse.length, 2);
    assert.equal(
      doc.hooks.PreToolUse[0]?.hooks[0]?.command,
      'meu-hook.sh',
      'hook do usuário preservado',
    );
    assert.match(doc.hooks.PreToolUse[1]?.hooks[0]?.command ?? '', /bin\.js" hook$/);

    const [b1, ...resto] = backupsDe(file);
    assert.equal(resto.length, 0);
    assert.match(b1!, /settings\.json\.bak-\d{8}-\d{6}$/);
    assert.equal(readFileSync(b1!, 'utf8'), original, 'backup = original com comentários');

    // 2ª execução: nada muda, nenhum backup novo, nada duplicado.
    const instalado = readFileSync(file, 'utf8');
    const r2 = hub('hooks', 'install', 'claude', '--write', '--project', projeto);
    assert.equal(r2.code, 0, r2.out);
    assert.equal(readFileSync(file, 'utf8'), instalado);
    assert.equal(backupsDe(file).length, 1);

    // A pessoa edita o arquivo e reinstala: novo backup, o anterior continua intacto.
    const semOGate = JSON.parse(instalado) as typeof doc;
    semOGate.model = 'sonnet';
    semOGate.hooks.PreToolUse = semOGate.hooks.PreToolUse.slice(0, 1);
    const editado = JSON.stringify(semOGate, null, 2);
    writeFileSync(file, editado);
    const r3 = hub('hooks', 'install', 'claude', '--write', '--project', projeto);
    assert.equal(r3.code, 0, r3.out);
    const backups = backupsDe(file);
    assert.equal(backups.length, 2, 'backup distinto a cada gravação');
    assert.equal(readFileSync(b1!, 'utf8'), original, 'o primeiro backup nunca é sobrescrito');
    assert.ok(backups.some((b) => readFileSync(b, 'utf8') === editado));
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { model: string }).model, 'sonnet');
    assert.ok(
      !readdirSync(path.dirname(file)).some((n) => n.includes('.tmp-')),
      'sem temporário esquecido',
    );
  });
});

describe('hub hooks install codex --write — mexe só em codexGate.bypassHookTrust', () => {
  test('preserva o config.json do Hub (sem congelar defaults), backup versionado, idempotente', () => {
    const file = path.join(hubHome, 'config.json');
    const original = '{\n  "port": 48299,\n  "retention": { "eventsDays": 7 }\n}\n';
    writeFileSync(file, original);

    const r1 = hub('hooks', 'install', 'codex', '--write');
    assert.equal(r1.code, 0, r1.out);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(doc, {
      port: 48299,
      retention: { eventsDays: 7 },
      codexGate: { bypassHookTrust: true },
    });
    const [b1] = backupsDe(file);
    assert.equal(readFileSync(b1!, 'utf8'), original);

    const r2 = hub('hooks', 'install', 'codex', '--write');
    assert.equal(r2.code, 0, r2.out);
    assert.equal(backupsDe(file).length, 1, '2ª execução não grava nem cria backup');
    rmSync(file);
  });
});

describe('hub mcp install --write', () => {
  test('opencode: schema do OpenCode ({type:"local", command:[...], environment, enabled}); outros servidores intactos; idempotente', () => {
    const file = path.join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const original = JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        theme: 'tokyonight',
        mcp: {
          context7: { type: 'remote', url: 'https://mcp.context7.com/mcp', enabled: true },
          fs: {
            type: 'local',
            command: ['npx', '-y', 'server-filesystem', '/tmp'],
            environment: { A: 'b' },
            enabled: true,
          },
        },
      },
      null,
      2,
    );
    writeFileSync(file, original);

    const r1 = hub('mcp', 'install', 'opencode', '--write');
    assert.equal(r1.code, 0, r1.out);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & {
      mcp: Record<string, Record<string, unknown>>;
    };
    const orig = JSON.parse(original) as Record<string, unknown> & { mcp: Record<string, unknown> };
    assert.equal(doc['theme'], 'tokyonight');
    assert.equal(doc['$schema'], orig['$schema']);
    assert.deepEqual(doc.mcp['context7'], orig.mcp['context7']);
    assert.deepEqual(doc.mcp['fs'], orig.mcp['fs']);

    const hubEntry = doc.mcp['agents-hub']!;
    assert.deepEqual(Object.keys(hubEntry).sort(), ['command', 'enabled', 'environment', 'type']);
    assert.equal(hubEntry['type'], 'local');
    assert.equal(hubEntry['enabled'], true);
    const cmd = hubEntry['command'] as string[];
    assert.ok(Array.isArray(cmd) && cmd.length === 2 && cmd[1]!.endsWith('main.js'));
    assert.equal(
      (hubEntry['environment'] as Record<string, string>)['AGENTS_HUB_MCP_AGENT'],
      'opencode',
    );

    const [b1] = backupsDe(file);
    assert.equal(readFileSync(b1!, 'utf8'), original);

    const depois = readFileSync(file, 'utf8');
    const r2 = hub('mcp', 'install', 'opencode', '--write');
    assert.equal(r2.code, 0, r2.out);
    assert.equal(readFileSync(file, 'utf8'), depois);
    assert.equal(backupsDe(file).length, 1, '2ª execução não sobrescreve nem cria backup');

    // O trecho de `show` é o mesmo formato que o --write grava.
    const show = hub('mcp', 'show', 'opencode');
    assert.match(show.out, /"type": "local"/);
    assert.match(show.out, /"enabled": true/);
  });

  test('codex: servidor já registrado via `codex mcp add` (env como sub-tabela) é substituído inteiro; TOML reparseável', () => {
    const file = path.join(home, '.codex', 'config.toml');
    mkdirSync(path.dirname(file), { recursive: true });
    const original = [
      'model = "gpt-5-codex"',
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
      '',
      '[mcp_servers.outro.env]',
      'K = "v"',
      '',
    ].join('\n');
    writeFileSync(file, original);

    const r1 = hub('mcp', 'install', 'codex', '--write');
    assert.equal(r1.code, 0, r1.out);
    const texto = readFileSync(file, 'utf8');
    const doc = parseToml(texto) as {
      model: string;
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    assert.equal(doc.model, 'gpt-5-codex');
    assert.deepEqual(doc.mcp_servers['outro'], { command: 'npx', env: { K: 'v' } });
    const env = doc.mcp_servers['agents-hub']!['env'] as Record<string, string>;
    assert.equal(env['AGENTS_HUB_MCP_AGENT'], 'codex');
    assert.notEqual(env['AGENTS_HUB_URL'], 'http://x');
    assert.equal(
      (texto.match(/^\[mcp_servers\.agents-hub/gm) ?? []).length,
      1,
      'uma tabela só, sem sub-tabela antiga',
    );

    const r2 = hub('mcp', 'install', 'codex', '--write');
    assert.equal(r2.code, 0, r2.out);
    assert.equal(readFileSync(file, 'utf8'), texto, 'idempotente');
    assert.equal(backupsDe(file).length, 1);
    assert.equal(readFileSync(backupsDe(file)[0]!, 'utf8'), original);
  });

  test('backups distintos: o original sobrevive a gravações seguidas', () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const original = '{"mcpServers":{"meu":{"command":"x"}},"outra":1}';
    writeFileSync(file, original);

    assert.equal(hub('mcp', 'install', 'cursor', '--write').code, 0);
    // A pessoa remove o Hub à mão; reinstala.
    const semHub = '{"mcpServers":{"meu":{"command":"x"}},"outra":2}';
    writeFileSync(file, semHub);
    assert.equal(hub('mcp', 'install', 'cursor', '--write').code, 0);

    const backups = backupsDe(file).map((b) => readFileSync(b, 'utf8'));
    assert.equal(backups.length, 2);
    assert.ok(backups.includes(original), 'backup do original preservado');
    assert.ok(backups.includes(semHub));
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      outra: number;
      mcpServers: Record<string, unknown>;
    };
    assert.equal(doc.outra, 2);
    assert.ok(doc.mcpServers['meu'] && doc.mcpServers['agents-hub']);
  });
});
