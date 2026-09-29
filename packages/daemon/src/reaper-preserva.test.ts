import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import type { UnitOfWork } from '@agents-hub/core';
import type { RetentionPolicy } from './config.js';
import { WorktreeReaper } from './reaper.js';
import { WorktreeManager } from './worktree.js';

const exec = promisify(execFile);

/**
 * `hub prune`/retenção (vistoria 2026-09-25, item 2.6):
 *
 * - worktree em que o agente escreveu NUNCA era recolhido (`git worktree
 *   remove` sem `--force` recusa arquivo não rastreado) e o branch
 *   `hub/<id>` ficava no commit-base — recolher com `--force` perderia o
 *   trabalho. Agora o trabalho é commitado no branch antes da remoção;
 * - diretório meio-apagado/órfão (o git já não o reconhece) falhava em toda
 *   varredura para sempre;
 * - `sweep()` não tinha trava de reentrada.
 *
 * Git e filesystem de verdade, com `node_modules` ligado por junction/symlink:
 * nada disto pode reabrir o achado CRÍTICO do item 0.1.
 */
describe('WorktreeReaper: recolhe worktree com trabalho sem perder o trabalho', () => {
  let repo: string;
  let root: string;
  const depFile = () => path.join(repo, 'node_modules', 'dep.txt');

  function assertDependenciasIntactas(contexto: string): void {
    assert.equal(existsSync(depFile()), true, `${contexto}: node_modules/dep.txt do projeto sumiu`);
    assert.equal(readFileSync(depFile(), 'utf8'), 'dep real');
  }

  function storeCom(sessoes: Array<{ id: string; workdir: string }>): UnitOfWork {
    return {
      sessions: {
        list: () =>
          sessoes.map((s) => ({
            ...s,
            projectId: 'proj-1',
            isolation: 'worktree',
            endedAt: '2020-01-01T00:00:00.000Z',
          })),
      },
      projects: { get: (id: string) => (id === 'proj-1' ? { id, path: repo } : null) },
    } as unknown as UnitOfWork;
  }

  const retention = { worktreeDays: 1, sweepIntervalMinutes: 60 } as RetentionPolicy;
  const agora = new Date('2026-01-01T00:00:00.000Z');

  async function worktreesRegistrados(): Promise<string> {
    const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
    return stdout;
  }

  before(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'hub-reaper-repo-'));
    root = mkdtempSync(path.join(os.tmpdir(), 'hub-reaper-root-'));
    await exec('git', ['init', '-q'], { cwd: repo });
    await exec('git', ['config', 'user.email', 'teste@local'], { cwd: repo });
    await exec('git', ['config', 'user.name', 'Teste'], { cwd: repo });
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nnode_modules\nbuild/\n', 'utf8');
    writeFileSync(path.join(repo, 'base.txt'), 'linha original\n', 'utf8');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'inicial'], { cwd: repo });
    mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    writeFileSync(depFile(), 'dep real', 'utf8');
  });

  after(() => {
    for (const dir of [root, repo]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* limpeza de temp é oportunista */
      }
    }
  });

  test('worktree com arquivo novo e alterado é recolhido e o trabalho fica no branch hub/<id>', async () => {
    const manager = new WorktreeManager(root);
    const sessionId = 'ses-trabalho';
    const info = await manager.create({
      projectPath: repo,
      projectName: 'repo',
      sessionId,
      isolation: 'worktree',
    });
    writeFileSync(path.join(info.path, 'novo.txt'), 'escrito pelo agente\n', 'utf8');
    writeFileSync(path.join(info.path, 'base.txt'), 'linha alterada pelo agente\n', 'utf8');
    mkdirSync(path.join(info.path, 'build'), { recursive: true });
    writeFileSync(path.join(info.path, 'build', 'saida.js'), 'ignorado', 'utf8');

    const reaper = new WorktreeReaper(
      storeCom([{ id: sessionId, workdir: info.path }]),
      manager,
      retention,
    );
    const sweep = await reaper.sweep(agora);

    assert.deepEqual(sweep.failed, [], JSON.stringify(sweep.failed));
    assert.deepEqual(sweep.removed, [info.path]);
    assert.equal(existsSync(info.path), false);
    assertDependenciasIntactas('recolher com trabalho');

    const { stdout: novo } = await exec('git', ['show', `hub/${sessionId}:novo.txt`], { cwd: repo });
    assert.equal(novo.replace(/\r\n/g, '\n'), 'escrito pelo agente\n');
    const { stdout: base } = await exec('git', ['show', `hub/${sessionId}:base.txt`], { cwd: repo });
    assert.equal(base.replace(/\r\n/g, '\n'), 'linha alterada pelo agente\n');
    // `node_modules` (ligado) nunca pode entrar no commit automático.
    const { stdout: arvore } = await exec('git', ['ls-tree', '-r', '--name-only', `hub/${sessionId}`], {
      cwd: repo,
    });
    assert.doesNotMatch(arvore, /node_modules/);
    // O branch principal não foi tocado.
    const { stdout: principal } = await exec('git', ['show', 'HEAD:base.txt'], { cwd: repo });
    assert.equal(principal.replace(/\r\n/g, '\n'), 'linha original\n');
  });

  test('diretório órfão (o git não o conhece) é apagado sem seguir links', async () => {
    const orfao = path.join(root, 'repo', 'ses-orfao');
    mkdirSync(path.join(orfao, 'sub'), { recursive: true });
    writeFileSync(path.join(orfao, 'resto.txt'), 'sobra de remoção interrompida', 'utf8');
    // Link ANINHADO para o node_modules real: a remoção não pode atravessá-lo.
    await symlink(
      path.join(repo, 'node_modules'),
      path.join(orfao, 'sub', 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const reaper = new WorktreeReaper(
      storeCom([{ id: 'ses-orfao', workdir: orfao }]),
      new WorktreeManager(root),
      retention,
    );
    const sweep = await reaper.sweep(agora);

    assert.deepEqual(sweep.failed, [], JSON.stringify(sweep.failed));
    assert.deepEqual(sweep.removed, [orfao]);
    assert.equal(existsSync(orfao), false);
    assertDependenciasIntactas('órfão');
  });

  test('worktree meio-apagado (sem .git) é apagado e o registro podado', async () => {
    const manager = new WorktreeManager(root);
    const info = await manager.create({
      projectPath: repo,
      projectName: 'repo',
      sessionId: 'ses-meio',
      isolation: 'worktree',
    });
    unlinkSync(path.join(info.path, '.git'));
    assert.match(await worktreesRegistrados(), /ses-meio/);

    const reaper = new WorktreeReaper(
      storeCom([{ id: 'ses-meio', workdir: info.path }]),
      manager,
      retention,
    );
    const sweep = await reaper.sweep(agora);

    assert.deepEqual(sweep.failed, [], JSON.stringify(sweep.failed));
    assert.equal(existsSync(info.path), false);
    assert.doesNotMatch(await worktreesRegistrados(), /ses-meio/);
    assertDependenciasIntactas('meio-apagado');
  });

  test('sweep() tem trava de reentrada: chamadas simultâneas compartilham a mesma passada', async () => {
    let releases = 0;
    const manager = {
      release: async () => {
        releases += 1;
        // Lentidão simulada: mantém a 1ª passada em voo enquanto as outras chegam.
        await new Promise((r) => setTimeout(r, 30));
        return { removed: true };
      },
      prune: async () => {},
    } as unknown as WorktreeManager;
    const reaper = new WorktreeReaper(
      storeCom([{ id: 'ses-trava', workdir: repo }]),
      manager,
      retention,
    );

    const [a, b, c] = await Promise.all([reaper.sweep(agora), reaper.sweep(agora), reaper.sweep(agora)]);

    assert.equal(releases, 1, 'três varreduras simultâneas não podem disputar o mesmo diretório');
    assert.equal(a, b);
    assert.equal(b, c);
    // Terminada a passada, a próxima roda de novo.
    await reaper.sweep(agora);
    assert.equal(releases, 2);
  });
});
