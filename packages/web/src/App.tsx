import { useCallback, useEffect, useMemo, useState } from 'react';
import { Approvals } from './components/Approvals';
import { Composer } from './components/Composer';
import { FlowList } from './components/FlowList';
import { SessionModal } from './components/SessionModal';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { agentColor, formatAgo, isLiveState, STATE_LABEL } from './hub';
import {
  mergeEvents,
  mergeFlowEvents,
  useBudget,
  useFlowHistories,
  useHubState,
  useSessionHistory,
} from './useHubState';

type Filter = 'ativos' | 'todos';

export function App() {
  const state = useHubState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<'session' | 'flow'>('session');
  const [verbose, setVerbose] = useState(false);
  const [filter, setFilter] = useState<Filter>('ativos');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [modal, setModal] = useState<null | {
    delegateFrom: { sessionId: string; agentId: string } | null;
  }>(null);

  const selected = useMemo(
    () => state.sessions.find((s) => s.id === selectedId) ?? null,
    [state.sessions, selectedId],
  );

  /**
   * Sem seleção, abre o que pede atenção.
   *
   * A sessão mais recente não é a mais interessante: se uma sessão está parada
   * esperando decisão, é ela que a pessoa veio ver.
   */
  useEffect(() => {
    if (selectedId !== null || state.sessions.length === 0) return;
    const urgent =
      state.sessions.find((s) => s.state === 'waiting_approval') ??
      state.sessions.find((s) => isLiveState(s.state)) ??
      state.sessions[0];
    setSelectedId(urgent?.id ?? null);
  }, [state.sessions, selectedId]);

  const { history, loading: historyLoading } = useSessionHistory(selectedId);
  const budget = useBudget(selected?.rootId ?? null, state.revision);

  /**
   * Só os fluxos que interessam agora.
   *
   * A lista tinha 29 blocos abertos, quase todos de sessões encerradas há dias.
   * O filtro padrão é "ativos" porque um plano de controle responde à pergunta
   * "o que está acontecendo", não "o que já aconteceu".
   */
  const flows = useMemo(() => {
    if (filter === 'todos') return state.flows;
    const visible = state.flows.filter(
      (f) => f.live || f.sessions.some((s) => s.id === selectedId),
    );
    return visible;
  }, [state.flows, filter, selectedId]);

  const liveCount = useMemo(() => state.flows.filter((f) => f.live).length, [state.flows]);

  // As gavetas cobrem a tela numa janela estreita; Esc as fecha, como qualquer
  // sobreposição.
  useEffect(() => {
    if (!panelOpen && !flowsOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setPanelOpen(false);
      setFlowsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen, flowsOpen]);

  // Escolher uma sessão na gaveta é o fim da tarefa dela: deixá-la aberta
  // esconderia justamente a timeline que a pessoa acabou de pedir.
  const selectSession = useCallback((sessionId: string) => {
    setSelectedId(sessionId);
    setFlowsOpen(false);
  }, []);

  const toggleFlow = useCallback((rootId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }, []);

  /** Sessões incluídas na timeline: só a atual, ou o fluxo inteiro. */
  const timelineSessions = useMemo(() => {
    if (!selected) return [];
    if (scope === 'session') return [selected.id];
    return state.sessions.filter((s) => s.rootId === selected.rootId).map((s) => s.id);
  }, [selected, scope, state.sessions]);

  const flowHistories = useFlowHistories(timelineSessions, scope === 'flow');

  // Depende de `eventsOf`, e não do objeto de estado inteiro: qualquer outra
  // mudança do Hub — uma aprovação resolvida, um agente sondado — não pode
  // custar um recálculo da timeline.
  const eventsOf = state.eventsOf;
  const events = useMemo(() => {
    if (!selected) return [];
    if (scope === 'session') return mergeEvents(history, eventsOf(selected.id));
    return mergeFlowEvents([...timelineSessions.map(eventsOf), ...flowHistories, history]);
  }, [selected, scope, history, eventsOf, timelineSessions, flowHistories]);

  /** Sessão terminada não aceita mais mensagem — o daemon recusa, e com razão. */
  const encerrada =
    selected !== null &&
    (selected.state === 'completed' || selected.state === 'failed' || selected.state === 'killed');

  return (
    <div className={`app${panelOpen ? ' panel-open' : ''}${flowsOpen ? ' flows-open' : ''}`}>
      <header className="topbar">
        <button
          className="drawer-toggle flows-toggle"
          aria-expanded={flowsOpen}
          onClick={() => setFlowsOpen((v) => !v)}
        >
          Fluxos
        </button>

        <div className="brand">
          Agents<span>-Hub</span>
        </div>

        <div className="agent-pills" aria-label="Agentes conhecidos">
          {state.agents.map((agent) => {
            const running = state.sessions.filter(
              (s) => s.agentId === agent.id && isLiveState(s.state),
            ).length;
            const off = agent.probe?.installed !== true;
            return (
              <span
                key={agent.id}
                className={`pill${off ? ' off' : ''}${running > 0 ? ' busy' : ''}`}
                title={
                  off
                    ? `${agent.name} — não instalado`
                    : `${agent.name} ${agent.probe?.version ?? ''} — ${running} sessão(ões) em curso`
                }
              >
                <span
                  className="dot"
                  aria-hidden="true"
                  style={{ background: off ? 'var(--text-faint)' : agentColor(agent.id) }}
                />
                {agent.id}
                {/* O número de sessões vivas é a única informação operacional
                    que esta barra pode dar: "instalado" a pessoa já sabe. */}
                {running > 0 && <span className="pill-count">{running}</span>}
              </span>
            );
          })}
        </div>

        <span
          className={`pill status ${state.connected ? 'on' : 'off-air'}`}
          role="status"
          aria-live="polite"
          title={state.connected ? 'stream ao vivo conectado' : 'reconectando ao daemon'}
        >
          <span className={`dot ${state.connected ? 'running' : 'failed'}`} aria-hidden="true" />
          {state.connected ? 'ao vivo' : 'desconectado'}
        </span>

        <button
          className="drawer-toggle panel-toggle"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}
        >
          Custo e controles
        </button>

        <button className="primary" onClick={() => setModal({ delegateFrom: null })}>
          Nova sessão
        </button>
      </header>

      {/* Falar com o daemon é pré-requisito de tudo o que a tela mostra: o erro
          é global e fica no topo, não escondido dentro da coluna de fluxos. */}
      {state.error && (
        <div className="global-error" role="alert">
          <strong>Sem contato com o Hub.</strong> {state.error}
          <button className="linkish" onClick={() => void state.refresh()}>
            tentar de novo
          </button>
        </div>
      )}

      <Approvals
        approvals={state.approvals}
        sessions={state.sessions}
        onResolved={() => void state.refresh()}
        onSelectSession={selectSession}
      />

      <div className="columns">
        <aside className="col col-left" aria-label="Fluxos">
          <div className="col-header">
            <span>Fluxos</span>
            <span className="seg" role="group" aria-label="Filtrar fluxos">
              <button
                className={filter === 'ativos' ? 'on' : ''}
                aria-pressed={filter === 'ativos'}
                onClick={() => setFilter('ativos')}
              >
                ativos {liveCount > 0 && <span className="seg-count">{liveCount}</span>}
              </button>
              <button
                className={filter === 'todos' ? 'on' : ''}
                aria-pressed={filter === 'todos'}
                onClick={() => setFilter('todos')}
              >
                todos <span className="seg-count">{state.flows.length}</span>
              </button>
            </span>
          </div>

          <div className="scroll">
            {!state.ready && (
              <div className="empty" role="status">
                carregando fluxos…
              </div>
            )}

            {state.ready && flows.length === 0 && (
              <div className="empty">
                {state.flows.length === 0 ? (
                  <>
                    nenhuma sessão ainda.
                    <br />
                    <span className="empty-hint">comece uma para ver o grafo aqui.</span>
                  </>
                ) : (
                  <>
                    nenhum fluxo em andamento.
                    <br />
                    <button className="linkish" onClick={() => setFilter('todos')}>
                      ver os {state.flows.length} fluxos encerrados
                    </button>
                  </>
                )}
              </div>
            )}

            <FlowList
              flows={flows}
              selectedId={selectedId}
              selectedRootId={selected?.rootId ?? null}
              expanded={expanded}
              onToggle={toggleFlow}
              onSelect={selectSession}
              revision={state.revision}
            />
          </div>
        </aside>

        <main className="col col-center" aria-label="Timeline">
          <div className="col-header">
            {selected ? (
              <span className="session-head">
                <span className={`dot ${selected.state}`} aria-hidden="true" />
                <span className="session-agent" style={{ color: agentColor(selected.agentId) }}>
                  {selected.agentId}
                </span>
                <span className="session-state">
                  {STATE_LABEL[selected.state] ?? selected.state}
                </span>
                <span className="session-title" title={selected.title ?? undefined}>
                  {selected.title}
                </span>
                <span className="session-when">{formatAgo(selected.updatedAt)}</span>
              </span>
            ) : (
              <span>Timeline</span>
            )}

            <span className="head-actions">
              <span className="seg" role="group" aria-label="Abrangência da timeline">
                <button
                  className={scope === 'session' ? 'on' : ''}
                  aria-pressed={scope === 'session'}
                  onClick={() => setScope('session')}
                >
                  esta sessão
                </button>
                <button
                  className={scope === 'flow' ? 'on' : ''}
                  aria-pressed={scope === 'flow'}
                  onClick={() => setScope('flow')}
                  title="junta as timelines de todos os agentes do fluxo"
                >
                  fluxo inteiro
                </button>
              </span>
              <span className="seg" role="group" aria-label="Nível de detalhe">
                <button
                  className={!verbose ? 'on' : ''}
                  aria-pressed={!verbose}
                  onClick={() => setVerbose(false)}
                >
                  resumido
                </button>
                <button
                  className={verbose ? 'on' : ''}
                  aria-pressed={verbose}
                  onClick={() => setVerbose(true)}
                  title="mostra raciocínio, deltas e logs internos"
                >
                  detalhado
                </button>
              </span>
            </span>
          </div>

          {selected ? (
            <Timeline
              events={events}
              showVerbose={verbose}
              showAgent={scope === 'flow'}
              loading={historyLoading && events.length === 0}
            />
          ) : (
            <div className="empty">
              selecione uma sessão à esquerda
              <br />
              <span className="empty-hint">
                o grafo é a navegação: clicar num nó abre a timeline daquele agente.
              </span>
            </div>
          )}

          {selected && <Composer session={selected} encerrada={encerrada} />}
        </main>

        <aside className="col col-right" aria-label="Custo e controles">
          <SidePanel
            session={selected}
            budget={budget}
            agents={state.agents}
            onDelegate={() =>
              selected &&
              setModal({ delegateFrom: { sessionId: selected.id, agentId: selected.agentId } })
            }
            onChanged={() => void state.refresh()}
          />
        </aside>
      </div>

      {modal && (
        <SessionModal
          agents={state.agents}
          delegateFrom={modal.delegateFrom}
          onClose={() => setModal(null)}
          onCreated={(sessionId) => {
            setSelectedId(sessionId);
            void state.refresh();
          }}
        />
      )}

      <Toasts />
    </div>
  );
}
