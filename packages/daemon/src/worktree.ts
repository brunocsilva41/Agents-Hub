import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
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
 * Desfaz UM link (junction/symlink) sem seguir o alvo.
 *
 * `unlinkSync` remove o próprio ponto de reparse/symlink; em algumas
 * combinações de SO/versão um junction de diretório só sai com `rmdirSync`
 * (que, num junction, também remove só o link — nunca o conteúdo do alvo,
 * porque não é recursivo). Nunca usar `rmSync({ recursive: true })` aqui: em
 * versões do Node/Windows ele atravessa o junction e apaga o alvo.
 */
function desligarLink(caminho: string): void {
  try {
    unlinkSync(caminho);
  } catch {
    rmdirSync(caminho);
  }
}

/**
 * Apaga uma árvore de diretórios SEM seguir link nenhum, em qualquer nível.
 *
 * Existe para o diretório meio-apagado/órfão (o git já não o reconhece como
 * worktree, então `git worktree remove` não serve). `rmSync({ recursive })`
 * está fora de questão pelo mesmo motivo de `desligarLink`: em versões do
 * Node/Windows ele atravessa junction e apaga o alvo — o `node_modules` real
 * do projeto. Aqui todo link é desfeito como link, e só diretório de verdade
 * é percorrido. Arquivo somente-leitura (objetos do git no Windows) ganha
 * permissão de escrita antes do `unlink`.
 */
export function removerSemSeguirLinks(
  alvo: string,
  desligar: (caminho: string) => void = desligarLink,
): void {
  let info;
  try {
    info = lstatSync(alvo);
  } catch {
    return; // já não existe
  }
  if (info.isSymbolicLink()) {
    desligar(alvo);
    return;
  }
  if (info.isDirectory()) {
    for (const nome of readdirSync(alvo)) removerSemSeguirLinks(path.join(alvo, nome), desligar);
    rmdirSync(alvo);
    return;
  }
  try {
    unlinkSync(alvo);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EACCES') {
      throw err;
    }
    chmodSync(alvo, 0o666);
    unlinkSync(alvo);
  }
}

