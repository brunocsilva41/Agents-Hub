import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub, type Hub } from './hub.js';

/**
 * Item 5.5 do GOAL (vistoria 2026-09-25, 07 e 13): no Windows o mesmo
 * diretório escrito pelo nome curto 8.3 ou com outra caixa virava um
 * SEGUNDO projeto, ou um PROJECT_FOLDER_CONFLICT dizendo que a pasta "está
 * DENTRO" dela mesma.
 */

const win = process.platform === 'win32';

/** Nome curto 8.3 de `dir` (Windows), ou `null` se o volume não gera 8.3. */
function nomeCurto(dir: string): string | null {
  try {
    const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], {
      windowsVerbatimArguments: true,
      encoding: 'utf8',
    }).stdout.trim();
    return out.length > 0 && out.toLowerCase() !== dir.toLowerCase() ? out : null;
  } catch {
    return null;
  }
}

describe('registro de projeto: caminho canônico (8.3, caixa)', () => {
  let hub: Hub;
  let raiz: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-canon-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({ home: raiz, manifestsDir: manifestos, webRoot: path.join(raiz, 'sem-web') });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function pasta(nome: string): string {
    const dir = path.join(raiz, nome);
    mkdirSync(dir, { recursive: true });
    return realpathSync.native(dir);
  }

  test('o projeto é gravado com a grafia do disco', () => {
    const longo = pasta('Grafia Longa');
    const p = hub.sessions.registerProject(longo);
    assert.equal(p.path, longo);
  });

  test('mesma pasta com outra CAIXA devolve o mesmo projeto (Windows)', { skip: !win }, () => {
    const dir = pasta('Caixa Mista');
    const a = hub.sessions.registerProject(dir);
    const b = hub.sessions.registerProject(dir.toUpperCase());
    const c = hub.sessions.registerProject(dir.toLowerCase());
    assert.equal(b.id, a.id);
    assert.equal(c.id, a.id);
    assert.equal(hub.sessions.listProjects().filter((p) => p.path.toLowerCase() === dir.toLowerCase()).length, 1);
  });

  test('mesma pasta pelo nome curto 8.3 devolve o mesmo projeto (Windows)', { skip: !win }, (t) => {
    const dir = pasta('Nome Bem Comprido Com Espacos');
    const curto = nomeCurto(dir);
    if (curto === null) {
      t.skip('volume sem nomes 8.3');
      return;
    }
    const a = hub.sessions.registerProject(curto);
    const b = hub.sessions.registerProject(dir);
    assert.equal(b.id, a.id);
    assert.equal(a.path, dir, 'gravado pelo nome longo, não pelo 8.3');
  });

  test('pasta extra com outra caixa: "já pertence", não "está DENTRO" dela mesma (Windows)', { skip: !win }, () => {
    const principal = pasta('Principal');
    const extra = pasta('Extra');
    const p = hub.sessions.registerProject(principal);
    hub.sessions.addProjectFolder(p.id, extra);
    assert.throws(
      () => hub.sessions.addProjectFolder(p.id, extra.toUpperCase()),
      (err: Error) => /já pertence ao projeto/.test(err.message) && !/DENTRO/.test(err.message),
    );
  });
});
