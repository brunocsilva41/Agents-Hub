import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@agents-hub/core';
import type {
  AgentSummary,
  ApprovalSummary,
  BudgetSummary,
  GraphSummary,
  SessionSummary,
} from '@agents-hub/client';
import { hub, isLiveState, mostUrgentState } from './hub';

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

/**
 * Um fluxo: a raiz e tudo que nasceu dela, resumido sem nenhuma chamada extra.
 *
 * Tudo aqui sai da lista de sessões que já buscamos de qualquer jeito. Antes o
 * painel pedia `/graph` de cada raiz só para saber o que escrever na lista da
 * esquerda — 27 requisições para desenhar 27 linhas.
 */
export interface FlowSummary {
  rootId: string;
  /** Sessões do fluxo, da mais recente para a mais antiga. */
  sessions: SessionSummary[];
  agents: string[];
  title: string;
  /** O estado que exige atenção, não o da sessão mais recente. */
  state: string;
  live: boolean;
  updatedAt: string;
}

export interface HubState {
  connected: boolean;
  /** Primeira carga concluída: distingue "nada aqui" de "ainda não sei". */
  ready: boolean;
  agents: AgentSummary[];
  sessions: SessionSummary[];
  flows: FlowSummary[];
  approvals: ApprovalSummary[];
  eventsOf: (sessionId: string) => EventEnvelope[];
  /**
   * Sobe a cada rajada de eventos estruturais. Quem depende de grafo ou
   * orçamento observa este número em vez de refazer tudo a cada evento.
   */
  revision: number;
  refresh: () => Promise<void>;
  error: string | null;
}

/**
 * Estado vivo do Hub.
 *
 * Um único `EventSource` sem filtro alimenta tudo: a timeline cresce de forma
 * incremental (barato) e só eventos ESTRUTURAIS marcam o índice como velho
 * (caro). Recarregar tudo a cada token que chega derrubaria a UI numa sessão
 * falante.
 *
 * O índice — sessões, agentes, aprovações — são três requisições fixas. Grafo e
 * orçamento NÃO moram aqui: são caros por raiz e quase sempre desnecessários,
 * então quem precisa deles pede em `useFlowGraph`/`useBudget`, para o fluxo que
 * está de fato na tela.
 */
export function useHubState(): HubState {
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [events, setEvents] = useState<Record<string, EventEnvelope[]>>({});
  const [revision, setRevision] = useState(0);
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReady(true);
    }
  }, []);

  /** Recarga agrupada: uma rajada de eventos estruturais vira uma só chamada. */
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      setRevision((n) => n + 1);
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
        // aparecer duplicada depois de uma queda de conexão. A busca de trás
        // para frente acha o duplicado nas primeiras comparações, porque o que
        // volta na reconexão é sempre o fim da fila.
        for (let i = existing.length - 1; i >= 0; i -= 1) {
          if (existing[i]?.seq === event.seq) return current;
        }
        const next = [...existing, event].slice(-MAX_EVENTS_PER_SESSION);
        return { ...current, [event.sessionId]: next };
      });

      if (STRUCTURAL.has(event.type)) scheduleReload();
    };

    return () => {
      source.close();
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = null;
      }
    };
  }, [scheduleReload]);

  const eventsOf = useCallback((sessionId: string) => events[sessionId] ?? [], [events]);

  /**
   * Um fluxo por `rootId` DISTINTO, não por `parentId === null`.
   *
   * Um handoff cria uma sessão irmã: mesma raiz, sem pai. Agrupar por
   * `parentId === null` a tratava como raiz de um fluxo que não existe — o
   * painel desenhava um bloco vazio e a sessão transferida ficava inalcançável.
   */
  const flows = useMemo(() => {
    const byRoot = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const group = byRoot.get(session.rootId);
      if (group) group.push(session);
      else byRoot.set(session.rootId, [session]);
    }

    const list: FlowSummary[] = [];
    for (const [rootId, group] of byRoot) {
      const ordered = [...group].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const root = group.find((s) => s.id === rootId) ?? ordered[ordered.length - 1];
      const state = mostUrgentState(group.map((s) => s.state));
      list.push({
        rootId,
        sessions: ordered,
        agents: [...new Set(group.map((s) => s.agentId))],
        title: root?.title ?? ordered[0]?.title ?? rootId,
        state,
        live: group.some((s) => isLiveState(s.state)),
        updatedAt: ordered[0]?.updatedAt ?? root?.updatedAt ?? '',
      });
    }

    // Vivo antes de morto, e dentro de cada grupo o mais recente primeiro: quem
    // abre o painel quer ver o que está acontecendo, não o histórico.
    return list.sort(
      (a, b) => Number(b.live) - Number(a.live) || b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [sessions]);

  // Identidade estável: sem isto o objeto é novo a cada render e invalida todo
  // `useMemo` que o tenha nas dependências — inclusive o cálculo da timeline.
  return useMemo(
    () => ({
      connected,
      ready,
      agents,
      sessions,
      flows,
      approvals,
      eventsOf,
      revision,
      refresh,
      error,
    }),
    [connected, ready, agents, sessions, flows, approvals, eventsOf, revision, refresh, error],
  );
}

/**
 * Grafo de UM fluxo, buscado só quando ele está aberto na lista.
 *
 * O grafo é a única fonte do custo por nó, e custa uma requisição por raiz.
 * Buscar os 27 de uma vez a cada evento estrutural era o gargalo do painel.
 */
export function useFlowGraph(rootId: string | null, revision: number): GraphSummary[] | null {
  const [graph, setGraph] = useState<GraphSummary[] | null>(null);

  useEffect(() => {
    if (!rootId) {
      setGraph(null);
      return;
    }
    let cancelled = false;
    hub
      .graph(rootId)
      .then(({ graph: nodes }) => {
        if (!cancelled) setGraph(nodes);
      })
      .catch(() => {
        if (!cancelled) setGraph([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rootId, revision]);

  return graph;
}

/** Orçamento do fluxo selecionado — o único que o painel da direita mostra. */
export function useBudget(rootId: string | null, revision: number): BudgetSummary | null {
  const [budget, setBudget] = useState<BudgetSummary | null>(null);

  useEffect(() => {
    if (!rootId) {
      setBudget(null);
      return;
    }
    let cancelled = false;
    hub
      .budget(rootId)
      .then(({ budget: value }) => {
        if (!cancelled) setBudget(value);
      })
      .catch(() => {
        if (!cancelled) setBudget(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rootId, revision]);

  return budget;
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
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Limpar ANTES de buscar: manter o histórico anterior na tela mostrava os
    // eventos da sessão velha sob o nome da nova até a resposta chegar.
    setHistory([]);
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

/**
 * Junta as timelines de várias sessões do mesmo fluxo.
 *
 * Ordena por tempo porque `seq` só é monotônico DENTRO de uma sessão: usá-lo
 * aqui embaralharia agentes diferentes. A deduplicação é por `Map`, não pelo
 * `findIndex` que estava aqui antes — aquele era O(n²) e, com 3000 eventos,
 * gastava ~390 ms a cada render.
 */
export function mergeFlowEvents(streams: readonly EventEnvelope[][]): EventEnvelope[] {
  const byId = new Map<string, EventEnvelope>();
  for (const stream of streams) {
    for (const event of stream) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
}
