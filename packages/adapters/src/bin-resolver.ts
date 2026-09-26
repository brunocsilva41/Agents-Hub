import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const realExecFileAsync = promisify(execFile);

export interface ResolvedBin {
  /** Caminho achado no PATH — é o que se mostra ao usuário (probe, doctor). */
  path: string;
  /**
   * `true` só para um `.cmd`/`.bat` que NÃO deu para desembrulhar (ver
   * `resolverShimNpm`): esse precisa passar pelo `cmd.exe`, com o escape
   * próprio do `cmd` de `montarSpawn`. Shim do npm reconhecido vira
   * `node.exe script` ou o `.exe` real, sem shell nenhum.
   */
  needsShell: boolean;
  /**
   * Executável de fato spawnado, quando difere de `path` (shim npm
   * desembrulhado: `node.exe` ou o `.exe` que o shim chamaria).
   */
  file?: string;
  /** Argumentos que vão antes dos do manifesto (o script JS do shim). */
  prefixArgs?: string[];
}

/**
 * Dependências injetáveis de `resolveBin`/`lookup`, isoladas só para permitir
 * testar a lógica de preferência entre candidatos e o fallback sem depender
 * de `where`/`which` ou do disco reais. Em produção, `resolveBin` sempre usa
 * `defaultLookupDeps` — nenhum call site precisa (ou deve) passar `deps`.
 */
export interface LookupDeps {
  execFileAsync: (
    file: string,
    args: readonly string[],
    options: { windowsHide: boolean },
  ) => Promise<{ stdout: string; stderr: string }>;
  existsSync: (path: string) => boolean;
  /** Lê o conteúdo de um shim `.cmd`. Opcional: sem ele, usa o disco real. */
  readFileSync?: (path: string) => string;
}

export const defaultLookupDeps: LookupDeps = {
  execFileAsync: realExecFileAsync as LookupDeps['execFileAsync'],
  existsSync,
};

const cache = new Map<string, ResolvedBin | null>();

export async function resolveBin(
  bin: string,
  deps: LookupDeps = defaultLookupDeps,
): Promise<ResolvedBin | null> {
  const cached = cache.get(bin);
  if (cached !== undefined) return cached;

  const resolved = await lookup(bin, deps);
  cache.set(bin, resolved);
  return resolved;
}

export function clearBinCache(): void {
  cache.clear();
}

async function lookup(bin: string, deps: LookupDeps): Promise<ResolvedBin | null> {
  const isWindows = process.platform === 'win32';
  const finder = isWindows ? 'where' : 'which';

  try {
    const { stdout } = await deps.execFileAsync(finder, [bin], { windowsHide: true });
    const candidates = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (candidates.length === 0) return lookupFallback(bin, isWindows, deps);

    if (!isWindows) {
      return { path: candidates[0] as string, needsShell: false };
    }

    // `where codex` costuma devolver DUAS entradas: o script sh sem extensão
    // (instalado pelo npm para o Git Bash) e o shim .cmd. A primeira linha é a
    // sem extensão — e o Windows não sabe executá-la, dando ENOENT.
    const best =
      candidates.find((c) => /\.exe$/i.test(c)) ??
      candidates.find((c) => /\.(cmd|bat)$/i.test(c)) ??
      candidates[0] as string;

    return comShimDesembrulhado(best, deps);
  } catch {
    return lookupFallback(bin, isWindows, deps);
  }
}

function lookupFallback(
  bin: string,
  isWindows: boolean,
  deps: LookupDeps,
): ResolvedBin | null {
  if (!isWindows) return null;
  const fallbacks = [
    path.join(process.env['LOCALAPPDATA'] ?? '', 'agy', 'bin', `${bin}.exe`),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', bin, `${bin}.exe`),
    path.join(os.homedir(), '.local', 'bin', `${bin}.exe`),
    path.join(os.homedir(), '.kimi-code', 'bin', `${bin}.exe`),
    path.join(process.env['APPDATA'] ?? '', 'npm', `${bin}.cmd`),
  ];
  for (const fb of fallbacks) {
    if (deps.existsSync(fb)) {
      return comShimDesembrulhado(fb, deps);
    }
  }
  return null;
}

/**
 * Aspas para linha de comando do Windows. Usada para o CAMINHO do binário, para
 * flags simples e para valores compostos (como o `-c hooks={...}` do gate do
 * Codex, que embute caminhos com espaço dentro de aspas já escapadas) — o
 * prompt do usuário nunca passa por aqui: vai por stdin (`stdinPrompt`),
 * justamente para não depender de escaping.
 *
 * `shell: true` no Windows roda via `cmd.exe /d /s /c`, e quem monta a linha
 * de comando é o Node concatenando `file` + `args` com espaço — sem
 * re-escapar nada. Cabe a quem chama produzir, para cada argumento, a forma
 * que o parser de argv do processo filho (regra do `CommandLineToArgvW`, que
 * todo binário C/C++ e a maioria dos runtimes seguem) reconstrói de volta no
 * valor original.
 *
 * A troca ingênua de `"` por `\"` quebra sempre que uma barra invertida
 * antecede uma aspas — exatamente o caso do TOML já escapado do gate do
 * Codex (`\"C:\\Program Files\\...\"`), medido contra o binário real: a
 * barra "absorve" a aspas seguinte em vez de escapá-la, e o argumento parte
 * no primeiro espaço dali pra frente. A regra certa dobra as barras que
 * antecedem uma aspas (e só essas) antes de escapá-la.
 */
