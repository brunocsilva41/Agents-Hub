import { HubApiError, HubClient } from '@agents-hub/client';
import type { AgentDiscovery, ImportKind, ImportResult } from '@agents-hub/core';

/**
 * A UI é servida pelo próprio daemon (ADR 05.3), então a API está na mesma
 * origem. Em `vite dev` o proxy cuida disso — nos dois casos, caminho relativo.
 */
export const hub = new HubClient(window.location.origin);

export const AGENT_COLORS = [
  'var(--agent-1)',
  'var(--agent-2)',
  'var(--agent-3)',
  'var(--agent-4)',
  'var(--agent-5)',
  'var(--agent-6)',
  'var(--agent-7)',
  'var(--agent-8)',
];

/** Cor estável por agente: a mesma sempre, em qualquer sessão ou reload. */
export function agentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return AGENT_COLORS[hash % AGENT_COLORS.length] as string;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  return `US$ ${n.toFixed(4)}`;
}

/** Versão curta para listas densas, onde 4 casas viram ruído em toda linha. */
export function formatUsdShort(n: number): string {
  if (n === 0) return 'US$ 0';
  if (n < 0.01) return `US$ ${n.toFixed(4)}`;
  return `US$ ${n.toFixed(2)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function timeOf(iso: string): string {
  return iso.slice(11, 19);
}

/** "há 4min" diz mais que um carimbo ISO quando a pergunta é "isto ainda anda?". */
export function formatAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'agora';
  if (seconds < 3600) return `há ${Math.round(seconds / 60)}min`;
  if (seconds < 86400) return `há ${Math.floor(seconds / 3600)}h`;
  return `há ${Math.floor(seconds / 86400)}d`;
}

export const STATE_LABEL: Record<string, string> = {
  idle: 'ociosa',
  running: 'rodando',
  waiting_approval: 'aguardando você',
  paused: 'pausada',
  completed: 'concluída',
  failed: 'falhou',
  killed: 'encerrada',
};

/**
 * Ordem de urgência dos estados: o que pede decisão vem antes do que só corre,
 * e o que corre antes do que já acabou.
 *
 * Um fluxo tem várias sessões em estados diferentes; a lista da esquerda mostra
 * UM estado por fluxo, e tem que ser o que exige atenção — não o da sessão mais
 * recente, que pode ter terminado enquanto a irmã está travada esperando você.
 */
const STATE_URGENCY: Record<string, number> = {
  waiting_approval: 0,
  running: 1,
  paused: 2,
  idle: 3,
  failed: 4,
  killed: 5,
  completed: 6,
};

export function mostUrgentState(states: readonly string[]): string {
  let best = 'completed';
  let bestRank = Number.POSITIVE_INFINITY;
  for (const state of states) {
    const rank = STATE_URGENCY[state] ?? 3;
    if (rank < bestRank) {
      bestRank = rank;
      best = state;
    }
  }
  return best;
}

export function isLiveState(state: string): boolean {
  return state === 'running' || state === 'waiting_approval' || state === 'paused' || state === 'idle';
}

/** Risco vem do daemon em inglês técnico; a fila de aprovações é lida sob pressão. */
export const RISK_LABEL: Record<string, string> = {
  budget: 'orçamento',
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
  critical: 'crítico',
};

/* ------------------------------------------------------------------------ */
/* Descoberta e importação do ambiente dos CLIs                             */
/* ------------------------------------------------------------------------ */

export interface ImportRequest {
  agentId: string;
  kinds: ImportKind[];
  /** Padrão do daemon é `true`: prévia. Aplicar exige `false` explícito. */
  dryRun: boolean;
  targetAgents?: string[];
  overwrite?: boolean;
  includeEnv?: boolean;
}

/**
 * Estas rotas ainda não estão no `HubClient` (pacote fora da área da UI), então
 * falam com a API por aqui. O tratamento de erro espelha o do cliente: o
 * `HubApiError` carrega `details.issues`, que `describeError` já sabe exibir.
 */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${window.location.origin}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new HubApiError(
        `o Hub respondeu algo que não é JSON (HTTP ${response.status}).`,
        'RESPOSTA_NAO_JSON',
        response.status,
      );
    }
  }
  if (!response.ok) {
    const error = parsed['error'] as { code?: string; message?: string; details?: unknown } | undefined;
    throw new HubApiError(
      error?.message ?? (text || `HTTP ${response.status}`),
      error?.code ?? String(response.status),
      response.status,
      error?.details,
    );
  }
  return parsed as T;
}

/** Lista o que cada CLI instalado já tem (leitura apenas, sem segredos). */
export function fetchDiscovery(): Promise<{ agents: AgentDiscovery[] }> {
  return call('GET', '/discovery');
}

/** Relê um agente do disco, ignorando o cache do daemon. */
export function refreshDiscovery(agentId: string): Promise<AgentDiscovery> {
  return call<AgentDiscovery | { agent: AgentDiscovery }>(
    'GET',
    `/discovery/${encodeURIComponent(agentId)}?refresh=1`,
  ).then((r) => ('agent' in r ? r.agent : r));
}

/** Prévia (`dryRun: true`) ou aplicação (`dryRun: false`) da importação. */
export function importFromAgent(projectId: string, request: ImportRequest): Promise<ImportResult> {
  return call('POST', `/projects/${encodeURIComponent(projectId)}/import`, request);
}
