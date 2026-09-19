import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { WorktreeManager } from './worktree.js';

const exec = promisify(execFile);

/**
 * `WorktreeManager` — ligação de dependências e liberação de worktree.
 *
 * As duas coisas testadas aqui eram engolidas em silêncio antes desta
 * vistoria: `release()` que falhava virava "kept" sem motivo registrado, e a
 * junção de `node_modules` que falhava degradava sem log nenhum. Nos dois
 * casos o sintoma real é "o portão de validação reprovou sem motivo
 * aparente" — exatamente o tipo de bug que não deixa rastro pra investigar
 * depois.
 */
describe('WorktreeManager', () => {
  let repo: string;
  let root: string;

  before(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'hub-worktree-repo-'));
    root = mkdtempSync(path.join(os.tmpdir(), 'hub-worktree-root-'));
    await exec('git', ['init', '-q'], { cwd: repo });
    await exec('git', ['config', 'user.email', 'teste@local'], { cwd: repo });
    await exec('git', ['config', 'user.name', 'Teste'], { cwd: repo });
    writeFileSync(path.join(repo, 'base.txt'), 'linha original\n', 'utf8');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'inicial'], { cwd: repo });
  });

  after(() => {
    for (const dir of [repo, root]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* limpeza de temp é oportunista */
      }
    }
  });

  test('release() bem-sucedido remove o diretório e devolve removed: true', async () => {
    const manager = new WorktreeManager(root);
    const info = await manager.create({
      projectPath: repo,
      projectName: 'repo',
      sessionId: 'ses-ok',
      isolation: 'worktree',
    });

    const result = await manager.release({ projectPath: repo, worktreePath: info.path });

    assert.equal(result.removed, true);
    assert.equal(result.reason, undefined);
    assert.equal(existsSync(info.path), false);
  });

  test('release() que falha de verdade devolve removed: false com o motivo real do git', async () => {
    const manager = new WorktreeManager(root);
    const info = await manager.create({
      projectPath: repo,
      projectName: 'repo',
      sessionId: 'ses-sujo',
      isolation: 'worktree',
    });

    // Worktree "sujo" de propósito: arquivo não rastreado dentro dele faz
    // `git worktree remove` (sem --force) recusar a remoção de verdade — não
    // é "ainda dentro da janela de retenção", é uma falha real do comando.
    writeFileSync(path.join(info.path, 'sujeira.txt'), 'não commitado', 'utf8');

    const result = await manager.release({ projectPath: repo, worktreePath: info.path });

    assert.equal(result.removed, false, 'árvore suja não deveria ter sido removida');
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'o motivo real do git precisa vir junto, não só "não removido"',
    );
    assert.equal(existsSync(info.path), true, 'o diretório continua no disco');

    // Limpeza: força a remoção pra não vazar worktree entre os testes.
    await manager.release({ projectPath: repo, worktreePath: info.path, force: true });
  });

  test('dependência que existe no projeto mas não pôde ser ligada é logada, não some em silêncio', async () => {
    // node_modules existe no projeto "de fato" pra passar do `existsSync`
    // dentro de `#ligarDependencias`.
    mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', 'marca.txt'), 'x', 'utf8');

    // `symlink` é injetado com uma falha determinística — reproduzir EPERM/
    // EEXIST de verdade dependeria de privilégio de administrador ou de disco
    // específico do SO, e o ponto do teste é o SINAL (retorno + log), não o
    // motivo do SO por trás dele.
    const falhaSymlink = async () => {
      throw new Error('EPERM: operação não permitida (symlink simulado para teste)');
    };
    const manager = new WorktreeManager(root, falhaSymlink as typeof import('node:fs/promises').symlink);

    const originalError = console.error;
    const chamadas: string[] = [];
    console.error = (...args: unknown[]) => {
      chamadas.push(args.map(String).join(' '));
    };

    try {
      const info = await manager.create({
        projectPath: repo,
        projectName: 'repo-deps',
        sessionId: 'ses-deps',
        isolation: 'worktree',
      });

      assert.equal(info.dependencyWarnings.length, 1);
      assert.match(info.dependencyWarnings[0] ?? '', /node_modules/);
      assert.match(info.dependencyWarnings[0] ?? '', /EPERM/);

      assert.ok(
        chamadas.some((l) => l.includes('[worktree]') && l.includes('node_modules')),
        'a falha de symlink precisa aparecer no log do daemon, não só degradar em silêncio',
      );
    } finally {
      console.error = originalError;
      await manager
        .release({
          projectPath: repo,
          worktreePath: path.join(root, 'repo-deps', 'ses-deps'),
          force: true,
        })
        .catch(() => {});
    }
  });
});
