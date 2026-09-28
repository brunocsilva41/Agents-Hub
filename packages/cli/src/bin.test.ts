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
    // FORCE_COLOR junto do NO_COLOR abaixo faria o Node avisar no stderr do
    // filho, e os testes de "stderr limpo" falhariam por causa do ambiente de
    // quem roda a suíte, não do produto.
    if (/^(AGENTS_HUB_|NODE_OPTIONS$|NODE_NO_WARNINGS$|FORCE_COLOR$)/.test(k)) delete e[k];
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
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      version: string;
    };
    const r = hub(['--version']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), pkg.version);
  });

  test('`hub hook` responde sem daemon e sem aviso no stderr', () => {
    // `Bash`, não `Read`: leitura comum nem tenta o daemon (caminho rápido,
    // teste abaixo), e aqui o que se prova é a ida ao daemon que não atende.
    const r = hub(
      ['hook'],
      { AGENTS_HUB_PORT: '1' },
      '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /permissionDecision/);
    assert.equal(r.stderr, '');
  });

  test('`hub hook` com leitura comum responde silêncio, sem config nem daemon', () => {
    const r = hub(['hook'], { AGENTS_HUB_PORT: '1' }, '{"tool_name":"Read","tool_input":{}}');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
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

  // R07-07: com config.json quebrado, até `hub help` saía com o erro da config.
  test('`hub help` com config.json inválido: mostra a ajuda (código 0) e avisa da config', () => {
    const home = path.join(raiz, 'config-ruim-help');
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'config.json'), '{bad json');
    for (const comando of [['help'], ['--help'], ['start', '--help']]) {
      const r = hub(comando, { AGENTS_HUB_HOME: home });
      assert.equal(r.code, 0, `${comando.join(' ')}: ${r.stderr}`);
      assert.match(r.stdout, /hub start --agent <id>/);
      assert.match(r.stderr, /aviso: a configuração não carrega/);
      assert.match(r.stderr, /config\.json/);
    }
  });

  // R07-20: `hub start --help` dizia "faltou o objetivo".
  test('`hub <cmd> --help` mostra o uso daquele comando, sem subir o daemon', () => {
    const r = hub(['start', '--help'], { AGENTS_HUB_PORT: '1' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /hub start --agent <id> "objetivo"/);
    assert.match(r.stdout, /--mode <supervised\|semi\|autonomous>/);
    assert.doesNotMatch(r.stdout, /hub sessions/, 'só o trecho do comando, não o help inteiro');
    assert.doesNotMatch(r.stderr, /faltou o objetivo/);

    const ajuda = hub(['help', 'mcp']);
    assert.equal(ajuda.code, 0, ajuda.stderr);
    assert.match(ajuda.stdout, /hub mcp install <agente> --write/);
  });

  // R07-21: `hub mcp show` sem agente dizia `agente "" desconhecido`.
  test('erro de uso: prefixo hub:, linha de uso do comando e código 1', () => {
    const r = hub(['mcp', 'show']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^hub: faltou o agente/m);
    assert.match(r.stderr, /^uso:$/m);
    assert.match(r.stderr, /hub mcp show <agente>/);
    assert.doesNotMatch(r.stderr, /agente "" desconhecido/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'sem stack trace');
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
