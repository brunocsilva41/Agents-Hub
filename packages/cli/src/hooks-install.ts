import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  gravarComBackup,
  lerJsonDeConfig,
  lerJsonParaExibir,
  type JsonDeConfig,
} from '@agents-hub/daemon';

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
    // PARCIALMENTE VERIFICADO em 2026-09-18 (verificação de MCP_TARGETS desta
    // sessão, bônus barato no mesmo caminho): `~/.openclaude/settings.json`
    // EXISTE de verdade nesta máquina e tem chave `hooks` de nível raiz com
    // `PreToolUse`/`SessionStart`, cada entrada `{ hooks: [{ type: "command",
    // command, ... }] }` — o MESMO formato do Claude Code, confirmado por
    // leitura direta do arquivo, não por suposição. O que NÃO foi verificado
    // nesta passagem: se o openclaude CONSULTA esse hook antes de cada
    // Bash/Write/Edit (comportamento em runtime), se `AGENTS_HUB_SESSION_ID`
    // chega no processo do hook, e se o dialeto de resposta é o do Claude
    // (`escalate`/`ask`) ou o oposto do Codex (`toCodexHookOutput`) — só o
    // schema estático do arquivo de config foi conferido.
    nota: 'caminho e schema (hooks.PreToolUse) confirmados no disco desta máquina; comportamento em runtime (se o binário consulta o hook e com que dialeto) ainda não foi exercido',
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

/**
 * Leitura só para EXIBIR (`hub hooks`): tolerante a JSONC e a lixo no fim,
 * para mostrar o status real em vez de "não instalado" por causa de um
 * comentário. Nunca use o resultado disto para regravar o arquivo.
 */
export function lerConfig(file: string): Record<string, unknown> {
  return lerJsonParaExibir(file);
}

/**
 * Leitura para EDITAR: aceita JSON estrito e JSONC; recusa (lança, sem gravar
 * nada) arquivo que não parseia por inteiro. Antes, o erro virava `{}` e a
 * regravação apagava permissões, modelo e hooks da pessoa.
 */
export function lerConfigParaGravar(file: string): JsonDeConfig {
  return lerJsonDeConfig(file);
}

export interface GravacaoDeHook {
  acao: 'criado' | 'atualizado' | 'inalterado';
  /** Backup versionado (`settings.json.bak-YYYYMMDD-HHMMSS`) desta execução. */
  backup: string | null;
}

/**
 * Grava com backup versionado (nunca sobrescreve um backup anterior) e escrita
 * atômica. Se o conteúdo já é o desejado, não grava nem cria backup — rodar
 * duas vezes não multiplica arquivos nem apaga comentários à toa.
 */
export function gravarConfig(
  file: string,
  atual: Record<string, unknown>,
  conteudo: Record<string, unknown>,
  agora: Date = new Date(),
): GravacaoDeHook {
  const existia = existsSync(file);
  if (existia && isDeepStrictEqual(atual, conteudo)) return { acao: 'inalterado', backup: null };
  const backup = gravarComBackup(file, `${JSON.stringify(conteudo, null, 2)}\n`, agora);
  return { acao: existia ? 'atualizado' : 'criado', backup };
}
