import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

/**
 * Impressão do que já estava sujo antes do agente começar.
 *
 * Sem isto, `isolation: none` credita ao agente tudo que estivesse pendente na
 * árvore de trabalho. Medido numa sessão real em modo somente-leitura: o Hub
 * anunciou "2 arquivo(s), +510 −0" para um agente que não tocou em nada — as
 * duas mudanças eram de horas antes, de outra pessoa.
 *
 * A mentira não fica só na timeline. Esse mesmo diff alimenta o portão de
 * revisão cruzada, então o revisor analisaria trabalho alheio como se fosse do
 * agente, e o veredito dele valeria para a tarefa errada.
 *
 * O worktree isolado não sofre disso porque nasce limpo — mas depender do modo
 * de isolamento para a atribuição estar certa é frágil, então a linha de base é
 * tirada sempre.
 */
export interface DiffBaseline {
  /** Caminho relativo -> hash do conteúdo, para tudo que já estava alterado. */
  sujos: Record<string, string>;
}

/**
 * Fotografa a árvore de trabalho antes de o agente começar.
 *
 * Usa `git status --porcelain` para achar o que está sujo e `git hash-object`
 * para o conteúdo. O hash importa: um arquivo que já estava modificado e que o
 * agente modificou DE NOVO precisa aparecer no diff final, e só o conteúdo
 * distingue esses dois casos.
 */
export async function captureBaseline(worktreePath: string): Promise<DiffBaseline> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      maxBuffer: 8 * 1024 * 1024,
    });

    const arquivos = stdout
      .split(QUEBRA_DE_LINHA)
      .map((l) => l.slice(3).trim())
      .filter((l) => l.length > 0)
      // Renomeação vem como "antigo -> novo"; o que interessa é o destino.
      .map((l) => (l.includes(' -> ') ? (l.split(' -> ')[1] ?? l) : l))
      .map((l) => l.replace(/^"|"$/g, ''));

    const sujos: Record<string, string> = {};
    await Promise.all(
      arquivos.slice(0, MAX_ARQUIVOS_BASELINE).map(async (arquivo) => {
        const hash = await hashDoArquivo(worktreePath, arquivo);
        if (hash !== null) sujos[arquivo] = hash;
      }),
    );

    return { sujos };
  } catch {
    // Sem git, ou diretório inexistente: sem linha de base. O comportamento
    // volta a ser o antigo, que é impreciso mas não quebra a sessão.
    return { sujos: {} };
  }
}

/** Teto para não travar a criação da sessão num repo com milhares de pendências. */
const MAX_ARQUIVOS_BASELINE = 500;

async function hashDoArquivo(worktreePath: string, arquivo: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['hash-object', '--', arquivo], {
      cwd: worktreePath,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    // Arquivo apagado entre o `status` e o `hash-object`, ou ilegível.
    return null;
  }
}

/** O arquivo mudou em relação à linha de base? */
async function mudouDesdeBaseline(
  worktreePath: string,
  arquivo: string,
  baseline: DiffBaseline,
): Promise<boolean> {
  const anterior = baseline.sujos[arquivo];
  if (anterior === undefined) return true; // não estava sujo antes: é do agente
  const agora = await hashDoArquivo(worktreePath, arquivo);
  return agora !== anterior;
}

/**
 * Guarda a linha de base junto dos artefatos da sessão.
 *
 * Em memória ela se perderia num reinício do daemon, e a atribuição errada
 * voltaria em silêncio — o pior desfecho possível para uma correção de
 * atribuição. Em disco custa um arquivo pequeno e sobrevive.
 */
export async function saveBaseline(
  artifactRoot: string,
  sessionId: string,
  baseline: DiffBaseline,
): Promise<void> {
  try {
    const dir = path.join(artifactRoot, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'baseline.json'), JSON.stringify(baseline), 'utf8');
  } catch {
    // Falhar aqui não pode impedir a sessão de começar. O custo é voltar à
    // atribuição imprecisa, não perder o trabalho.
  }
}

/** Lê a linha de base; `undefined` quando não há (sessão anterior à correção). */
export async function loadBaseline(
  artifactRoot: string,
  sessionId: string,
): Promise<DiffBaseline | undefined> {
  try {
    const bruto = await readFile(path.join(artifactRoot, sessionId, 'baseline.json'), 'utf8');
    const lido = JSON.parse(bruto) as DiffBaseline;
    return lido.sujos !== undefined && typeof lido.sujos === 'object' ? lido : undefined;
  } catch {
    return undefined;
  }
}

export async function captureDiff(
  worktreePath: string,
  baseline?: DiffBaseline,
): Promise<DiffCapture | null> {
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

    // Quais arquivos rastreados mudaram DESDE A LINHA DE BASE.
    //
    // `diff HEAD` pega staged e unstaged de uma vez, sem alterar o índice —
    // rodar `git add` aqui mudaria o estado do trabalho que estamos observando.
    // Mas ele pega TUDO que está pendente, e numa sessão com `isolation: none`
    // isso inclui o que já estava lá antes do agente começar.
    const { stdout: nomesCrus } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: worktreePath,
      maxBuffer: 8 * 1024 * 1024,
    });
    const rastreados = nomesCrus
      .split(QUEBRA_DE_LINHA)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const doAgente =
      baseline === undefined
        ? rastreados
        : (
            await Promise.all(
              rastreados.map(async (arquivo) => ({
                arquivo,
                mudou: await mudouDesdeBaseline(worktreePath, arquivo, baseline),
              })),
            )
          )
            .filter((r) => r.mudou)
            .map((r) => r.arquivo);

    // Sem `--`, um `git diff` com lista vazia de caminhos devolveria a árvore
    // inteira — exatamente o que estamos evitando. Por isso o caminho de "nada
    // mudou" é explícito.
    const semMudancaRastreada = baseline !== undefined && doAgente.length === 0;
    const escopo = doAgente.length > 0 ? ['--', ...doAgente] : [];

    const { stdout: patch } = semMudancaRastreada
      ? { stdout: '' }
      : await execFileAsync('git', ['diff', 'HEAD', ...escopo], {
          cwd: worktreePath,
          maxBuffer: 32 * 1024 * 1024,
        });

    const { stdout: numstat } = semMudancaRastreada
      ? { stdout: '' }
      : await execFileAsync('git', ['diff', '--numstat', 'HEAD', ...escopo], {
          cwd: worktreePath,
          maxBuffer: 8 * 1024 * 1024,
        });

    const { stdout: untrackedRaw } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
    );

    const untracked = untrackedRaw
      .split(QUEBRA_DE_LINHA)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      // Arquivo que já existia sem ser rastreado antes da sessão não é criação
      // do agente. Era assim que um documento escrito na véspera aparecia como
      // "arquivo novo" de um agente que rodou em somente-leitura.
      .filter((l) => baseline === undefined || baseline.sujos[l] === undefined);

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
