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
import { EventHistory } from './lib/eventHistory';
import type { HistoryState } from './lib/eventMerge';
import { isStructural, patchSessionsFromEvent } from './lib/hubEvents';
import { createRefetchScheduler, type RefetchScheduler } from './lib/refetchScheduler';

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
  /** Timeline carregada da sessão (histórico pelo fim + o que chegou ao vivo). */
  eventsOf: (sessionId: string) => EventEnvelope[];
  /** `true` quando a última tentativa de buscar o histórico desta sessão falhou. */
  eventsFailedFor: (sessionId: string) => boolean;
  /** Situação do histórico: carregando, falhou, há mais antigos, próxima tentativa. */
  historyOf: (sessionId: string) => HistoryState;
  /** Pede ao daemon a página anterior ao evento mais antigo carregado. */
  loadOlder: (sessionId: string) => void;
  /** "Tentar de novo" depois que as tentativas automáticas acabaram. */
  retryEvents: (sessionId: string) => void;
  /**
   * Sobe em recargas GERAIS (reconexão, evento de sessão ainda desconhecida).
   * Para grafo/orçamento de um fluxo use `revisionOf`, que também sobe quando
   * chega evento estrutural DAQUELE fluxo — e só dele.
   */
  revision: number;
  revisionOf: (rootId: string | null) => number;
  refresh: () => Promise<void>;
  error: string | null;
}

/** Marca de "não sei de que fluxo é" — força recarga geral de grafo/orçamento. */
const ANY_ROOT = '*';

/**
 * Estado vivo do Hub.
 *
 * Um único `EventSource` sem filtro alimenta tudo: a timeline cresce de forma
 * incremental (barato) e só eventos ESTRUTURAIS pedem recarga do índice (caro).
 *
 * A recarga passa por um agendador (`createRefetchScheduler`): uma rajada vira
 * UMA busca de `/sessions` + `/approvals`, nunca duas em voo. `/agents` (que
 * sonda binários) e `/projects` só na carga inicial, na reconexão e em
 * `refresh()` explícito — evento de sessão não muda nenhum dos dois. Grafo e
 * orçamento sobem de revisão só no fluxo que recebeu o evento. Medido antes:
 * 253 requisições em 15 min — 4 GETs duplicados por evento mais `/graph` por
 * fluxo.
 */
