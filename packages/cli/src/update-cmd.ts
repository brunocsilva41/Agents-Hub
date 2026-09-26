import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { flagOn, imprimirJson, type Args } from './cmd-util.js';
import { cliVersion } from './version-cmd.js';
import { bold, dim, green, yellow } from './render.js';

const execFileAsync = promisify(execFile);

export interface UpdateDeps {
  /** Pasta do pacote da CLI (padrão: a deste arquivo). Teste aponta para um repo temporário. */
  packageDir?: string;
}

export interface UpdateReport {
  version: string;
  /** `git` = rodando de um clone; `desconhecido` = sem canal de atualização detectável. */
  method: 'git' | 'desconhecido';
  repo: string | null;
  branch: string | null;
  commit: string | null;
  upstream: string | null;
  /** Arquivos rastreados modificados no clone (atrapalham o `pull`). */
  dirty: number;
  /** Só com `--check`: commits no remoto que você ainda não tem. */
  behind: number | null;
  ahead: number | null;
  steps: string[];
}

function acharRepo(inicio: string): string | null {
  let dir = path.resolve(inicio);
  for (;;) {
    // `.git` é pasta num clone e arquivo num worktree.
    if (existsSync(path.join(dir, '.git'))) return dir;
    const pai = path.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

async function git(repo: string, argv: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, ...argv], { windowsHide: true, timeout: 60_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * `hub update [--check] [--json]` — como atualizar, dito com honestidade.
 *
 * Hoje NÃO existe canal de atualização publicado: os pacotes são `private`,
 * sem registro npm nem instalador. O Hub roda de um clone git, então
 * "atualizar" é `git pull` + build + reiniciar o daemon (que sobrevive ao
 * terminal e continuaria no código antigo). Este comando diz de onde você está
 * rodando, se o clone tem mudança local que atrapalha o pull e, com
 * `--check`, quantos commits o remoto tem à frente (`git fetch`, sem mexer
 * no seu branch). Não executa a atualização: `pull` num clone com trabalho seu
 * é decisão sua.
 */
export async function updateCommand(args: Args, deps: UpdateDeps = {}): Promise<UpdateReport> {
  const packageDir = deps.packageDir ?? fileURLToPath(new URL('..', import.meta.url));
  const repo = acharRepo(packageDir);
  const report: UpdateReport = {
    version: cliVersion(),
    method: repo ? 'git' : 'desconhecido',
    repo,
    branch: null,
    commit: null,
    upstream: null,
    dirty: 0,
    behind: null,
    ahead: null,
    steps: [],
  };

  if (repo) {
    report.branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    report.commit = await git(repo, ['rev-parse', '--short', 'HEAD']);
    report.upstream = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const status = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
    report.dirty = status ? status.split(/\r?\n/).filter((l) => l.trim().length > 0).length : 0;

    if (flagOn(args, 'check') && report.upstream) {
      await git(repo, ['fetch', '--quiet']);
      const contagem = await git(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
      const m = contagem ? /^(\d+)\s+(\d+)$/.exec(contagem) : null;
      if (m) {
        report.ahead = Number(m[1]);
        report.behind = Number(m[2]);
      }
    }

    report.steps = [
      `git -C "${repo}" pull --ff-only`,
      `npm --prefix "${repo}" ci`,
      `npm --prefix "${repo}" run build`,
      'hub restart',
    ];
  } else {
    report.steps = [
      'baixe a versão nova do Agents-Hub (clone ou pacote) no mesmo lugar',
      'npm ci && npm run build',
      'hub restart',
    ];
  }

  if (flagOn(args, 'json')) {
    imprimirJson(report);
    return report;
  }

  console.log(`hub ${report.version}`);
  console.log(
    yellow('não há canal de atualização publicado') +
      dim(' (pacotes privados, sem registro npm nem instalador) — atualizar é manual.'),
  );
  if (repo) {
    console.log(`${dim('instalado a partir do clone git:')} ${bold(repo)}`);
    console.log(
      dim(
        `branch ${report.branch ?? '?'} · commit ${report.commit ?? '?'}` +
          (report.upstream ? ` · segue ${report.upstream}` : ' · sem upstream configurado'),
      ),
    );
    if (report.behind !== null) {
      console.log(
        report.behind === 0
          ? green('já está no último commit do remoto.')
          : yellow(`${report.behind} commit(s) novo(s) no remoto.`),
      );
    } else if (report.upstream) {
      console.log(dim('para consultar o remoto (faz `git fetch`, não mexe no seu branch):'), bold('hub update --check'));
    }
    if (report.dirty > 0) {
      console.log(yellow(`o clone tem ${report.dirty} arquivo(s) modificado(s): o pull pode recusar — commite ou guarde antes.`));
    }
  } else {
    console.log(dim('não achei um clone git acima de'), bold(packageDir));
  }
  console.log(`${'\n'}${dim('para atualizar:')}`);
  for (const passo of report.steps) console.log(`  ${passo}`);
  console.log(dim('o `hub restart` importa: o daemon sobrevive ao terminal e seguiria no código antigo.'));
  return report;
}
