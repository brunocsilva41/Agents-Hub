import { execFile } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Identidade e opções dos commits que o PRÓPRIO Hub faz no branch
 * `hub/<sessionId>` do worktree.
 *
 * Identidade fixa: o repositório do usuário pode não ter `user.name` (commit
 * falharia) ou ter a identidade pessoal dele (o commit mentiria sobre a
 * autoria — quem escreveu foi o agente). `commit.gpgsign=false` e
 * `--no-verify`: é um instantâneo no branch de trabalho do Hub, não um commit
 * de entrega — assinar pediria senha/pinentry sem ninguém no terminal, e hook
 * de pre-commit (lint, testes) rodaria sem controle dentro do worktree do
 * agente. O portão do Hub para isso é `validation.command`.
 */
const IDENTIDADE = [
  '-c',
  'user.name=Agents-Hub',
  '-c',
  'user.email=agents-hub@localhost',
  '-c',
  'commit.gpgsign=false',
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
}

/**
 * Links de primeiro nível do worktree (as dependências que `WorktreeManager`
 * liga por junction/symlink: `node_modules`, `.venv`, `vendor`).
 *
 * Ficam FORA do commit: `git add -A` num junction do Windows pode atravessar o
 * link e versionar o `node_modules` inteiro do projeto no branch do agente.
 * `lstat`, nunca `stat`: o que interessa é o link, não o alvo.
 */
function linksDePrimeiroNivel(worktreePath: string): string[] {
  let entradas: string[];
  try {
    entradas = readdirSync(worktreePath);
  } catch {
    return [];
  }
  return entradas.filter((nome) => {
    try {
      return lstatSync(path.join(worktreePath, nome)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

/**
 * Commita tudo o que o agente deixou no worktree, no branch dele.
 *
 * É o que faz o passo seguinte de um workflow receber o CÓDIGO do anterior, e
 * não só o resumo: o worktree do dependente nasce deste commit
 * (`hub/<sessionId>`). Antes nada era commitado e o branch ficava no
 * commit-base — o agente de testes escrevia testes para uma refatoração que
 * não existia no checkout dele.
 *
 * Devolve o sha do commit, ou `null` quando não havia nada para commitar.
 */
export async function commitarTrabalho(
  worktreePath: string,
  mensagem: string,
): Promise<string | null> {
  const excluidos = linksDePrimeiroNivel(worktreePath).map((nome) => `:(exclude)${nome}`);
  await git(worktreePath, ['add', '-A', '--', '.', ...excluidos]);

  // `diff --cached --quiet` sai 1 quando HÁ algo no índice.
  try {
    await git(worktreePath, ['diff', '--cached', '--quiet']);
    return null;
  } catch {
    /* há mudanças: segue para o commit */
  }

  await git(worktreePath, [...IDENTIDADE, 'commit', '--no-verify', '-q', '-m', mensagem]);
  return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
}

/**
 * Junta no worktree recém-criado o trabalho de outras sessões (fan-in de um
 * workflow: o passo depende de dois ou mais anteriores).
 *
 * Conflito é falha EXPLÍCITA: o merge é abortado e o erro diz qual branch não
 * entrou. Resolver conflito por conta própria (ou escolher um lado) entregaria
 * ao agente um checkout que não é o que nenhum dos passos anteriores fez.
 */
export async function juntarBranches(worktreePath: string, refs: string[]): Promise<void> {
  for (const ref of refs) {
    try {
      await git(worktreePath, [...IDENTIDADE, 'merge', '--no-edit', '--no-verify', '-q', ref]);
    } catch (err) {
      try {
        await git(worktreePath, ['merge', '--abort']);
      } catch {
        /* nada a abortar: o merge nem começou */
      }
      throw new Error(`conflito ao juntar ${ref}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
}

/** O branch existe no repositório do projeto? */
export async function branchExiste(projectPath: string, ref: string): Promise<boolean> {
  try {
    await git(projectPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
