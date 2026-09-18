import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Registro do gate pré-execução na config do agente.
 *
 * Contrato confirmado empiricamente contra o binário do Claude Code:
 * `hooks.PreToolUse[] = { matcher: <regex>, hooks: [{ type, command, timeout }] }`.
 */

/**
 * Só as ferramentas que carregam risco.
 *
 * Cada chamada gateada custa um processo Node novo. Incluir `Read`, `Glob` e
 * `Grep` — que a política classifica como `read` e sempre libera — colocaria
 * esse custo no caminho quente de toda leitura de arquivo, em troca de nenhuma
 * proteção. O agente lê muito mais do que escreve.
 */
export const MATCHER_DE_RISCO = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch';

export interface AlvoDeHook {
  id: string;
  nome: string;
  /** Config de usuário: vale para todas as sessões daquele agente. */
  configUsuario: string;
  /** Config por projeto, quando o agente suporta. */
  configProjeto?: (projectPath: string) => string;
  nota: string;
}

export const HOOK_TARGETS: AlvoDeHook[] = [
  {
    id: 'claude',
    nome: 'Claude Code',
    configUsuario: path.join(os.homedir(), '.claude', 'settings.json'),
    configProjeto: (p) => path.join(p, '.claude', 'settings.json'),
    nota: 'o hook é consultado antes de cada Bash/Write/Edit e pode bloquear a chamada',
  },
  {
    id: 'openclaude',
    nome: 'OpenClaude (fork do Claude Code)',
    configUsuario: path.join(os.homedir(), '.openclaude', 'settings.json'),
    configProjeto: (p) => path.join(p, '.openclaude', 'settings.json'),
    // ADICIONADO, NÃO VERIFICADO: mesmo formato de hooks do Claude Code é
    // suposição por ser fork — nunca confirmado contra o binário do
    // openclaude (nem o diretório de config, nem o schema de PreToolUse).
    nota: 'suposição por herança do Claude Code — nunca confirmado contra o binário do openclaude',
  },
];

/** Caminho absoluto do `main.js` desta CLI — não depende de `hub` estar no PATH. */
export function hookEntrypoint(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}

export function hookCommand(): string {
  // `node <caminho> hook` em vez de `hub hook`: um PATH diferente no ambiente do
  // agente faria o hook falhar em silêncio, e falha de hook é falha aberta.
  return `"${process.execPath}" "${hookEntrypoint()}" hook`;
}

export interface EntradaDeHook {
  matcher: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/**
 * Funde a nossa entrada preservando o que já existe.
 *
 * Sobrescrever `hooks.PreToolUse` inteiro apagaria hooks que a pessoa
 * configurou antes — e ela só descobriria quando algo parasse de acontecer.
 */
export function mergeHooks(
  atual: Record<string, unknown>,
  comando: string,
): Record<string, unknown> {
  const hooks = (atual['hooks'] ?? {}) as Record<string, unknown>;
  const preToolUse = Array.isArray(hooks['PreToolUse'])
    ? (hooks['PreToolUse'] as EntradaDeHook[])
    : [];

  const semONosso = preToolUse.filter(
    (entrada) => !entrada.hooks?.some((h) => h.command?.includes('main.js" hook')),
  );

  const nossa: EntradaDeHook = {
    matcher: MATCHER_DE_RISCO,
    hooks: [{ type: 'command', command: comando, timeout: 10 }],
  };

  return {
    ...atual,
    hooks: { ...hooks, PreToolUse: [...semONosso, nossa] },
  };
}

export function hookInstalado(config: Record<string, unknown>): boolean {
  const hooks = (config['hooks'] ?? {}) as Record<string, unknown>;
  const preToolUse = Array.isArray(hooks['PreToolUse'])
    ? (hooks['PreToolUse'] as EntradaDeHook[])
    : [];
  return preToolUse.some((e) => e.hooks?.some((h) => h.command?.includes('main.js" hook')));
}

export function lerConfig(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Grava com backup: mexer na config do editor de alguém pede rede de segurança. */
export function gravarConfig(file: string, conteudo: Record<string, unknown>): string | null {
  mkdirSync(path.dirname(file), { recursive: true });

  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }

  writeFileSync(file, `${JSON.stringify(conteudo, null, 2)}\n`, 'utf8');
  return backup;
}
