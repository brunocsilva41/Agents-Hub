import { HubClient } from '@agents-hub/client';

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

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function timeOf(iso: string): string {
  return iso.slice(11, 19);
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
