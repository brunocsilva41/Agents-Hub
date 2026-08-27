import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@agents-hub/core';
import type {
  AgentSummary,
  ApprovalSummary,
  BudgetSummary,
  GraphSummary,
  SessionSummary,
} from '@agents-hub/client';
import { hub } from './hub';

/** Eventos que mudam a ESTRUTURA do fluxo e obrigam a recarregar o grafo. */
const STRUCTURAL = new Set([
  'session.started',
  'session.ended',
  'delegation.requested',
  'delegation.completed',
  'approval.requested',
  'approval.resolved',
  'turn.completed',
  'budget.exceeded',
  'error',
]);

const MAX_EVENTS_PER_SESSION = 3000;

export interface HubState {
  connected: boolean;
  agents: AgentSummary[];
  sessions: SessionSummary[];
  roots: SessionSummary[];
  approvals: ApprovalSummary[];
  graphs: Record<string, GraphSummary[]>;
  budgets: Record<string, BudgetSummary>;
  eventsOf: (sessionId: string) => EventEnvelope[];
  refresh: () => Promise<void>;
  error: string | null;
}

/**
 * Estado vivo do Hub.
 *
 * Um único `EventSource` sem filtro alimenta tudo: a timeline cresce de forma
 * incremental (barato) e só eventos ESTRUTURAIS disparam recarga de grafo e
 * orçamento (caro). Recarregar tudo a cada token que chega derrubaria a UI
 * numa sessão falante.
 */
export function useHubState(): HubState {
  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [graphs, setGraphs] = useState<Record<string, GraphSummary[]>>({});
  const [budgets, setBudgets] = useState<Record<string, BudgetSummary>>({});
  const [events, setEvents] = useState<Record<string, EventEnvelope[]>>({});
  const [error, setError] = useState<string | null>(null);

  const reloadTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ sessions: list }, { agents: agentList }, { approvals: pending }] =
        await Promise.all([hub.sessions(), hub.agents(), hub.approvals()]);
      setSessions(list);
      setAgents(agentList);
      setApprovals(pending);
      setError(null);

      const rootIds = [...new Set(list.map((s) => s.rootId))];
      const loaded = await Promise.all(
        rootIds.map(async (rootId) => {
          const [graph, budget] = await Promise.all([hub.graph(rootId), hub.budget(rootId)]);
          return [rootId, graph.graph, budget.budget] as const;
        }),
      );

      setGraphs(Object.fromEntries(loaded.map(([id, graph]) => [id, graph])));
      setBudgets(Object.fromEntries(loaded.map(([id, , budget]) => [id, budget])));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  /** Recarga agrupada: uma rajada de eventos estruturais vira uma só chamada. */
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void refresh();
    }, 400);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource(hub.streamUrl());

    source.onopen = () => setConnected(true);
    source.onerror = () => {
      setConnected(false);
      // O EventSource reconecta sozinho; ao voltar, recarregamos para preencher
      // o buraco de eventos que passaram enquanto estávamos fora.
      scheduleReload();
    };
    source.onmessage = (message: MessageEvent<string>) => {
      let event: EventEnvelope;
      try {
        event = JSON.parse(message.data) as EventEnvelope;
      } catch {
        return;
      }

      setEvents((current) => {
        const existing = current[event.sessionId] ?? [];
        // Reconexão do SSE reenvia eventos: deduplicar por seq evita a timeline
        // aparecer duplicada depois de uma queda de conexão.
        if (existing.some((e) => e.seq === event.seq)) return current;
        const next = [...existing, event].slice(-MAX_EVENTS_PER_SESSION);
        return { ...current, [event.sessionId]: next };
      });

      if (STRUCTURAL.has(event.type)) scheduleReload();
    };

    return () => source.close();
  }, [scheduleReload]);

  const eventsOf = useCallback((sessionId: string) => events[sessionId] ?? [], [events]);

  const roots = useMemo(
    () =>
      sessions
        .filter((s) => s.parentId === null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [sessions],
  );

  return {
    connected,
    agents,
    sessions,
    roots,
    approvals,
    graphs,
    budgets,
    eventsOf,
    refresh,
    error,
  };
}

/**
 * Carrega o histórico de uma sessão ao selecioná-la.
 *
 * O SSE só traz o que acontece a partir de agora; sem isto, abrir uma sessão
 * antiga mostraria uma timeline vazia como se nada tivesse acontecido.
 */
export function useSessionHistory(sessionId: string | null): {
  history: EventEnvelope[];
  loading: boolean;
} {
  const [history, setHistory] = useState<EventEnvelope[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setHistory([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    hub
      .events(sessionId, { limit: 2000 })
      .then(({ events }) => {
        if (!cancelled) setHistory(events);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return { history, loading };
}

/** Junta histórico e stream ao vivo sem duplicar o que aparece nos dois. */
export function mergeEvents(
  history: EventEnvelope[],
  live: EventEnvelope[],
): EventEnvelope[] {
  const bySeq = new Map<number, EventEnvelope>();
  for (const event of history) bySeq.set(event.seq, event);
  for (const event of live) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
