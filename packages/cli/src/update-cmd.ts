import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  /**
   * `git` = rodando de um clone; `pacote` = instalado pelo tarball
   * (`npm i -g agents-hub-<versão>.tgz`); `desconhecido` = sem canal detectável.
   */
  method: 'git' | 'pacote' | 'desconhecido';
  repo: string | null;
  /** Instalado pelo tarball: a pasta `agents-hub` e o prefixo do `npm i -g`. */
  installRoot: string | null;
  npmPrefix: string | null;
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

/**
 * Instalação pelo tarball: a CLI mora em
 * `<prefixo>/[lib/]node_modules/agents-hub/node_modules/@agents-hub/cli`, e a
 * raiz tem o `package.json` do pacote `agents-hub` (`scripts/pack-dist.mjs`).
 */
function acharInstalacao(packageDir: string): { root: string; prefix: string } | null {
  const cli = path.resolve(packageDir);
  const escopo = path.dirname(cli);
  const nm = path.dirname(escopo);
  if (path.basename(escopo) !== '@agents-hub' || path.basename(nm) !== 'node_modules') return null;
  const root = path.dirname(nm);
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: unknown };
    if (pkg.name !== 'agents-hub') return null;
  } catch {
    return null;
  }
  // `npm i -g --prefix P`: Windows instala em `P/node_modules`, POSIX em `P/lib/node_modules`.
  const nmGlobal = path.dirname(root);
  const acima = path.dirname(nmGlobal);
  const prefix = path.basename(acima) === 'lib' && process.platform !== 'win32' ? path.dirname(acima) : acima;
  return { root, prefix };
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
 * sem registro npm nem instalador. Rodando de um clone git,
 * "atualizar" é `git pull` + build + reiniciar o daemon (que sobrevive ao
 * terminal e continuaria no código antigo); instalado pelo tarball, é
 * reempacotar no clone e `npm i -g` no mesmo prefixo. Este comando diz de onde você está
 * rodando, se o clone tem mudança local que atrapalha o pull e, com
 * `--check`, quantos commits o remoto tem à frente (`git fetch`, sem mexer
 * no seu branch). Não executa a atualização: `pull` num clone com trabalho seu
 * é decisão sua.
 */
export async function updateCommand(args: Args, deps: UpdateDeps = {}): Promise<UpdateReport> {
  const packageDir = deps.packageDir ?? fileURLToPath(new URL('..', import.meta.url));
  // Tarball antes de git: um prefixo de instalação dentro de um clone qualquer
  // não faz do Hub instalado um clone.
  const instalacao = acharInstalacao(packageDir);
  const repo = instalacao ? null : acharRepo(packageDir);
  const report: UpdateReport = {
    version: cliVersion(),
    method: instalacao ? 'pacote' : repo ? 'git' : 'desconhecido',
    repo,
    installRoot: instalacao?.root ?? null,
    npmPrefix: instalacao?.prefix ?? null,
    branch: null,
    commit: null,
    upstream: null,
    dirty: 0,
    behind: null,
    ahead: null,
    steps: [],
  };

  if (instalacao) {
    report.steps = [
      'no seu clone do Agents-Hub: git pull --ff-only && npm ci && npm run build && npm run pack:dist',
      `npm i -g "<clone>/dist-pack/agents-hub-<versão>.tgz" --prefix "${instalacao.prefix}"`,
      'hub restart',
    ];
  } else if (repo) {
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
  if (instalacao) {
    console.log(`${dim('instalado pelo pacote (tarball) em:')} ${bold(instalacao.root)}`);
    console.log(
      dim('o `npm i -g` da versão nova substitui no mesmo lugar: hooks e MCP gravados nos agentes continuam valendo.'),
    );
  } else if (repo) {
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
