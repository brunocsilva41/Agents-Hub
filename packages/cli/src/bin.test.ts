import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';

/**
 * A entrada do `hub` (`bin.js`) exercitada como o usuário a executa: um
 * `node bin.js ...` SEM `--experimental-sqlite` e SEM `--no-warnings` — é o
 * que o shim do `npm link`/`npm i -g` faz. (`spawnSync` não herda o
 * `execArgv` do runner de testes, que passa a flag.)
 *
 * No job de CI em Node 22.5 isto é o teste do item 5.1 de verdade: antes, o
 * primeiro import estático de `node:sqlite` derrubava até `hub help` com
 * ERR_UNKNOWN_BUILTIN_MODULE. Localmente, com um Node antigo à mão:
 * `<node-22.12> --experimental-sqlite --test packages/cli/dist/bin.test.js`.
 */

const BIN = fileURLToPath(new URL('./bin.js', import.meta.url));

let raiz: string;
let hubHome: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) {
    if (/^(AGENTS_HUB_|NODE_OPTIONS$|NODE_NO_WARNINGS$)/.test(k)) delete e[k];
  }
  return { ...e, AGENTS_HUB_HOME: hubHome, AGENTS_HUB_NO_AUTOSTART: '1', NO_COLOR: '1', ...extra };
}

function hub(args: string[], extra: Record<string, string> = {}, input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: env(extra),
    encoding: 'utf8',
    timeout: 60_000,
    input,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

before(() => {
  raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-bin-'));
  hubHome = path.join(raiz, 'hub');
});

after(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('bin.js — entrada do hub', () => {
  test('`hub help` roda sem --experimental-sqlite e sem ExperimentalWarning no stderr', () => {
    const r = hub(['help']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /hub status/);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  });

  test('`hub --version` imprime a versão do pacote, sem carregar o resto', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version: string;
    };
    const r = hub(['--version']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), pkg.version);
  });

  test('`hub hook` responde sem daemon e sem aviso no stderr', () => {
    const r = hub(['hook'], { AGENTS_HUB_PORT: '1' }, '{"tool_name":"Read","tool_input":{}}');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /permissionDecision/);
    assert.equal(r.stderr, '');
  });

  test('config.json inválido: uma linha com caminho, linha e coluna — sem stack trace', () => {
    const home = path.join(raiz, 'config-ruim');
    const arquivo = path.join(home, 'config.json');
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(arquivo, '{\n  "port": 4747,\n  oops\n}\n');
    const r = hub(['status'], { AGENTS_HUB_HOME: home });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(arquivo), r.stderr);
    assert.match(r.stderr, /linha 3, coluna 3/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'não deveria ter stack trace');
  });

  test('AGENTS_HUB_PORT inválida é recusada com o nome da variável, não vira NaN', () => {
    const r = hub(['status'], { AGENTS_HUB_PORT: 'abc' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /AGENTS_HUB_PORT/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });

  test('AGENTS_HUB_NO_AUTOSTART com valor inválido é recusada, não lida como "não"', () => {
    const r = hub(['status'], { AGENTS_HUB_NO_AUTOSTART: 'sim', AGENTS_HUB_PORT: '1' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /AGENTS_HUB_NO_AUTOSTART/);
  });

  // R07-08 / R14-07: só `hub daemon` lia a variável; o cliente falava com a
  // porta do config.json/4747 e o autostart ficava 30 s sondando a errada.
  test('o cliente da CLI usa AGENTS_HUB_PORT (hub mcp mostra o daemon nessa porta)', () => {
    const r = hub(['mcp'], { AGENTS_HUB_PORT: '48123' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /daemon:\s+http:\/\/127\.0\.0\.1:48123/);
  });

  test('o hook não carrega node:sqlite (nem o índice do daemon)', () => {
    const hookRun = pathToFileURL(fileURLToPath(new URL('./hook-run.js', import.meta.url))).href;
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(hookRun)}); console.log(JSON.stringify(process.moduleLoadList.filter((m) => /sqlite/i.test(m))));`,
      ],
      { env: env(), encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), []);
  });
});
