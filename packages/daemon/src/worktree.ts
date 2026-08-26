import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HubError, type IsolationMode } from '@agents-hub/core';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  isolated: boolean;
}

/**
 * Isolamento por git worktree (ADR 01.3).
 *
 * Cada sessão ganha um checkout próprio com branch próprio. Dois agentes
 * trabalhando ao mesmo tempo deixam de pisar um no arquivo do outro, e revisar
 * o que um agente fez vira um `git diff` normal — em vez de arqueologia no
 * meio das suas mudanças locais.
 */
export class WorktreeManager {
  constructor(private readonly root: string) {}

  async isGitRepo(dir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async create(params: {
    projectPath: string;
    projectName: string;
    sessionId: string;
    isolation: IsolationMode;
    baseRef?: string;
  }): Promise<WorktreeInfo> {
    if (params.isolation === 'none') {
      return { path: params.projectPath, branch: null, isolated: false };
    }

    if (params.isolation === 'container') {
      throw new HubError('ILLEGAL_STATE', 'Isolamento por container ainda não implementado', {
        isolation: params.isolation,
      });
    }

    if (!(await this.isGitRepo(params.projectPath))) {
      // Sem git não há worktree. Falhar em silêncio aqui significaria rodar o
      // agente direto no projeto achando que está isolado — pior que recusar.
      throw new HubError(
        'ILLEGAL_STATE',
        `O projeto em ${params.projectPath} não é um repositório git; use isolation="none" ou rode "git init"`,
        { projectPath: params.projectPath },
      );
    }

    const dir = path.join(this.root, sanitize(params.projectName), params.sessionId);
    const branch = `hub/${params.sessionId}`;
    const base = params.baseRef ?? (await this.currentRef(params.projectPath));

    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, dir, base], {
        cwd: params.projectPath,
      });
    } catch (err) {
      throw new HubError('ILLEGAL_STATE', `Falha ao criar worktree: ${(err as Error).message}`, {
        dir,
        branch,
        base,
      });
    }

    return { path: dir, branch, isolated: true };
  }

  /**
   * Remove o worktree ao encerrar a sessão. O branch é PRESERVADO: o trabalho
   * do agente continua acessível por `git log hub/<sessionId>` mesmo depois da
   * limpeza — descartar seria destruir resultado sem você ter revisado.
   */
  async release(params: {
    projectPath: string;
    worktreePath: string;
    force?: boolean;
  }): Promise<void> {
    if (!existsSync(params.worktreePath)) return;
    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', params.worktreePath, ...(params.force ? ['--force'] : [])],
        { cwd: params.projectPath },
      );
    } catch {
      // Worktree sujo (build artifacts, arquivos não rastreados): mantemos o
      // diretório em vez de forçar remoção e perder algo que você queria ver.
    }
  }

  async listStale(projectPath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: projectPath,
      });
      return stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length))
        .filter((p) => p.startsWith(this.root));
    } catch {
      return [];
    }
  }

  async prune(projectPath: string): Promise<void> {
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: projectPath });
    } catch {
      /* prune é oportunista */
    }
  }

  private async currentRef(dir: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
      return stdout.trim();
    } catch {
      return 'HEAD';
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'projeto';
}
