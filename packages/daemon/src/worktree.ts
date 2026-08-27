import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
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
 * Diretórios de dependência ligados do projeto para o worktree.
 *
 * Um `git worktree` traz só o que está versionado — e `node_modules` não está.
 * Sem esta ligação, o agente entra num checkout onde `npm test` e `tsc` falham
 * na primeira linha, por um motivo que não tem nada a ver com o trabalho dele:
 * foi assim que o portão de validação reprovou três tentativas seguidas no
 * primeiro teste real.
 *
 * A ligação é um junction (Windows) ou symlink (POSIX), não uma cópia — copiar
 * `node_modules` a cada sessão custaria minutos e gigabytes.
 *
 * **Contrapartida assumida:** as dependências passam a ser COMPARTILHADAS com o
 * projeto. Um `npm install` dentro do worktree altera a árvore do repositório
 * principal. Por isso `npm install` não está na allow list de comandos: ele cai
 * em `escalate` e aparece na timeline.
 */
const DEPENDENCIAS_LIGADAS = ['node_modules', '.venv', 'vendor'];

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

    await this.#ligarDependencias(params.projectPath, dir);

    return { path: dir, branch, isolated: true };
  }

  /**
   * Liga as dependências do projeto no worktree recém-criado.
   *
   * Falhar aqui não invalida o worktree: o agente ainda consegue ler e editar
   * código, só não roda build nem testes. Derrubar a sessão inteira por causa
   * disso seria pior que degradar.
   */
  async #ligarDependencias(projectPath: string, worktreePath: string): Promise<void> {
    for (const nome of DEPENDENCIAS_LIGADAS) {
      const origem = path.join(projectPath, nome);
      const destino = path.join(worktreePath, nome);

      if (!existsSync(origem) || existsSync(destino)) continue;

      try {
        // 'junction' no Windows não exige privilégio de administrador, ao
        // contrário de symlink de diretório.
        await symlink(origem, destino, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // Degrada em silêncio: sem a ligação o agente perde build e testes,
        // mas continua conseguindo trabalhar no código.
      }
    }
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
