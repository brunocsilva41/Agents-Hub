import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** O git entende `/dev/null` como "vazio" também no Windows. */
const NULO = '/dev/null';

/** Quebra de linha (CR opcional), sem escapes que o shell possa comer. */
const QUEBRA_DE_LINHA = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));

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
  /** Arquivos que o git ainda não rastreia; o conteúdo deles entra no patch. */
  untracked: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** `true` quando o agente não mexeu em nada. */
  empty: boolean;
}

/** Teto de arquivos novos incluídos por inteiro: um `npm install` acidental traria milhares. */
const MAX_ARQUIVOS_NOVOS = 50;
const MAX_BYTES_POR_ARQUIVO = 200_000;

/**
 * Patch de um arquivo que o git ainda não conhece.
 *
 * `diff --no-index` contra o vazio produz um patch normal sem tocar no índice —
 * `git add -N` resolveria também, mas alteraria o estado do trabalho que
 * estamos justamente tentando observar sem perturbar.
 */
async function patchDeArquivoNovo(worktreePath: string, arquivo: string): Promise<string> {
  try {
    const { size } = await stat(path.join(worktreePath, arquivo));
    if (size > MAX_BYTES_POR_ARQUIVO) {
      return `
# (arquivo novo omitido por tamanho: ${arquivo}, ${size} bytes)
`;
    }
  } catch {
    return '';
  }

  try {
    await execFileAsync('git', ['diff', '--no-index', '--', NULO, arquivo], {
      cwd: worktreePath,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Sem diferença: arquivo vazio.
    return '';
  } catch (err) {
    // `diff --no-index` sai com código 1 QUANDO HÁ diferença — que é o caso
    // normal aqui. Tratar isso como erro descartaria justamente o patch.
    const saida = (err as { stdout?: string }).stdout;
    return typeof saida === 'string' ? saida : '';
  }
}

function contarLinhasAdicionadas(patches: string[]): number {
  return patches.reduce(
    (total, patch) =>
      total + patch.split(QUEBRA_DE_LINHA).filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    0,
  );
}

export async function captureDiff(worktreePath: string): Promise<DiffCapture | null> {
  try {
    // Worktree recém-criado sem commits ainda: `git diff HEAD` sai com código
    // 128 porque HEAD não existe. Verificar antes evita lançar exceção em caso
    // perfeitamente normal no ciclo de vida de um worktree novo.
    try {
      await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: worktreePath,
      });
    } catch {
      // HEAD não existe — worktree sem commits. Não há nada para diferenciar.
      return { empty: true, filesChanged: 0, insertions: 0, deletions: 0, patch: '', untracked: [] };
    }

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

    // Arquivo NOVO não aparece em `git diff HEAD` — e criar arquivo é a ação
    // mais comum de um agente. Sem isto, o diff de uma sessão que criou três
    // arquivos mostrava só os três nomes, o que não serve nem para revisar nem
    // para alimentar a revisão cruzada.
    const patchesDeNovos = await Promise.all(
      untracked.slice(0, MAX_ARQUIVOS_NOVOS).map((arquivo) => patchDeArquivoNovo(worktreePath, arquivo)),
    );
    const patchCompleto = [patch, ...patchesDeNovos.filter((p) => p.length > 0)].join('');

    const contagem = somarNumstat(numstat);
    const filesChanged = contagem.filesChanged + untracked.length;
    const insertions = contagem.insertions + contarLinhasAdicionadas(patchesDeNovos);
    const { deletions } = contagem;

    return {
      patch: patchCompleto,
      untracked,
      filesChanged,
      insertions,
      deletions,
      empty: patchCompleto.trim().length === 0 && untracked.length === 0,
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
      ? `# Arquivos novos: ${capture.untracked.join(', ')}`
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
