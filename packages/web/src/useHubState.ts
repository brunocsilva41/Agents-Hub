import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@agents-hub/core';
import type {
  AgentSummary,
  ApprovalSummary,
  BudgetSummary,
  GraphSummary,
  ProjectSummary,
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
  'budget.warning',
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
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  flows: FlowSummary[];
  approvals: ApprovalSummary[];
  eventsOf: (sessionId: string) => EventEnvelope[];
  /** `true` quando a última tentativa de buscar o histórico desta sessão falhou. */
  eventsFailedFor: (sessionId: string) => boolean;
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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [events, setEvents] = useState<Record<string, EventEnvelope[]>>({});
  const [eventsFailed, setEventsFailed] = useState<Record<string, boolean>>({});
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reloadTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ sessions: list }, { agents: agentList }, { approvals: pending }, { projects: projectList }] =
        await Promise.all([hub.sessions(), hub.agents(), hub.approvals(), hub.projects()]);
      setSessions(list);
      setAgents(agentList);
      setApprovals(pending);
      setProjects(projectList);
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

  const requestedRef = useRef<Set<string>>(new Set());

  const eventsOf = useCallback((sessionId: string) => {
    if (!sessionId) return [];
    if (!events[sessionId] && !requestedRef.current.has(sessionId)) {
      requestedRef.current.add(sessionId);
      hub.events(sessionId).then(({ events: list }) => {
        setEventsFailed((prev) => (prev[sessionId] ? { ...prev, [sessionId]: false } : prev));
        setEvents((prev) => ({ ...prev, [sessionId]: list }));
      }).catch(() => {
        // Falha de rede não pode virar "sessão sem eventos" — a timeline vazia
        // é indistinguível de "ainda não fez nada" sem este sinal à parte.
        setEventsFailed((prev) => ({ ...prev, [sessionId]: true }));
      });
    }
    return events[sessionId] ?? [];
  }, [events]);

  const eventsFailedFor = useCallback(
    (sessionId: string) => eventsFailed[sessionId] === true,
    [eventsFailed],
  );

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
      projects,
      sessions,
      flows,
      approvals,
      eventsOf,
      eventsFailedFor,
      revision,
      refresh,
      error,
    }),
    [
      connected,
      ready,
      agents,
      projects,
      sessions,
      flows,
      approvals,
      eventsOf,
      eventsFailedFor,
      revision,
      refresh,
      error,
    ],
  );
}

/**
 * Grafo de UM fluxo, buscado só quando ele está aberto na lista.
 *
 * O grafo é a única fonte do custo por nó, e custa uma requisição por raiz.
 * Buscar os 27 de uma vez a cada evento estrutural era o gargalo do painel.
 */
export function useFlowGraph(
  rootId: string | null,
  revision: number,
): { graph: GraphSummary[] | null; failed: boolean } {
  const [graph, setGraph] = useState<GraphSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!rootId) {
      setGraph(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setFailed(false);
    hub
      .graph(rootId)
      .then(({ graph: nodes }) => {
        if (!cancelled) setGraph(nodes);
      })
      .catch(() => {
        // Falha de rede não pode virar "fluxo sem sessões" — são desfechos
        // distintos, e quem consome precisa poder avisar qual é o caso.
        if (!cancelled) {
          setGraph([]);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rootId, revision]);

  return { graph, failed };
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
 * Quantas sessões-irmãs de um fluxo a visão "Fluxo inteiro" busca de uma vez
 * (via `eventsOf`, que já dedup/cacheia por sessão em `useHubState`).
 *
 * Sem teto, abrir um fluxo com 30+ sub-sessões disparava uma requisição HTTP
 * simultânea por sessão-irmã. Exportado para `App.tsx`, que é quem monta a
 * lista de irmãos da sessão selecionada.
 */
export const MAX_FLOW_HISTORIES = 12;

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
