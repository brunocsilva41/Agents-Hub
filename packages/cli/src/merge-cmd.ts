import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HubClient } from './client.js';
import { flagOn, flagString, required, type Args } from './cmd-util.js';
import { bold, dim, green, red, yellow } from './render.js';

const execFileAsync = promisify(execFile);

export type MergeStrategy = 'merge' | 'cherry-pick' | 'squash';
const ESTRATEGIAS: MergeStrategy[] = ['merge', 'cherry-pick', 'squash'];

interface Git {
  ok(argv: string[]): Promise<string>;
  tentar(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

function gitEm(repo: string): Git {
  const rodar = async (argv: string[]) => {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...argv], {
        cwd: repo,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
    }
  };
  return {
    tentar: rodar,
    async ok(argv) {
      const r = await rodar(argv);
      if (!r.ok) throw new Error(`git ${argv.join(' ')} falhou: ${r.stderr.trim()}`);
      return r.stdout;
    },
  };
}

function linhas(texto: string): string[] {
  return texto.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export interface MergePlan {
  sessionId: string;
  repo: string;
  branch: string;
  currentBranch: string;
  strategy: MergeStrategy;
  /** Commits do branch da sessão que o branch atual ainda não tem (`git log --oneline`). */
  commits: string[];
  diffstat: string;
  /**
   * Trabalho NÃO commitado do agente, do diff capturado no fim da sessão. O
   * Hub não commita pelo agente: sem isto, `hub merge` de uma sessão que só
   * editou arquivos diria "nada a aplicar".
   */
  patch: string | null;
  /** O que impede aplicar — com qualquer item aqui, nada é executado. */
  blockers: string[];
  warnings: string[];
}

/**
 * Monta o plano sem mudar nada no repositório.
 */
export async function planejarMerge(
  client: HubClient,
  sessionId: string,
  strategy: MergeStrategy,
): Promise<MergePlan> {
  const { session, live } = await client.session(sessionId);
  const { projects } = await client.projects();
  const projeto = projects.find((p) => p.id === session.projectId);
  if (!projeto) throw new Error(`projeto ${session.projectId} da sessão não está registrado`);

  const repo = projeto.path;
  const git = gitEm(repo);
  const branch = `hub/${session.id}`;
  const plano: MergePlan = {
    sessionId: session.id,
    repo,
    branch,
    currentBranch: '',
    strategy,
    commits: [],
    diffstat: '',
    patch: null,
    blockers: [],
    warnings: [],
  };

  if (live) {
    plano.blockers.push('a sessão ainda está viva — espere terminar (ou hub cancel) antes de aplicar');
  }
  if (session.isolation === 'none') {
    plano.blockers.push(
      'a sessão rodou sem isolamento (isolation none): o trabalho já está no diretório do projeto, não há branch a aplicar',
    );
    return plano;
  }

  const atual = await git.tentar(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!atual.ok) {
    plano.blockers.push(`${repo} não é um repositório git utilizável: ${atual.stderr.trim()}`);
    return plano;
  }
  plano.currentBranch = atual.stdout.trim();
  if (plano.currentBranch === branch) {
    plano.blockers.push(
      `o projeto está com ${branch} em checkout — troque para o branch de destino antes`,
    );
  }
  if (plano.currentBranch === 'HEAD') {
    plano.warnings.push('HEAD destacado (detached): o resultado não fica em branch nenhum');
  }

  // Árvore limpa: arquivo rastreado modificado se misturaria com o trabalho
  // do agente e um conflito deixaria as duas coisas emaranhadas.
  const sujos = linhas(await git.ok(['status', '--porcelain', '--untracked-files=no']));
  if (sujos.length > 0) {
    plano.blockers.push(
      `a árvore de ${repo} tem ${sujos.length} arquivo(s) modificado(s) — commite ou guarde antes (nada é forçado)`,
    );
  }
  for (const marcador of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD']) {
    if ((await git.tentar(['rev-parse', '-q', '--verify', marcador])).ok) {
      plano.blockers.push(
        `há um ${marcador} pendente no repositório — termine ou aborte essa operação antes`,
      );
    }
  }

  const existe = await git.tentar(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (existe.ok) {
    plano.commits = linhas(await git.ok(['log', '--oneline', '--no-decorate', `HEAD..${branch}`]));
    if (plano.commits.length > 0) {
      plano.diffstat = (await git.ok(['diff', '--stat', `HEAD...${branch}`])).trimEnd();
    }
  } else {
    plano.warnings.push(`o branch ${branch} não existe neste repositório`);
  }

  const { diff } = await client.diff(session.id).catch(() => ({ diff: null }));
  if (diff && diff.trim().length > 0) plano.patch = diff;

  if (plano.commits.length === 0 && plano.patch === null && plano.blockers.length === 0) {
    plano.blockers.push(
      'nada a aplicar: o branch não tem commits novos e a sessão não deixou alterações capturadas',
    );
  }
  return plano;
}

async function conflitos(git: Git): Promise<string[]> {
  const r = await git.tentar(['diff', '--name-only', '--diff-filter=U']);
  return linhas(r.stdout);
}

/**
 * Executa o plano. Em conflito, desfaz a operação (`--abort`) e lança
 * listando os arquivos — nunca deixa o repositório no meio do caminho,
 * nunca usa `--force`, nunca faz push.
 */
export async function aplicarMerge(plano: MergePlan): Promise<{ applied: string[] }> {
  const git = gitEm(plano.repo);
  const feito: string[] = [];

  if (plano.commits.length > 0) {
    if (plano.strategy === 'merge') {
      const r = await git.tentar([
        'merge',
        '--no-ff',
        '-m',
        `Merge do trabalho da sessão ${plano.sessionId} (${plano.branch})`,
        plano.branch,
      ]);
      if (!r.ok) {
        const arquivos = await conflitos(git);
        await git.tentar(['merge', '--abort']);
        throw new Error(`merge com conflito (desfeito): ${arquivos.join(', ') || r.stderr.trim()}`);
      }
      feito.push(`merge de ${plano.commits.length} commit(s) de ${plano.branch}`);
    } else if (plano.strategy === 'cherry-pick') {
      const r = await git.tentar(['cherry-pick', `HEAD..${plano.branch}`]);
      if (!r.ok) {
        const arquivos = await conflitos(git);
        await git.tentar(['cherry-pick', '--abort']);
        throw new Error(
          `cherry-pick com conflito (desfeito): ${arquivos.join(', ') || r.stderr.trim()}`,
        );
      }
      feito.push(`cherry-pick de ${plano.commits.length} commit(s) de ${plano.branch}`);
    } else {
      const r = await git.tentar(['merge', '--squash', plano.branch]);
      if (!r.ok) {
        const arquivos = await conflitos(git);
        // `--squash` não deixa MERGE_HEAD: `merge --abort` não serve. A árvore
        // estava limpa (bloqueio acima), então `reset --merge` volta a ela.
        await git.tentar(['reset', '--merge']);
        throw new Error(`squash com conflito (desfeito): ${arquivos.join(', ') || r.stderr.trim()}`);
      }
      feito.push(
        `squash de ${plano.commits.length} commit(s) de ${plano.branch} (preparado no índice, sem commit)`,
      );
    }
  }

  if (plano.patch !== null) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-apply-'));
    const arquivo = path.join(dir, 'sessao.patch');
    try {
      writeFileSync(arquivo, plano.patch.endsWith('\n') ? plano.patch : `${plano.patch}\n`, 'utf8');
      const check = await git.tentar(['apply', '--check', arquivo]);
      if (!check.ok) {
        throw new Error(
          `as alterações não commitadas da sessão não se aplicam sobre o branch atual: ${check.stderr.trim()}` +
            (feito.length > 0 ? ` (o que já foi feito fica: ${feito.join('; ')})` : ''),
        );
      }
      await git.ok(['apply', arquivo]);
      feito.push('alterações não commitadas do agente aplicadas à árvore (sem commit)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { applied: feito };
}

function imprimirPlano(plano: MergePlan): void {
  console.log(`${bold(plano.branch)} → ${bold(plano.currentBranch || '?')} ${dim(`em ${plano.repo}`)}`);
  console.log(dim(`estratégia: ${plano.strategy}`));
  if (plano.commits.length > 0) {
    console.log(`\n${plano.commits.length} commit(s):`);
    for (const c of plano.commits) console.log(`  ${c}`);
    if (plano.diffstat) console.log(dim(plano.diffstat));
  } else {
    console.log(dim('\nnenhum commit novo no branch da sessão.'));
  }
  if (plano.patch !== null) {
    const arquivos = plano.patch.split(/\r?\n/).filter((l) => l.startsWith('diff --git')).length;
    console.log(
      `\nalterações não commitadas do agente: ${arquivos} arquivo(s) ${dim('(do diff capturado — hub diff)')}`,
    );
  }
  for (const w of plano.warnings) console.log(yellow(`⚠ ${w}`));
  for (const b of plano.blockers) console.log(red(`✗ ${b}`));
}

/**
 * `hub merge <sessionId>` / `hub apply <sessionId>` — traz o trabalho da
 * sessão para o branch atual do projeto.
 *
 * - `merge` (padrão `--strategy merge`): `git merge --no-ff hub/<id>`;
 * - `apply` (padrão `--strategy squash`): `git merge --squash` — fica
 *   preparado no índice para você commitar do seu jeito;
 * - `--strategy cherry-pick`: os commits um a um.
 * Em qualquer caso, alterações que o agente deixou SEM commit (o diff
 * capturado) entram com `git apply`, sem commit.
 *
 * Sem `--write` é só a prévia (o mesmo que `--dry-run`). Exige árvore limpa;
 * nunca força, nunca faz push.
 */
export async function mergeCommand(client: HubClient, args: Args): Promise<MergePlan> {
  const sessionId = required(args.positional[0], 'sessionId');
  const padrao: MergeStrategy = args.command === 'apply' ? 'squash' : 'merge';
  const pedida = flagString(args, 'strategy') ?? padrao;
  if (!ESTRATEGIAS.includes(pedida as MergeStrategy)) {
    throw new Error(`--strategy inválida: "${pedida}" (use ${ESTRATEGIAS.join(', ')})`);
  }
  const plano = await planejarMerge(client, sessionId, pedida as MergeStrategy);
  imprimirPlano(plano);

  if (plano.blockers.length > 0) {
    process.exitCode = 1;
    return plano;
  }
  const executar = flagOn(args, 'write') && !flagOn(args, 'dry-run');
  if (!executar) {
    console.log(
      `\n${dim('prévia — nada foi alterado. para aplicar:')} ${bold(`hub ${args.command} ${sessionId} --write`)}`,
    );
    return plano;
  }

  const { applied } = await aplicarMerge(plano);
  for (const a of applied) console.log(`${green('✓')} ${a}`);
  console.log(dim('\nnada foi enviado ao remoto. revise com git log / git diff antes de publicar.'));
  return plano;
}