/** Caminho comparável entre o que o git imprime e o que o Hub guardou (caixa, barras, 8.3). */
function caminhoComparavel(p: string): string {
  let real = p;
  try {
    real = realpathSync.native(p);
  } catch {
    /* inexistente: compara como veio */
  }
  const norm = path.resolve(real).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm.replace(/\//g, '\\').toLowerCase() : norm;
}

/** Identidade dos commits automáticos do Hub — não depende do `user.*` da máquina. */
const IDENTIDADE_DO_HUB = [
  '-c',
  'user.name=Agents-Hub',
  '-c',
  'user.email=agents-hub@localhost',
  '-c',
  'commit.gpgsign=false',
];

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
  /**
   * `desligarFn` idem: injetável só para testar a recusa quando um link não
   * pode ser desfeito (link em uso, permissão) — em produção é `desligarLink`.
   */
  constructor(
    private readonly root: string,
    private readonly symlinkFn: typeof symlink = symlink,
    private readonly desligarFn: (caminho: string) => void = desligarLink,
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

  /** `HEAD` aponta para algum commit? Falso num `git init` recém-feito. */
  async #temCommit(dir: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
        cwd: dir,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return true;
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

    // Repositório recém-criado (`git init` sem commit): o worktree nasce de um
    // commit e não há nenhum. Antes, o erro cru do git ("fatal: invalid
    // reference: HEAD") chegava ao usuário sem dizer o que fazer.
    if (params.baseRef === undefined && !(await this.#temCommit(params.projectPath))) {
      throw new HubError(
        'ILLEGAL_STATE',
        `O repositório em ${params.projectPath} ainda não tem nenhum commit, e o worktree isolado ` +
          'nasce de um commit. Faça o commit inicial (git add -A && git commit -m "inicial") ' +
          'ou rode sem isolamento (--isolation none: o agente trabalha direto na pasta do projeto).',
        { projectPath: params.projectPath, motivo: 'repositorio-sem-commit' },
      );
    }

    const dir = path.join(this.root, nomeDaPastaDoProjeto(params.projectName), params.sessionId);
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
        // console.error de propósito: persiste em ~/.agents-hub/logs/, não é debug solto
        console.error(`[worktree] ${aviso} — build/testes podem falhar neste worktree`);
      }
    }

    return avisos;
  }

  /**
   * Remove o worktree. O branch `hub/<sessionId>` nunca é apagado.
   *
   * Sem `preserveWork` (uso direto), a remoção é conservadora: worktree sujo
   * fica no disco, a menos que `force` seja pedido.
   *
   * Com `preserveWork` (o reaper), o trabalho do agente é COMMITADO no branch
   * do worktree antes da remoção — só assim a promessa "o trabalho continua em
   * `git log hub/<id>`" é verdadeira. Antes nada commitava: o branch ficava no
   * commit-base e todo worktree em que o agente escreveu falhava para sempre
   * no `git worktree remove` sem `--force` (vistoria 2026-09-25, item 2.6).
   * Com o trabalho no branch, a remoção pode forçar (sobram só arquivos
   * ignorados, como artefatos de build). Diretório meio-apagado ou órfão (o
   * git já não o reconhece) é apagado sem seguir links, e o registro velho sai
   * com `git worktree prune`.
   */
  async release(params: {
    projectPath: string;
    worktreePath: string;
    force?: boolean;
    preserveWork?: { sessionId: string };
  }): Promise<ReleaseResult> {
    if (!existsSync(params.worktreePath)) return { removed: true };

    // CRÍTICO: o `git worktree remove` do Git for Windows SEGUE o junction de
    // `node_modules` e apaga o conteúdo do diretório REAL do projeto. Todo
    // link de primeiro nível sai antes do git rodar; se algum não sair, a
    // remoção é recusada — o reaper tenta de novo na próxima passada.
    // (Também vem antes do commit automático: um link commitado levaria o
    // `node_modules` inteiro para o branch.)
    const recusa = this.#desfazerLinks(params.worktreePath);
    if (recusa !== null) {
      // console.error de propósito: persiste em ~/.agents-hub/logs/, não é debug solto
      console.error(`[worktree] remoção de ${params.worktreePath} recusada: ${recusa}`);
      return { removed: false, reason: recusa };
    }

    let force = params.force === true;
    if (params.preserveWork) {
      const registrado = await this.#registrado(params.projectPath, params.worktreePath);
      if (registrado === null) {
        await this.#ligarDependencias(params.projectPath, params.worktreePath);
        return {
          removed: false,
          reason: `não foi possível consultar os worktrees de ${params.projectPath} — nada removido`,
        };
      }
      if (!registrado) {
        // Órfão: o git do projeto não conhece este diretório (sobra de uma
        // remoção que falhou no meio). Não há branch para onde levar nada.
        return this.#apagarOrfao(params.projectPath, params.worktreePath);
      }

      const falha = await this.#preservarTrabalho(
        params.worktreePath,
        params.preserveWork.sessionId,
      );
      if (falha !== null) {
        if (!(await this.#reconhecidoPeloGit(params.worktreePath))) {
          // Registrado, mas meio-apagado (sem `.git`/admin dir): o git não
          // consegue nem ler o estado dele, quanto mais commitar.
          return this.#apagarOrfao(params.projectPath, params.worktreePath);
        }
        await this.#ligarDependencias(params.projectPath, params.worktreePath);
        // console.error de propósito: persiste em ~/.agents-hub/logs/, não é debug solto
        console.error(
          `[worktree] trabalho de ${params.worktreePath} não pôde ser commitado: ${falha}`,
        );
        return { removed: false, reason: `trabalho não commitado, worktree mantido: ${falha}` };
      }
      // Trabalho já está no branch: o que sobrar no diretório é ignorado pelo git.
      force = true;
    }

    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', params.worktreePath, ...(force ? ['--force'] : [])],
        { cwd: params.projectPath, maxBuffer: GIT_MAX_BUFFER },
      );
      return { removed: true };
    } catch (err) {
      const motivo = (err as Error).message;
      if (params.preserveWork && existsSync(params.worktreePath)) {
        // O git desistiu no meio ("Directory not empty", "is not a working
        // tree", arquivo preso): o trabalho já está commitado, então o que
        // restou é lixo — apaga sem seguir links e poda o registro.
        return this.#apagarOrfao(params.projectPath, params.worktreePath);
      }
      // Worktree sujo (build artifacts, arquivos não rastreados) ou outro erro
      // real do `git worktree remove`: mantemos o diretório em vez de forçar
      // remoção e perder algo que você queria ver — mas o motivo real (não só
      // "não removido") importa pra quem decide se isso é normal (ainda dentro
      // da janela de retenção não é nem chamado) ou uma falha de verdade.
      //
      // Os links foram desfeitos antes da tentativa: religa as dependências
      // para o worktree retido continuar utilizável (build/testes) durante a
      // inspeção.
      await this.#ligarDependencias(params.projectPath, params.worktreePath);
      return { removed: false, reason: motivo };
    }
  }

  /**
   * Commita tudo o que o agente deixou no worktree (inclusive arquivos novos)
   * no branch dele. Devolve `null` quando o trabalho está a salvo (commitado
   * agora ou nada a commitar), ou o motivo da falha.
   *
   * Identidade e assinatura fixas e `--no-verify`: é um instantâneo
   * automático do Hub num branch próprio, não um commit do usuário — não pode
   * depender de `user.email` configurado, de GPG nem de hook de lint do repo
   * (um hook lento ou quebrado faria o worktree nunca ser recolhido).
   *
   * HEAD destacado (o agente fez checkout de um commit): o commit não teria
   * branch nenhum apontando para ele e se perderia com o worktree, então ganha
   * um branch próprio `hub/<sessionId>-preservado`.
   */
  async #preservarTrabalho(worktreePath: string, sessionId: string): Promise<string | null> {
    const git = (args: string[]) =>
      execFileAsync('git', args, { cwd: worktreePath, maxBuffer: GIT_MAX_BUFFER });
    try {
      await git(['add', '-A']);
      const { stdout } = await git(['status', '--porcelain']);
      if (stdout.trim().length > 0) {
        await git([
          ...IDENTIDADE_DO_HUB,
          'commit',
          '--no-verify',
          '-q',
          '-m',
          `hub: trabalho da sessão ${sessionId} preservado antes de recolher o worktree`,
        ]);
      }
      const emBranch = await git(['symbolic-ref', '-q', 'HEAD']).then(
        () => true,
        () => false,
      );
      if (!emBranch) {
        await git(['branch', '-f', `hub/${sessionId}-preservado`, 'HEAD']);
      }
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /**
   * O git do projeto lista este diretório como worktree? `null` quando nem
   * deu para perguntar (git ausente, projeto sumiu) — aí nada é apagado.
   */
  async #registrado(projectPath: string, worktreePath: string): Promise<boolean | null> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: projectPath,
        maxBuffer: GIT_MAX_BUFFER,
      }));
    } catch {
      return null;
    }
    const alvo = caminhoComparavel(worktreePath);
    return stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .some((l) => caminhoComparavel(l.slice('worktree '.length)) === alvo);
  }

  /** O diretório ainda é um checkout que o git consegue ler? */
  async #reconhecidoPeloGit(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: worktreePath,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return caminhoComparavel(stdout.trim()) === caminhoComparavel(worktreePath);
    } catch {
      return false;
    }
  }

  /** Apaga diretório órfão/meio-apagado sem seguir links e poda o registro do git. */
  async #apagarOrfao(projectPath: string, worktreePath: string): Promise<ReleaseResult> {
    try {
      removerSemSeguirLinks(worktreePath, this.desligarFn);
    } catch (err) {
      return {
        removed: false,
        reason: `diretório órfão não pôde ser apagado: ${(err as Error).message}`,
      };
    }
    await this.prune(projectPath);
    return { removed: true };
  }

  /**
   * Desfaz todo symlink/junction de primeiro nível do worktree SEM seguir o
   * alvo (`lstat`, não `stat`). Cobre as dependências ligadas por
   * `#ligarDependencias` e, por defesa em profundidade, qualquer outro link
   * que um agente ou ferramenta tenha criado ali.
   *
   * Devolve `null` se o worktree ficou sem links de primeiro nível, ou o
   * motivo se algum não pôde ser desfeito — nesse caso o chamador NÃO pode
   * rodar `git worktree remove`.
   */
  #desfazerLinks(worktreePath: string): string | null {
    let entradas: string[];
    try {
      entradas = readdirSync(worktreePath);
    } catch (err) {
      return `não foi possível listar ${worktreePath} para desfazer links: ${(err as Error).message}`;
    }

    const falhas: string[] = [];
    for (const nome of entradas) {
      const caminho = path.join(worktreePath, nome);
      try {
        if (!lstatSync(caminho).isSymbolicLink()) continue;
      } catch (err) {
        falhas.push(`"${nome}": lstat falhou: ${(err as Error).message}`);
        continue;
      }
      try {
        this.desligarFn(caminho);
      } catch (err) {
        falhas.push(`"${nome}": ${(err as Error).message}`);
        continue;
      }
      // Confirma que o link saiu mesmo — não basta a chamada não ter lançado.
      let aindaExiste = true;
      try {
        lstatSync(caminho);
      } catch {
        aindaExiste = false;
      }
      if (aindaExiste) falhas.push(`"${nome}": link continua no disco após a remoção`);
    }

    if (falhas.length === 0) return null;
    return `links não puderam ser desfeitos (git worktree remove seguiria o alvo): ${falhas.join('; ')}`;
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
      // console.error de propósito: persiste em ~/.agents-hub/logs/, não é debug solto
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
      // console.error de propósito: persiste em ~/.agents-hub/logs/, não é debug solto
      console.error(`[worktree] ${aviso}`);
      return { ref: 'HEAD', warning: aviso };
    }
  }
}

