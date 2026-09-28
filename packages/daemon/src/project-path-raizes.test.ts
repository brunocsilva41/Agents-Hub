import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HubError } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';
import { raizProibida, validarDiretorioDeProjeto } from './project-path.js';

/**
 * R05-10 (vistoria 05): `POST /projects` aceitava `C:\Windows`, a raiz da
 * unidade e o home inteiro. Projeto é onde o agente ESCREVE (worktree ou
 * `isolation: none`) e de onde o Hub lê `.agents-hub/config.yaml`; registrar
 * uma pasta de sistema entrega ao agente o sistema inteiro como "workdir", e
 * aí `escrita dentro do diretório da sessão` vira escrita em `System32`.
 */

const WIN = {
  plataforma: 'win32' as const,
  home: 'C:\\Users\\ana',
  env: {
    WINDIR: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramW6432: 'C:\\Program Files',
    ProgramData: 'C:\\ProgramData',
  },
};
const POSIX = { plataforma: 'linux' as const, home: '/home/ana', env: {} };

describe('R05-10: raízes proibidas como pasta de projeto', () => {
  const WIN_PROIBIDOS = [
    'C:\\',
    'c:\\',
    'D:\\',
    'C:\\Windows',
    'c:\\windows\\',
    'C:\\Windows\\System32',
    'C:\\Program Files',
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\Users\\ana',
    'c:\\users\\ANA\\',
    '\\\\servidor\\C$',
    '\\\\servidor\\c$\\Users\\ana\\proj',
    '\\\\servidor\\ADMIN$',
    '\\\\servidor\\compartilhado',
  ];
  for (const p of WIN_PROIBIDOS) {
    test(`win32 recusa ${p}`, () => {
      assert.ok(raizProibida(p, WIN), `${p} deveria ser recusado`);
    });
  }

  const WIN_OK = [
    'C:\\Users\\ana\\projetos\\app',
    'C:\\dev\\app',
    'D:\\repos\\x',
    'C:\\Users\\ana\\AppData\\Local\\Temp\\hub-x',
    '\\\\servidor\\compartilhado\\repo',
  ];
  for (const p of WIN_OK) {
    test(`win32 aceita ${p}`, () => {
      assert.equal(raizProibida(p, WIN), null);
    });
  }

  const POSIX_PROIBIDOS = [
    '/',
    '/etc',
    '/etc/nginx',
    '/usr',
    '/usr/bin',
    '/usr/lib/x',
    '/bin',
    '/sbin',
    '/var',
    '/boot',
    '/proc',
    '/sys',
    '/dev',
    '/home/ana',
    '/home/ana/',
  ];
  for (const p of POSIX_PROIBIDOS) {
    test(`posix recusa ${p}`, () => {
      assert.ok(raizProibida(p, POSIX), `${p} deveria ser recusado`);
    });
  }

  // `/var/folders` é o tmpdir do macOS; `/usr/local/src` e `/var/www` guardam
  // projetos de verdade — só a raiz exata de `/usr`/`/var` é recusada.
  for (const p of [
    '/home/ana/proj',
    '/var/www/site',
    '/var/folders/x/T/hub',
    '/usr/local/src/app',
    '/opt/app',
  ]) {
    test(`posix aceita ${p}`, () => {
      assert.equal(raizProibida(p, POSIX), null);
    });
  }

  test('a mensagem diz o que foi recusado e por quê', () => {
    try {
      validarDiretorioDeProjeto(os.homedir());
      assert.fail('home deveria ser recusado');
    } catch (err) {
      assert.ok(err instanceof HubError);
      assert.equal(err.code, 'INVALID_PATH');
      assert.match(err.message, /home/);
    }
  });
});

describe('R05-10: POST /projects com pasta de sistema é 400', () => {
  let raiz: string;
  let hub: Hub;
  let base: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-raizes-'));
    mkdirSync(path.join(raiz, 'manifests'));
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: path.join(raiz, 'manifests'),
      port: 0,
    });
    base = `http://127.0.0.1:${(await hub.start()).port}`;
  });

  after(async () => {
    await hub.shutdown();
    rmSync(raiz, { recursive: true, force: true });
  });

  const sistema = process.platform === 'win32' ? (process.env['WINDIR'] ?? 'C:\\Windows') : '/etc';
  const casos: Array<[string, RegExp]> = [
    [sistema, /sistema/],
    [path.parse(os.tmpdir()).root, /raiz/],
    [os.homedir(), /home/],
  ];
  for (const [p, motivo] of casos) {
    test(`POST /projects {path: ${p}} → 400 INVALID_PATH`, async () => {
      const r = await fetch(`${base}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const texto = await r.text();
      assert.equal(r.status, 400, texto);
      assert.match(texto, /INVALID_PATH/);
      assert.match(texto, motivo);
    });
  }

  test('pasta comum continua aceita', async () => {
    const proj = path.join(raiz, 'proj');
    mkdirSync(proj);
    const r = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: proj }),
    });
    assert.equal(r.status, 201, await r.text());
  });
});
