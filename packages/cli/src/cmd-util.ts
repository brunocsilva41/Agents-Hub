/**
 * Peças comuns dos comandos do item 5.6 (`init`, `open`, `logs`, `restart`,
 * `update`, `version`, `export`, `cost`, `merge`, `backup`...). Cada comando
 * mora no próprio `*-cmd.ts` para ser testado sem importar `main.ts`, que
 * dispara `main()` como efeito colateral do import.
 */

import { erroDeUso, mostrarErro } from './erro-cli.js';

export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export const NEWLINE = String.fromCharCode(10);

/**
 * Argumento obrigatório. Lança `ErroDeUso`: a borda de erro (`mostrarErro`)
 * imprime junto a linha de uso do comando — antes era só "argumento
 * obrigatório ausente: sessionId", sem dizer como chamar.
 */
export function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw erroDeUso(`argumento obrigatório ausente: ${name}`);
  }
  return value;
}

export function flagString(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

/** `--x` presente sem valor (ou com valor) — para flags booleanas. */
export function flagOn(args: Args, name: string): boolean {
  const v = args.flags[name];
  return v === true || v === 'true' || v === '1';
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/** Tira as cores de uma linha renderizada — para arquivo e JSON. */
export function semCor(texto: string): string {
  return texto.replace(ANSI, '');
}

/**
 * Borda de erro para comandos que NÃO passam por `withDaemon` (não devem
 * subir o daemon: `logs`, `backup`, `restore`, `restart`, `update`, `init`):
 * mensagem formatada e código 1, em vez de stack trace.
 */
export async function comErro(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    mostrarErro(err);
  }
}

/** `JSON.stringify` com indentação, o formato de todo `--json` da CLI. */
export function imprimirJson(valor: unknown): void {
  console.log(JSON.stringify(valor, null, 2));
}

/**
 * `7d`, `12h`, `30m` ou ISO 8601 -> instante ISO. Mesmo formato do
 * `hub audit --since`.
 */
export function instanteDe(valor: string, agora = Date.now()): string {
  const rel = /^(\d+)\s*(s|m|h|d)$/i.exec(valor.trim());
  if (rel) {
    const n = Number(rel[1]);
    const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      rel[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'
    ];
    return new Date(agora - n * mult).toISOString();
  }
  const t = Date.parse(valor);
  if (!Number.isFinite(t)) {
    throw new Error(`instante inválido: "${valor}" (use 7d, 12h, 30m ou uma data ISO)`);
  }
  return new Date(t).toISOString();
}