/** Nomes de dispositivo que o Windows recusa como nome de pasta (com ou sem extensão). */
const RESERVADOS_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Nome da pasta do projeto dentro de `worktrees/` (vistoria 07, R07-24).
 *
 * Era `name.replace(/[^\w.-]+/g, '-')`, e `\w` sem a flag `u` é só ASCII:
 * "proj com espaço" virava `proj-com-espa-o`. Agora os acentos são
 * TRANSLITERADOS (NFD e tira as marcas: "ç" -> "c", "ã" -> "a") em vez de
 * virar hífen; o que sobra fora de `[A-Za-z0-9_.-]` ainda vira hífen. ASCII
 * de propósito: o caminho vai para o git, para shells e para os CLIs dos
 * agentes, e nem todos lidam bem com Unicode no Windows (página de código do
 * console). Limites de caminho do Windows mantidos: no máximo 60 caracteres,
 * sem ponto/hífen nas pontas (o Windows descarta ponto final; `..` nunca
 * pode sair daqui) e sem nome de dispositivo reservado (`CON`, `NUL`...).
 */
export function nomeDaPastaDoProjeto(name: string): string {
  const limpo = name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 60)
    .replace(/^[.-]+|[.-]+$/g, '');
  if (limpo === '') return 'projeto';
  return RESERVADOS_WINDOWS.test(limpo) ? `${limpo}-projeto` : limpo;
}
