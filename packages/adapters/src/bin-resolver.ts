import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const realExecFileAsync = promisify(execFile);

export interface ResolvedBin {
  path: string;
  /**
   * `.cmd` e `.bat` no Windows exigem `shell: true` no spawn desde as correções
   * de segurança do Node 18.20/20.12 — e quase todo CLI de agente instalado via
   * npm no Windows é um shim `.cmd`.
   */
  needsShell: boolean;
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

    return { path: best, needsShell: /\.(cmd|bat)$/i.test(best) };
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
      return { path: fb, needsShell: /\.(cmd|bat)$/i.test(fb) };
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