export function quoteForShell(value: string): string {
  if (process.platform !== 'win32') return value;
  if (!/[\s"]/.test(value)) return value;

  let result = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      result += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/**
 * Transforma o candidato escolhido em `ResolvedBin`, desembrulhando o shim
 * `.cmd` do npm quando ele é reconhecível.
 *
 * Por que desembrulhar (vistoria 2026-09-25, achados CRÍTICO/ALTO de
 * `10-adapters-manifestos.md`): um `.cmd` só roda via `cmd.exe`, e o `cmd.exe`
 * reinterpreta a linha de comando INTEIRA — `&`, `|`, `>` e `%VAR%` dentro do
 * prompt viravam comando executado com o usuário do daemon (injeção medida:
 * `a&echo>PWNED.txt` criava o arquivo), quebra de linha truncava o Brief na
 * primeira linha, 8191 caracteres era o teto duro e CJK/emoji viravam `?`.
 * Nada disso existe quando o Hub chama direto o que o shim chamaria
 * (`node.exe script.js ...` ou o `.exe` real): o argv vai por `CreateProcessW`,
 * em UTF-16, sem shell nenhum, até ~32 K caracteres.
 */
function comShimDesembrulhado(candidato: string, deps: LookupDeps): ResolvedBin {
  if (!/\.(cmd|bat)$/i.test(candidato)) return { path: candidato, needsShell: false };
  const alvo = resolverShimNpm(candidato, deps);
  if (alvo) return { path: candidato, needsShell: false, ...alvo };
  return { path: candidato, needsShell: true };
}

/**
 * Lê um shim `.cmd` gerado pelo npm (`cmd-shim`) e devolve o que ele de fato
 * executaria, ou `null` se o arquivo não tiver a forma conhecida — aí o
 * chamador cai no caminho com `cmd.exe` (e no escape de `escaparArgParaCmd`).
 *
 * Formas reconhecidas (todas medidas nesta máquina, em `%APPDATA%\npm`):
 * - `"%_prog%"  "%dp0%\node_modules\pacote\bin\x.js" %*`, com `_prog` sendo
 *   `%dp0%\node.exe` ou `node` (copilot, codex, mimo, openclaude);
 * - `"%dp0%\node_modules\pacote\bin\x.exe"   %*` (opencode);
 * - o formato antigo do cmd-shim, com `"%~dp0\..."` no lugar de `%dp0%`.
 *
 * Interpretador que não seja `node` (shebang `sh`, `python`...) não é
 * desembrulhado: não há como garantir a mesma semântica, e o fallback com
 * `cmd.exe` escapado continua seguro.
 */
export function resolverShimNpm(
  cmdPath: string,
  deps: LookupDeps = defaultLookupDeps,
): { file: string; prefixArgs: string[] } | null {
  const ler = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  let conteudo: string;
  try {
    conteudo = ler(cmdPath);
  } catch {
    return null;
  }

  const linha = conteudo.split(/\r?\n/).find((l) => l.includes('%*'));
  if (!linha) return null;

  // Todos os caminhos relativos ao diretório do shim que aparecem na linha que
  // repassa `%*`; o alvo é o último antes do `%*` (o primeiro pode ser o
  // `node.exe` local).
  const antesDoRepasse = linha.slice(0, linha.indexOf('%*'));
  const relativos = [...antesDoRepasse.matchAll(/"%~?dp0%?\\?([^"%]+)"/gi)].map(
    (m) => m[1] as string,
  );
  const relativo = relativos.at(-1);
  if (!relativo) return null;

  const dir = path.dirname(cmdPath);
  const alvo = path.join(dir, relativo);
  if (!deps.existsSync(alvo)) return null;

  if (/\.(exe|com)$/i.test(alvo)) {
    if (/(^|[\\/])node\.exe$/i.test(alvo)) return null;
    return { file: alvo, prefixArgs: [] };
  }

  // Script: só desembrulha se o interpretador do shim for o node.
  const usaProg = /%_prog%/i.test(antesDoRepasse);
  const progs = [...conteudo.matchAll(/SET\s+"_prog=([^"]+)"/gi)].map((m) => m[1] as string);
  const interpretadorEhNode = usaProg
    ? progs.length > 0 && progs.every((p) => /(^|[\\/%])node(\.exe)?$/i.test(p))
    : /(^|[\s"\\/])node(\.exe)?"?\s/i.test(antesDoRepasse);
  if (!interpretadorEhNode) return null;

  // Mesma preferência do shim: o `node.exe` ao lado dele, senão "o node".
  // Para "o node" usamos o do próprio daemon em vez de procurar no PATH: é
  // um executável garantidamente existente e da versão que o Hub suporta.
  const nodeLocal = path.join(dir, 'node.exe');
  const node = deps.existsSync(nodeLocal) ? nodeLocal : process.execPath;
  return { file: node, prefixArgs: [alvo] };
}

/** Teto da linha de comando do `cmd.exe` (`/c` inclusive). */
export const CMD_MAX_LINHA = 8191;

/**
 * Caracteres especiais para o parser do `cmd.exe` (mesmo conjunto que o
 * `cross-spawn` usa). Escapar TODOS com `^` — inclusive `"` — faz o `cmd`
 * nunca entrar em "modo aspas": não sobra nenhum `&`, `|`, `<`, `>` ou `%`
 * interpretável, esteja onde estiver.
 */
const META_CMD = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escapa UM argumento para atravessar `cmd.exe /d /s /c "..."` e, em seguida,
 * o `%*` de um `.bat`/`.cmd` que o repassa a outro programa.
 *
 * 1. Primeiro as aspas da regra do `CommandLineToArgvW` (a que o programa
 *    final usa para reconstruir o argv), igual a `quoteForShell`, mas sempre
 *    entre aspas.
 * 2. Depois `^` antes de cada metacaractere do `cmd` — DUAS vezes: a
 *    primeira camada é consumida pelo `cmd /c`, a segunda pelo reparse da
 *    linha do `.bat` após expandir `%*`. Com uma camada só, qualquer `"` no
 *    valor alternava o "modo aspas" do segundo parse e o `&` seguinte virava
 *    separador de comando (a injeção da vistoria).
 *
 * Quebra de linha e NUL não têm representação possível numa linha do
 * `cmd.exe` (o `cmd` corta o comando ali, em silêncio): recusamos em vez de
 * entregar metade do prompt.
 */
export function escaparArgParaCmd(valor: string): string {
  if (/[\r\n\0]/.test(valor)) {
    throw new Error(
      'argumento com quebra de linha ou NUL não atravessa o cmd.exe sem ser truncado; ' +
        'use stdinPrompt/{{promptFile}} no manifesto ou um executável que não seja .cmd/.bat',
    );
  }
  let citado = '"';
  let barras = 0;
  for (const ch of valor) {
    if (ch === '\\') {
      barras += 1;
      continue;
    }
    if (ch === '"') citado += '\\'.repeat(barras * 2 + 1) + '"';
    else citado += '\\'.repeat(barras) + ch;
    barras = 0;
  }
  citado += '\\'.repeat(barras * 2) + '"';
  return citado.replace(META_CMD, '^$1').replace(META_CMD, '^$1');
}

export interface SpawnMontado {
  file: string;
  args: string[];
  /** Sempre `false`: nenhum texto do usuário passa por `shell: true`. */
  shell: false;
  /** `true` só no caminho `cmd.exe`, onde a linha já vai escapada à mão. */
  windowsVerbatimArguments: boolean;
}

/**
 * Monta `file`/`args` do `spawn` para um binário resolvido — ponto único para
 * todo lugar que spawna agente (run, probe, `opencode serve`).
 *
 * - Binário comum ou shim npm desembrulhado: `spawn(file, [...prefixArgs, ...args])`
 *   sem shell. O argv chega íntegro (aspas, `%`, `&`, multilinha, Unicode).
 * - `.cmd`/`.bat` não reconhecido: `cmd.exe /d /s /c "<linha>"` com
 *   `windowsVerbatimArguments` — o mesmo que o Node faria com `shell: true`,
 *   mas com cada argumento escapado por `escaparArgParaCmd` em vez de só
 *   ganhar aspas. Recusa (lança) linha acima de `CMD_MAX_LINHA` em vez de
 *   deixar o `cmd` falhar com "linha de comando muito longa".
 */
export function montarSpawn(resolved: ResolvedBin, args: readonly string[]): SpawnMontado {
  const todos = [...(resolved.prefixArgs ?? []), ...args];
  if (!resolved.needsShell) {
    return {
      file: resolved.file ?? resolved.path,
      args: todos,
      shell: false,
      windowsVerbatimArguments: false,
    };
  }

  const comando = (resolved.file ?? resolved.path).replace(META_CMD, '^$1');
  const linha = [comando, ...todos.map(escaparArgParaCmd)].join(' ');
  if (linha.length + 16 > CMD_MAX_LINHA) {
    throw new Error(
      `linha de comando com ${linha.length} caracteres excede o limite do cmd.exe (${CMD_MAX_LINHA}); ` +
        'use stdinPrompt/{{promptFile}} no manifesto',
    );
  }
  return {
    file: process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${linha}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}
