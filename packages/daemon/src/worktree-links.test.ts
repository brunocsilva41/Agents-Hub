import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
 * Regressão do achado CRÍTICO "Reaper apaga o node_modules REAL" (vistoria
 * 2026-09-25, item 0.1 do GOAL).
 *
 * `create()` liga `node_modules` do projeto no worktree por junction
 * (Windows) / symlink (POSIX). O `git worktree remove` do Git for Windows
 * SEGUE o junction e apaga o conteúdo do diretório real do projeto. Estes
 * testes usam filesystem e git de verdade: se a ligação não for desfeita antes
 * do `git worktree remove`, os arquivos do projeto somem e o teste fica
 * vermelho.
 */
describe('WorktreeManager — remoção não atravessa links de dependência', () => {
  let repo: string;
  let root: string;
  const depFile = () => path.join(repo, 'node_modules', 'dep.txt');
  const subFile = () => path.join(repo, 'node_modules', 'sub', 'z.js');

  function assertProjetoIntacto(contexto: string): void {
    assert.equal(existsSync(depFile()), true, `${contexto}: node_modules/dep.txt do projeto sumiu`);
    assert.equal(existsSync(subFile()), true, `${contexto}: node_modules/sub/z.js do projeto sumiu`);
    assert.equal(readFileSync(depFile(), 'utf8'), 'dep real');
    assert.equal(readFileSync(subFile(), 'utf8'), 'module.exports = 1;');
  }

  function recriarDependencias(): void {
    mkdirSync(path.join(repo, 'node_modules', 'sub'), { recursive: true });
    writeFileSync(depFile(), 'dep real', 'utf8');
    writeFileSync(subFile(), 'module.exports = 1;', 'utf8');
  }

  async function criar(manager: WorktreeManager, sessionId: string): Promise<string> {
    const info = await manager.create({
      projectPath: repo,
      projectName: 'repo',
      sessionId,
      isolation: 'worktree',
    });
    // Pré-condição: a ligação existe de fato (senão o teste não prova nada).
    assert.equal(info.dependencyWarnings.length, 0, info.dependencyWarnings.join('; '));
    assert.equal(lstatSync(path.join(info.path, 'node_modules')).isSymbolicLink(), true);
    assert.equal(existsSync(path.join(info.path, 'node_modules', 'dep.txt')), true);
    return info.path;
  }

  before(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'hub-wt-links-repo-'));
    root = mkdtempSync(path.join(os.tmpdir(), 'hub-wt-links-root-'));
    await exec('git', ['init', '-q'], { cwd: repo });
    await exec('git', ['config', 'user.email', 'teste@local'], { cwd: repo });
    await exec('git', ['config', 'user.name', 'Teste'], { cwd: repo });
    // Cenário real: node_modules ignorado — assim `git worktree remove` sem
    // --force aceita remover (o link não conta como sujeira) e segue o junction.
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nnode_modules\n', 'utf8');
    writeFileSync(path.join(repo, 'base.txt'), 'linha original\n', 'utf8');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'inicial'], { cwd: repo });
    recriarDependencias();
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

  test('release() normal não apaga node_modules do projeto', async () => {
    const manager = new WorktreeManager(root);
    const wt = await criar(manager, 'ses-links-ok');

    const result = await manager.release({ projectPath: repo, worktreePath: wt });

    assert.equal(result.removed, true, result.reason);
    assert.equal(existsSync(wt), false);
    assertProjetoIntacto('release normal');
  });

  test('release() com force em worktree sujo não apaga node_modules do projeto', async () => {
    recriarDependencias();
    const manager = new WorktreeManager(root);
    const wt = await criar(manager, 'ses-links-force');
    writeFileSync(path.join(wt, 'sujeira.txt'), 'não commitado', 'utf8');

    const result = await manager.release({ projectPath: repo, worktreePath: wt, force: true });

    assert.equal(result.removed, true, result.reason);
    assert.equal(existsSync(wt), false);
    assertProjetoIntacto('release --force');
  });

  test('release() sem force em worktree sujo mantém o worktree e religa as dependências', async () => {
    recriarDependencias();
    const manager = new WorktreeManager(root);
    const wt = await criar(manager, 'ses-links-sujo');
    writeFileSync(path.join(wt, 'sujeira.txt'), 'não commitado', 'utf8');

    const result = await manager.release({ projectPath: repo, worktreePath: wt });

    assert.equal(result.removed, false);
    assert.equal(existsSync(wt), true);
    assertProjetoIntacto('release sujo');
    // Worktree retido para inspeção continua utilizável (build/testes).
    assert.equal(lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), true);
    assert.equal(existsSync(path.join(wt, 'node_modules', 'dep.txt')), true);

    await manager.release({ projectPath: repo, worktreePath: wt, force: true });
    assertProjetoIntacto('limpeza com force');
  });

  test('defesa em profundidade: qualquer link de primeiro nível é desfeito sem seguir o alvo', async () => {
    recriarDependencias();
    const alvoExtra = path.join(repo, 'dados-extra');
    mkdirSync(alvoExtra, { recursive: true });
    writeFileSync(path.join(alvoExtra, 'importante.txt'), 'não apagar', 'utf8');

    const manager = new WorktreeManager(root);
    const wt = await criar(manager, 'ses-links-extra');
    // Link que NÃO está na lista de dependências (agente/ferramenta criou).
    await symlink(
      alvoExtra,
      path.join(wt, 'link-extra'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await manager.release({ projectPath: repo, worktreePath: wt, force: true });

    assert.equal(result.removed, true, result.reason);
    assert.equal(
      existsSync(path.join(alvoExtra, 'importante.txt')),
      true,
      'alvo do link extra foi apagado',
    );
    assertProjetoIntacto('link extra');
  });

  test('se um link não puder ser desfeito, recusa a remoção sem chamar git e loga', async () => {
    recriarDependencias();
    const falhaDesligar = (): void => {
      throw new Error('EBUSY: link em uso (simulado para teste)');
    };
    const manager = new WorktreeManager(root, symlink, falhaDesligar);
    const wt = await criar(manager, 'ses-links-recusa');

    const originalError = console.error;
    const chamadas: string[] = [];
    console.error = (...args: unknown[]) => {
      chamadas.push(args.map(String).join(' '));
    };
    let result;
    try {
      result = await manager.release({ projectPath: repo, worktreePath: wt, force: true });
    } finally {
      console.error = originalError;
    }

    assert.equal(result.removed, false);
    assert.match(result.reason ?? '', /node_modules/);
    assert.equal(existsSync(wt), true, 'git worktree remove não deveria ter rodado');
    assert.ok(
      chamadas.some((l) => l.includes('[worktree]') && l.includes('node_modules')),
      'a recusa precisa aparecer no log do daemon',
    );
    assertProjetoIntacto('recusa');

    // Limpeza com o desligamento real.
    await new WorktreeManager(root).release({ projectPath: repo, worktreePath: wt, force: true });
    assertProjetoIntacto('limpeza da recusa');
  });

  test('WorktreeReaper.sweep() remove worktree expirado sem apagar node_modules do projeto', async () => {
    recriarDependencias();
    const manager = new WorktreeManager(root);
    const wt = await criar(manager, 'ses-links-reaper');

    const store = {
      sessions: {
        list: () => [
          {
            id: 'ses-links-reaper',
            projectId: 'proj-1',
            isolation: 'worktree',
            workdir: wt,
            endedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
      projects: { get: (id: string) => (id === 'proj-1' ? { id, path: repo } : null) },
    } as unknown as UnitOfWork;
    const retention = { worktreeDays: 1, sweepIntervalMinutes: 60 } as RetentionPolicy;

    const reaper = new WorktreeReaper(store, manager, retention);
    const sweep = await reaper.sweep(new Date('2026-01-01T00:00:00.000Z'));

    assert.deepEqual(sweep.failed, []);
    assert.deepEqual(sweep.removed, [wt]);
    assert.equal(existsSync(wt), false);
    assertProjetoIntacto('reaper');
  });
});