export function useHubState(): HubState {
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [revision, setRevision] = useState(0);
  const [rootRevisions, setRootRevisions] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  // Instância única pela vida da página. Sem `dispose` no desmonte: o
  // StrictMode desmonta e remonta em desenvolvimento, e um histórico
  // descartado ali pararia de responder para sempre.
  const [history] = useState(
    () =>
      new EventHistory({
        fetch: (sessionId, options) => hub.events(sessionId, options).then((r) => r.events),
        onChange: () => setHistoryVersion((v) => v + 1),
      }),
  );

  const sessionsRef = useRef<SessionSummary[]>([]);
  sessionsRef.current = sessions;
  const touchedRoots = useRef<Set<string>>(new Set());

  /** Índice completo: carga inicial, reconexão e depois de ações do usuário. */
  const loadFull = useCallback(async (withAgents: boolean) => {
    try {
      const [{ sessions: list }, { approvals: pending }, { projects: projectList }, agentList] =
        await Promise.all([
          hub.sessions(),
          hub.approvals(),
          hub.projects(),
          withAgents ? hub.agents().then((r) => r.agents) : Promise.resolve(null),
        ]);
      setSessions(list);
      setApprovals(pending);
      setProjects(projectList);
      if (agentList) setAgents(agentList);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReady(true);
    }
  }, []);

  /** Recarga barata disparada por eventos: só o que evento de sessão muda. */
  const loadForEvents = useCallback(async () => {
    const roots = [...touchedRoots.current];
    touchedRoots.current.clear();
    try {
      const [{ sessions: list }, { approvals: pending }] = await Promise.all([
        hub.sessions(),
        hub.approvals(),
      ]);
      setSessions(list);
      setApprovals(pending);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
    if (roots.includes(ANY_ROOT)) setRevision((n) => n + 1);
    const specific = roots.filter((r) => r !== ANY_ROOT);
    if (specific.length > 0) {
      setRootRevisions((prev) => {
        const next = { ...prev };
        for (const root of specific) next[root] = (next[root] ?? 0) + 1;
        return next;
      });
    }
  }, []);

  const schedulerRef = useRef<RefetchScheduler | null>(null);

  useEffect(() => {
    const scheduler = createRefetchScheduler(loadForEvents, { delayMs: 300, maxWaitMs: 1500 });
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [loadForEvents]);

  const refresh = useCallback(() => loadFull(false), [loadFull]);

  useEffect(() => {
    void loadFull(true);
  }, [loadFull]);

  useEffect(() => {
    const source = new EventSource(hub.streamUrl());
    let dropped = false;

    source.onopen = () => {
      setConnected(true);
      if (dropped) {
        // Voltou de uma queda: o SSE global não tem replay. Recarrega o índice,
        // repõe o buraco das timelines abertas e invalida grafo/orçamento.
        dropped = false;
        void loadFull(true);
        void history.resync();
        setRevision((n) => n + 1);
      }
    };
    source.onerror = () => {
      setConnected(false);
      dropped = true;
    };
    source.onmessage = (message: MessageEvent<string>) => {
      let event: EventEnvelope;
      try {
        event = JSON.parse(message.data) as EventEnvelope;
      } catch {
        return;
      }

      history.pushLive(event);

      if (isStructural(event)) {
        // O que o próprio evento afirma entra já; a verdade do daemon chega na
        // recarga agrupada logo depois.
        setSessions((prev) => patchSessionsFromEvent(prev, event) as SessionSummary[]);
        const root = sessionsRef.current.find((s) => s.id === event.sessionId)?.rootId;
        touchedRoots.current.add(root ?? ANY_ROOT);
        schedulerRef.current?.request();
      }
    };

    return () => {
      source.close();
    };
  }, [history, loadFull]);

  // `historyVersion` nas dependências troca a identidade destas funções quando
  // qualquer timeline muda — é o que faz o `useMemo` da timeline recalcular.
  const eventsOf = useCallback(
    (sessionId: string) => {
      if (!sessionId) return [];
      if (history.history(sessionId).status === 'idle') {
        // Fora do render: a busca notifica o React, e notificar durante o
        // render de quem pediu é o que o React proíbe.
        queueMicrotask(() => history.ensure(sessionId));
      }
      return history.events(sessionId);
    },
    [history, historyVersion],
  );

  const eventsFailedFor = useCallback(
    (sessionId: string) => history.history(sessionId).status === 'failed',
    [history, historyVersion],
  );

  const historyOf = useCallback(
    (sessionId: string) => history.history(sessionId),
    [history, historyVersion],
  );

  const loadOlder = useCallback((sessionId: string) => void history.loadOlder(sessionId), [history]);
  const retryEvents = useCallback((sessionId: string) => history.retry(sessionId), [history]);

  const revisionOf = useCallback(
    (rootId: string | null) => revision + (rootId ? rootRevisions[rootId] ?? 0 : 0),
    [revision, rootRevisions],
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
      historyOf,
      loadOlder,
      retryEvents,
      revision,
      revisionOf,
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
      historyOf,
      loadOlder,
      retryEvents,
      revision,
      revisionOf,
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

/** Situação agregada do histórico de uma ou mais sessões mostradas juntas. */
export interface TimelineStatus {
  loading: boolean;
  failed: boolean;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  /** A tentativa automática mais próxima, ou `null` quando não há nenhuma. */
  retryAt: number | null;
  loadOlder: () => void;
  retry: () => void;
}

/**
 * Junta o estado do histórico das sessões na tela ("Esta sessão" é uma só;
 * "Fluxo inteiro", as irmãs). Carregar anteriores pede a página de cada uma
 * que ainda tem o que dar; tentar de novo refaz só as que falharam.
 */
export function timelineStatus(state: HubState, sessionIds: readonly string[]): TimelineStatus {
  const entries = sessionIds.map((id) => [id, state.historyOf(id)] as const);
  const retries = entries
    .map(([, h]) => h.nextRetryAt)
    .filter((t): t is number => t !== null);
  return {
    loading: entries.some(([, h]) => h.status === 'idle' || h.status === 'loading'),
    failed: entries.some(([, h]) => h.status === 'failed'),
    hasMoreBefore: entries.some(([, h]) => h.hasMoreBefore),
    loadingOlder: entries.some(([, h]) => h.loadingOlder),
    olderFailed: entries.some(([, h]) => h.olderFailed),
    retryAt: retries.length > 0 ? Math.min(...retries) : null,
    loadOlder: () => {
      for (const [id, h] of entries) if (h.hasMoreBefore) state.loadOlder(id);
    },
    retry: () => {
      for (const [id, h] of entries) if (h.status === 'failed') state.retryEvents(id);
    },
  };
}
