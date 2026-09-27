import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { capturar, limpar, repoGit } from './test-kit.js';
import { updateCommand } from './update-cmd.js';

const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-update-'));
after(() => limpar(raiz));

function dentroDeRepo(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * `hub update` não existia e não havia canal de atualização. O comando tem de
 * dizer isso com honestidade e mostrar o caminho real (git pull + build +
 * restart), sem executar nada por conta própria.
 */
describe('hub update', () => {
  test('clone git: mostra de onde roda, mudanças locais e os passos (sem executar)', async () => {
    const repo = path.join(raiz, 'clone');
    const git = repoGit(repo);
    const pkg = path.join(repo, 'packages', 'cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'a.txt'), 'um\n');
    git('add', '.');
    git('commit', '-q', '-m', 'inicial');
    writeFileSync(path.join(pkg, 'a.txt'), 'mudado\n');

    const { out, valor } = await capturar(() =>
      updateCommand({ command: 'update', positional: [], flags: {} }, { packageDir: pkg }),
    );
    assert.equal(valor.method, 'git');
    assert.equal(path.resolve(valor.repo!), path.resolve(repo));
    assert.equal(valor.branch, 'main');
    assert.equal(valor.dirty, 1);
    assert.equal(valor.behind, null, 'sem --check não consulta o remoto');
    assert.ok(valor.steps[0]?.includes('pull --ff-only'));
    assert.ok(valor.steps.includes('hub restart'));
    assert.ok(out.some((l) => l.includes('não há canal de atualização publicado')));
    assert.ok(out.some((l) => l.includes('modificado')));
    // Nada foi executado: o arquivo modificado continua como estava.
    assert.equal(git('status', '--porcelain').trim(), 'M packages/cli/a.txt');
  });

  test('--check consulta o remoto e conta os commits que faltam (--json puro)', async () => {
    const remoto = path.join(raiz, 'remoto');
    const gitR = repoGit(remoto);
    writeFileSync(path.join(remoto, 'x.txt'), '1\n');
    gitR('add', '.');
    gitR('commit', '-q', '-m', 'um');
    const local = path.join(raiz, 'local');
    execFileSync('git', ['clone', '-q', remoto, local], { windowsHide: true });
    writeFileSync(path.join(remoto, 'x.txt'), '2\n');
    gitR('commit', '-q', '-am', 'dois');
    writeFileSync(path.join(remoto, 'x.txt'), '3\n');
    gitR('commit', '-q', '-am', 'tres');

    const { out, valor } = await capturar(() =>
      updateCommand({ command: 'update', positional: [], flags: { check: true, json: true } }, { packageDir: local }),
    );
    assert.equal(valor.behind, 2);
    assert.equal(valor.ahead, 0);
    assert.deepEqual(JSON.parse(out.join('\n')), JSON.parse(JSON.stringify(valor)));
  });

  test('instalado pelo tarball: passos de reempacotar e reinstalar no mesmo prefixo', async (t) => {
    // Layout de `npm i -g agents-hub-<v>.tgz --prefix <pfx>` no Windows.
    const prefixo = path.join(raiz, 'pfx');
    const pacote = path.join(prefixo, 'node_modules', 'agents-hub');
    const cli = path.join(pacote, 'node_modules', '@agents-hub', 'cli');
    mkdirSync(cli, { recursive: true });
    writeFileSync(path.join(pacote, 'package.json'), JSON.stringify({ name: 'agents-hub', version: '0.1.0' }));
    if (process.platform !== 'win32') {
      t.skip('layout do prefixo global do Windows (POSIX usa <prefixo>/lib/node_modules)');
      return;
    }
    const { out, valor } = await capturar(() =>
      updateCommand({ command: 'update', positional: [], flags: {} }, { packageDir: cli }),
    );
    // Antes: "não achei um clone git" e "npm ci && npm run build" — passos
    // que não atualizam a instalação global (visto seguindo o guia, item 8.4).
    assert.equal(valor.method, 'pacote');
    assert.equal(path.resolve(valor.installRoot!), path.resolve(pacote));
    assert.equal(path.resolve(valor.npmPrefix!), path.resolve(prefixo));
    assert.ok(valor.steps.some((p) => p.includes('npm run pack:dist')));
    assert.ok(valor.steps.some((p) => p.startsWith('npm i -g') && p.includes(prefixo)));
    assert.ok(valor.steps.includes('hub restart'));
    assert.ok(!out.some((l) => l.includes('não achei um clone git')));
  });

  test('fora de clone git: diz que não há canal e como atualizar à mão', async (t) => {
    const solto = path.join(raiz, 'solto', 'packages', 'cli');
    mkdirSync(solto, { recursive: true });
    if (dentroDeRepo(solto)) {
      t.skip('o diretório temporário desta máquina está dentro de um repositório git');
      return;
    }
    const { out, valor } = await capturar(() =>
      updateCommand({ command: 'update', positional: [], flags: {} }, { packageDir: solto }),
    );
    assert.equal(valor.method, 'desconhecido');
    assert.equal(valor.repo, null);
    assert.ok(out.some((l) => l.includes('não há canal de atualização publicado')));
    assert.ok(valor.steps.includes('hub restart'));
  });
});
