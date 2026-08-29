import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ResolvedBin {
  path: string;
  /**
   * `.cmd` e `.bat` no Windows exigem `shell: true` no spawn desde as correções
   * de segurança do Node 18.20/20.12 — e quase todo CLI de agente instalado via
   * npm no Windows é um shim `.cmd`.
   */
  needsShell: boolean;
}

const cache = new Map<string, ResolvedBin | null>();

export async function resolveBin(bin: string): Promise<ResolvedBin | null> {
  const cached = cache.get(bin);
  if (cached !== undefined) return cached;

  const resolved = await lookup(bin);
  cache.set(bin, resolved);
  return resolved;
}

export function clearBinCache(): void {
  cache.clear();
}

async function lookup(bin: string): Promise<ResolvedBin | null> {
  const isWindows = process.platform === 'win32';
  const finder = isWindows ? 'where' : 'which';

  try {
    const { stdout } = await execFileAsync(finder, [bin], { windowsHide: true });
    const candidates = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (candidates.length === 0) return lookupFallback(bin, isWindows);

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
    return lookupFallback(bin, isWindows);
  }
}

function lookupFallback(bin: string, isWindows: boolean): ResolvedBin | null {
  if (!isWindows) return null;
  const fallbacks = [
    path.join(process.env['LOCALAPPDATA'] ?? '', 'agy', 'bin', `${bin}.exe`),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', bin, `${bin}.exe`),
    path.join(os.homedir(), '.local', 'bin', `${bin}.exe`),
    path.join(os.homedir(), '.kimi-code', 'bin', `${bin}.exe`),
    path.join(process.env['APPDATA'] ?? '', 'npm', `${bin}.cmd`),
  ];
  for (const fb of fallbacks) {
    if (existsSync(fb)) {
      return { path: fb, needsShell: /\.(cmd|bat)$/i.test(fb) };
    }
  }
  return null;
}

/**
 * Aspas para linha de comando do Windows. Só é usada para o CAMINHO do binário
 * e para flags simples — o prompt do usuário nunca passa por aqui: vai por
 * stdin (`stdinPrompt`), justamente para não depender de escaping.
 */
export function quoteForShell(value: string): string {
  if (process.platform !== 'win32') return value;
  if (/^[A-Za-z0-9_\-.:\\/=]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}
