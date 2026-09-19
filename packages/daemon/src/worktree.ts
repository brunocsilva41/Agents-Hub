import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HubError, type IsolationMode } from '@agents-hub/core';

const execFileAsync = promisify(execFile);

/**
 * `maxBuffer` explícito em todo `execFileAsync('git', ...)` deste arquivo.
 *
 * O default do Node é 1 MB de stdout — `listStale` roda `git worktree list`,
 * que cresce com o número de worktrees/sessões acumuladas ao longo do uso do
 * Hub, e um `maxBuffer` estourado vira `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` em
 * vez de "nenhum worktree obsoleto". Declarar em todo lugar custa zero.
 */
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  isolated: boolean;
  /**
   * Dependências (`node_modules`, `.venv`, `vendor`) que existiam no projeto
   * mas cuja ligação (junction/symlink) falhou neste worktree — vazio quando
   * tudo ligou ou não havia nada pra ligar. O chamador decide o que fazer com
   * o sinal (log de sessão, por exemplo); aqui só se relata o fato.
   */
  dependencyWarnings: string[];
}

/** Resultado de `release`: se o `git worktree remove` não rodou, o motivo real. */
export interface ReleaseResult {
  removed: boolean;
  reason?: string;
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
  /**
   * `symlink` é injetável só para teste determinístico da falha de ligação de
   * dependências — sem isto, forçar `EPERM`/`EEXIST` de verdade dependeria de
   * privilégio de administrador ou de condições de disco específicas do SO.
   * Em produção é sempre `node:fs/promises#symlink`.
   */
  constructor(
    private readonly root: string,
    private readonly symlinkFn: typeof symlink = symlink,
  ) {}

  async isGitRepo(dir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        maxBuffer: GIT_MAX_BUFFER,
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
      return { path: params.projectPath, branch: null, isolated: false, dependencyWarnings: [] };
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
    let baseWarning: string | null = null;
    let base = params.baseRef;
    if (base === undefined) {
      const resolved = await this.currentRef(params.projectPath);
      base = resolved.ref;
      baseWarning = resolved.warning;
    }

    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, dir, base], {
        cwd: params.projectPath,
        maxBuffer: GIT_MAX_BUFFER,
      });
    } catch (err) {
      throw new HubError('ILLEGAL_STATE', `Falha ao criar worktree: ${(err as Error).message}`, {
        dir,
        branch,
        base,
      });
    }

    const dependencyWarnings = await this.#ligarDependencias(params.projectPath, dir);
    if (baseWarning !== null) dependencyWarnings.unshift(baseWarning);

    return { path: dir, branch, isolated: true, dependencyWarnings };
  }

  /**
   * Liga as dependências do projeto no worktree recém-criado.
   *
   * Falhar aqui não invalida o worktree: o agente ainda consegue ler e editar
   * código, só não roda build nem testes. Derrubar a sessão inteira por causa
   * disso seria pior que degradar — mas degradar EM SILÊNCIO é o que fazia
   * "build/testes falharam" parecer bug do agente quando era symlink que não
   * subiu (permissão, por exemplo). Por isso: loga sempre, e devolve o motivo
   * pra quem cria a sessão poder avisar na timeline também.
   */
  async #ligarDependencias(projectPath: string, worktreePath: string): Promise<string[]> {
    const avisos: string[] = [];

    for (const nome of DEPENDENCIAS_LIGADAS) {
      const origem = path.join(projectPath, nome);
      const destino = path.join(worktreePath, nome);

      if (!existsSync(origem) || existsSync(destino)) continue;

      try {
        // 'junction' no Windows não exige privilégio de administrador, ao
        // contrário de symlink de diretório.
        await this.symlinkFn(origem, destino, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        const motivo = (err as Error).message;
        const aviso = `não foi possível ligar "${nome}" em ${worktreePath}: ${motivo}`;
        avisos.push(aviso);
        // eslint-disable-next-line no-console -- persiste em ~/.agents-hub/logs/, não é debug solto
        console.error(`[worktree] ${aviso} — build/testes podem falhar neste worktree`);
      }
    }

    return avisos;
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
  }): Promise<ReleaseResult> {
    if (!existsSync(params.worktreePath)) return { removed: true };
    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', params.worktreePath, ...(params.force ? ['--force'] : [])],
        { cwd: params.projectPath, maxBuffer: GIT_MAX_BUFFER },
      );
      return { removed: true };
    } catch (err) {
      // Worktree sujo (build artifacts, arquivos não rastreados) ou outro erro
      // real do `git worktree remove`: mantemos o diretório em vez de forçar
      // remoção e perder algo que você queria ver — mas o motivo real (não só
      // "não removido") importa pra quem decide se isso é normal (ainda dentro
      // da janela de retenção não é nem chamado) ou uma falha de verdade.
      return { removed: false, reason: (err as Error).message };
    }
  }

  async listStale(projectPath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: projectPath,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length))
        .filter((p) => p.startsWith(this.root));
    } catch (err) {
      // Sem chamador ativo hoje (confirmado via `grep -rn "listStale"
      // packages/`), mas o catch silencioso ficava pronto pra esconder um erro
      // real assim que alguém religasse a função. Loga para não repetir aqui o
      // mesmo buraco que `currentRef` tinha.
      // eslint-disable-next-line no-console -- persiste em ~/.agents-hub/logs/, não é debug solto
      console.error(
        `[worktree] falha ao listar worktrees de ${projectPath}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  async prune(projectPath: string): Promise<void> {
    try {
      await execFileAsync('git', ['worktree', 'prune'], {
        cwd: projectPath,
        maxBuffer: GIT_MAX_BUFFER,
      });
    } catch {
      /* prune é oportunista */
    }
  }

  /**
   * Resolve o commit atual de `dir`, usado como `base` do novo worktree quando
   * `baseRef` não foi passado — decide de qual commit o agente vai partir.
   *
   * Um `git rev-parse HEAD` falhando de verdade (HEAD quebrado, repositório em
   * estado esquisito) não pode virar o literal `"HEAD"` em silêncio: isso faria
   * o worktree nascer sobre uma ref simbólica ambígua sem ninguém saber que a
   * resolução real falhou. Por isso loga o erro e devolve também um aviso, no
   * mesmo formato de `dependencyWarnings`, para `create()` repassar pra quem
   * está criando a sessão.
   */
  private async currentRef(dir: string): Promise<{ ref: string; warning: string | null }> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: dir,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return { ref: stdout.trim(), warning: null };
    } catch (err) {
      const motivo = (err as Error).message;
      const aviso = `não foi possível resolver HEAD em ${dir}, worktree criado sobre a ref literal "HEAD": ${motivo}`;
      // eslint-disable-next-line no-console -- persiste em ~/.agents-hub/logs/, não é debug solto
      console.error(`[worktree] ${aviso}`);
      return { ref: 'HEAD', warning: aviso };
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'projeto';
}
