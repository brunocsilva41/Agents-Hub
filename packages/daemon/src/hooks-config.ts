import path from 'node:path';
import { TIMEOUT_DO_HOOK_SEC } from './pretool-gate.js';

/**
 * Registro do gate pré-execução na config do agente — a parte pura.
 *
 * Morava em `packages/cli/src/hooks-install.ts`; veio para o daemon porque o
 * painel também precisa saber se o hook está instalado (e com timeout antigo)
 * e oferecer a instalação com prévia (item 6.12 do GOAL). A CLI reexporta
 * daqui: uma regra só para "o que conta como o hook do Hub".
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

/** Como o nosso comando é reconhecido numa config que já tem outros hooks. */
const MARCA_DO_HOOK = 'main.js" hook';

export interface AlvoDeHook {
  id: string;
  nome: string;
  /** Config de usuário: vale para todas as sessões daquele agente. */
  configUsuario: string;
  /** Config por projeto, quando o agente suporta. */
  configProjeto?: (projectPath: string) => string;
  nota: string;
}

/** Tabela de alvos para um diretório home (injetável, para teste). */
export function hookTargets(home: string): AlvoDeHook[] {
  return [
    {
      id: 'claude',
      nome: 'Claude Code',
      configUsuario: path.join(home, '.claude', 'settings.json'),
      configProjeto: (p) => path.join(p, '.claude', 'settings.json'),
      nota: 'o hook é consultado antes de cada Bash/Write/Edit e pode bloquear a chamada',
    },
    {
      id: 'openclaude',
      nome: 'OpenClaude (fork do Claude Code)',
      configUsuario: path.join(home, '.openclaude', 'settings.json'),
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
}

/**
 * `node <caminho> hook` em vez de `hub hook`: um PATH diferente no ambiente do
 * agente faria o hook falhar em silêncio, e falha de hook é falha aberta.
 */
export function comandoDoHook(nodeBin: string, cliMain: string): string {
  return `"${nodeBin}" "${cliMain}" hook`;
}

export interface EntradaDeHook {
  matcher: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

function entradasPreToolUse(config: Record<string, unknown>): EntradaDeHook[] {
  const hooks = (config['hooks'] ?? {}) as Record<string, unknown>;
  return Array.isArray(hooks['PreToolUse']) ? (hooks['PreToolUse'] as EntradaDeHook[]) : [];
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
  const semONosso = entradasPreToolUse(atual).filter(
    (entrada) => !entrada.hooks?.some((h) => h.command?.includes(MARCA_DO_HOOK)),
  );

  // Timeout MAIOR que a espera do daemon por aprovação humana. Era 10 s contra
  // 60 s: o Claude desistia do hook e rodava a ferramenta antes de qualquer
  // pessoa decidir. Reinstalar (`hub hooks install claude --write`) regrava a
  // entrada com o valor novo — ver os três relógios em `pretool-gate.ts`.
  const nossa: EntradaDeHook = {
    matcher: MATCHER_DE_RISCO,
    hooks: [{ type: 'command', command: comando, timeout: TIMEOUT_DO_HOOK_SEC }],
  };

  return {
    ...atual,
    hooks: { ...hooks, PreToolUse: [...semONosso, nossa] },
  };
}

export function hookInstalado(config: Record<string, unknown>): boolean {
  return entradasPreToolUse(config).some((e) =>
    e.hooks?.some((h) => h.command?.includes(MARCA_DO_HOOK)),
  );
}

/**
 * Hook do Hub instalado com timeout antigo (menor que o atual, ou ausente).
 *
 * Instalações anteriores gravaram `timeout: 10`, e com isso a ação que pedia
 * aprovação humana RODAVA depois de 10 s sem resposta. Reinstalar corrige;
 * isto é o que avisa que é preciso. Devolve `null` quando está tudo certo ou
 * quando o hook nem está instalado.
 */
export function avisoDeTimeoutDoHook(config: Record<string, unknown>): string | null {
  const nossos = entradasPreToolUse(config).flatMap((e) =>
    (e.hooks ?? []).filter((h) => h.command?.includes(MARCA_DO_HOOK)),
  );
  if (nossos.length === 0) return null;

  const velho = nossos.find(
    (h) => typeof h.timeout !== 'number' || h.timeout < TIMEOUT_DO_HOOK_SEC,
  );
  if (!velho) return null;
  return (
    `hook do gate instalado com timeout ${velho.timeout ?? 'ausente'}${typeof velho.timeout === 'number' ? ' s' : ''} ` +
    `(precisa de ${TIMEOUT_DO_HOOK_SEC} s): ação que pede aprovação roda sem ela quando o agente desiste do hook`
  );
}
