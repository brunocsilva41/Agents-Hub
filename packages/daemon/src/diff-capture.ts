import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Captura do que o agente realmente mudou.
 *
 * O worktree é recolhido depois do prazo de retenção e o branch `hub/<sessionId>`
 * sobrevive — mas ler um branch exige saber que ele existe e conhecer git. O
 * diff capturado no fim da sessão responde de imediato a pergunta que sempre
 * vem primeiro: *o que esse agente fez no meu código?*
 *
 * Também é o insumo do portão de revisão: revisar sem o diff seria pedir opinião
 * sobre um trabalho que o revisor não viu.
 */

export interface DiffCapture {
  /** Patch unificado das mudanças em arquivos rastreados. */
  patch: string;
  /** Arquivos novos que o git ainda não conhece — não aparecem no patch. */
  untracked: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** `true` quando o agente não mexeu em nada. */
  empty: boolean;
}

export async function captureDiff(worktreePath: string): Promise<DiffCapture | null> {
  try {
    // `diff HEAD` pega staged e unstaged de uma vez, sem alterar o índice —
    // rodar `git add` aqui mudaria o estado do trabalho que estamos observando.
    const { stdout: patch } = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd: worktreePath,
      maxBuffer: 32 * 1024 * 1024,
    });

    const { stdout: numstat } = await execFileAsync('git', ['diff', '--numstat', 'HEAD'], {
      cwd: worktreePath,
      maxBuffer: 8 * 1024 * 1024,
    });

    const { stdout: untrackedRaw } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
    );

    const untracked = untrackedRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const { filesChanged, insertions, deletions } = somarNumstat(numstat);

    return {
      patch,
      untracked,
      filesChanged,
      insertions,
      deletions,
      empty: patch.trim().length === 0 && untracked.length === 0,
    };
  } catch {
    // Worktree já recolhido, diretório sem git, sessão com `isolation: none`
    // num projeto que não é repo: nenhum desses casos é erro do fluxo.
    return null;
  }
}

/** Grava o patch e devolve o caminho, ou `null` quando não havia o que gravar. */
export async function persistDiff(
  artifactRoot: string,
  sessionId: string,
  capture: DiffCapture,
): Promise<string | null> {
  if (capture.empty) return null;

  const dir = path.join(artifactRoot, sessionId);
  await mkdir(dir, { recursive: true });

  const file = path.join(dir, 'changes.patch');
  const cabecalho = [
    `# Sessão: ${sessionId}`,
    `# Arquivos alterados: ${capture.filesChanged} (+${capture.insertions} −${capture.deletions})`,
    capture.untracked.length > 0
      ? `# Arquivos novos, fora do patch: ${capture.untracked.join(', ')}`
      : '',
    '',
  ]
    .filter((l) => l.length > 0)
    .join('\n');

  await writeFile(file, `${cabecalho}\n${capture.patch}`, 'utf8');
  return file;
}

function somarNumstat(numstat: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const linha of numstat.split(/\r?\n/)) {
    const partes = linha.split('\t');
    if (partes.length < 3) continue;
    filesChanged += 1;
    // Binário vem como `-`; contá-lo como zero é mais honesto que ignorar o
    // arquivo, que sumiria da contagem de arquivos alterados.
    insertions += Number(partes[0]) || 0;
    deletions += Number(partes[1]) || 0;
  }

  return { filesChanged, insertions, deletions };
}
