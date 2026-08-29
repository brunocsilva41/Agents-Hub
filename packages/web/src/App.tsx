import React, { useMemo, useState } from 'react';
import type { BudgetSummary, SessionSummary } from '@agents-hub/client';
import { Approvals } from './components/Approvals';
import { Composer } from './components/Composer';
import { FlowList } from './components/FlowList';
import { SessionModal } from './components/SessionModal';
import { ProjectModal } from './components/ProjectModal';
import { SettingsView } from './components/SettingsView';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { CommandPalette } from './components/CommandPalette';
import { AgentSwarmView } from './components/AgentSwarmView';
import { DagCanvasView } from './components/DagCanvasView';
import { TelemetryView } from './components/TelemetryView';
import { agentColor, formatAgo, isLiveState, STATE_LABEL, hub } from './hub';
import { useHubState } from './useHubState';

type ActiveTab = 'timeline' | 'dag' | 'swarm' | 'telemetry' | 'settings';

export function App() {
  const state = useHubState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<'session' | 'flow'>('session');
  const [verbose, setVerbose] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [budget, setBudget] = useState<BudgetSummary | null>(null);

  const [modal, setModal] = useState<{ delegateFrom: { sessionId: string; agentId: string } | null; defaultAgentId?: string } | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [cmdOpen, setCmdOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('timeline');
  const [flowFilter, setFlowFilter] = useState<'active' | 'all'>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const selected: SessionSummary | null = useMemo(
    () => (selectedId ? state.sessions.find((s) => s.id === selectedId) ?? null : null),
    [selectedId, state.sessions],
  );

  const events = useMemo(() => {
    if (!selected) return [];
    if (scope === 'session') return state.eventsOf(selected.id);
    const rootId = selected.rootId ?? selected.id;
    const siblings = state.sessions.filter((s) => s.rootId === rootId || s.id === rootId);
    const merged = siblings.flatMap((s) => state.eventsOf(s.id));
    return merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }, [selected, scope, state]);

  // Carrega orçamento da sessão ativa
  React.useEffect(() => {
    if (!selected) {
      setBudget(null);
      return;
    }
    let cancel = false;
    hub.budget(selected.id).then((b) => {
      if (!cancel) setBudget(b.budget);
    }).catch(() => {
      if (!cancel) setBudget(null);
    });
    return () => { cancel = true; };
  }, [selected?.id, state.revision]);

  const toggleFlow = (rootId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  const selectSession = (id: string) => {
    setSelectedId(id);
    setFlowsOpen(false);
  };

  // Filtragem dos fluxos (por projeto, por status e por busca)
  const filteredFlows = useMemo(() => {
    return state.flows.filter((flow) => {
      // Filtro por projeto
      if (selectedProjectId !== 'all') {
        const matchesProject = flow.sessions.some((s) => s.projectId === selectedProjectId);
        if (!matchesProject) return false;
      }

      if (flowFilter === 'active') {
        const hasLive = flow.sessions.some((s) => isLiveState(s.state));
        if (!hasLive) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesAgent = flow.agents.some((a) => a.toLowerCase().includes(q));
        const matchesTitle = flow.sessions.some((s) => (s.title ?? '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
        if (!matchesAgent && !matchesTitle) return false;
      }
      return true;
    });
  }, [state.flows, selectedProjectId, flowFilter, searchQuery]);

  const activeSessionsCount = state.sessions.filter((s) => isLiveState(s.state)).length;

  return (
    <div className={`app${panelOpen ? ' panel-open' : ''}${flowsOpen ? ' flows-open' : ''}`}>
      {/* 1. Header / Command Bar */}
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="drawer-toggle flows-toggle"
            aria-expanded={flowsOpen}
            onClick={() => setFlowsOpen((v) => !v)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          <div className="brand" onClick={() => setActiveTab('timeline')}>
            <div className="brand-logo-icon">⚡</div>
            <div className="brand-text">
              <span className="brand-badge">AGENTS</span>
              <span className="brand-hub">HUB</span>
            </div>
            <span className="brand-version">v0.1</span>
          </div>

          {/* Navigation Tabs */}
          <nav className="nav-tabs" role="tablist">
            <button
              className={`nav-tab ${activeTab === 'timeline' ? 'active' : ''}`}
              onClick={() => setActiveTab('timeline')}
            >
              <span className="tab-icon">💬</span>
              <span>Timeline</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'dag' ? 'active' : ''}`}
              onClick={() => setActiveTab('dag')}
            >
              <span className="tab-icon">🕸</span>
              <span>Grafo DAG</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'swarm' ? 'active' : ''}`}
              onClick={() => setActiveTab('swarm')}
            >
              <span className="tab-icon">🤖</span>
              <span>Swarm ({state.agents.length})</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'telemetry' ? 'active' : ''}`}
              onClick={() => setActiveTab('telemetry')}
            >
              <span className="tab-icon">📊</span>
              <span>Telemetria</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              <span className="tab-icon">⚙️</span>
              <span>Configurações</span>
            </button>
          </nav>
        </div>

        <div className="topbar-center">
          <button className="spotlight-btn" onClick={() => setCmdOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span>Buscar sessões, agentes, comandos…</span>
            <kbd className="kbd-shortcut">⌘K</kbd>
          </button>
        </div>

        <div className="topbar-right">
          {/* Status Indicator */}
          <div className={`pill status ${state.connected ? 'on' : 'off-air'}`}>
            <span className={`radar-dot ${state.connected ? 'running' : 'failed'}`}>
              <span className="radar-pulse" />
            </span>
            <span className="status-text">{state.connected ? `${activeSessionsCount} Ao Vivo` : 'Desconectado'}</span>
          </div>

          <button
            className="drawer-toggle panel-toggle"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            Painel
          </button>

          <button
            className="primary btn-hero-new"
            onClick={() => setModal({ delegateFrom: null })}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>Nova Sessão</span>
          </button>
        </div>
      </header>

      {/* Pending Approvals */}
      <Approvals
        approvals={state.approvals}
        sessions={state.sessions}
        onSelectSession={selectSession}
        onResolved={() => state.refresh()}
      />

      {/* 2. Main Body Content Area */}
      {activeTab === 'settings' ? (
        <main className="tab-view-container">
          <SettingsView agents={state.agents} projects={state.projects} />
        </main>
      ) : activeTab === 'swarm' ? (
        <main className="tab-view-container">
          <AgentSwarmView
            agents={state.agents}
            onNewSession={(agentId) => setModal({ delegateFrom: null, defaultAgentId: agentId })}
          />
        </main>
      ) : activeTab === 'dag' ? (
        <main className="tab-view-container">
          <DagCanvasView
            flows={state.flows}
            selectedId={selectedId}
            onSelectSession={(id) => {
              selectSession(id);
              setActiveTab('timeline');
            }}
            onNewSession={() => setModal({ delegateFrom: null })}
          />
        </main>
      ) : activeTab === 'telemetry' ? (
        <main className="tab-view-container">
          <TelemetryView
            sessions={state.sessions}
            flows={state.flows}
            agents={state.agents}
          />
        </main>
      ) : (
        /* Timeline 3-Column Layout */
        <div className="columns">
          {/* Coluna Esquerda: Fluxos */}
          <aside className="col col-left" aria-label="Navegação de fluxos">
            {/* Seletor de Projetos */}
            <div className="sidebar-project-selector">
              <div className="project-select-header">
                <span className="project-select-label">📁 PROJETO</span>
                <button
                  type="button"
                  className="linkish btn-add-project"
                  onClick={() => setProjectModalOpen(true)}
                  title="Vincular nova pasta como projeto"
                >
                  + Nova Pasta
                </button>
              </div>
              <select
                className="project-dropdown"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
              >
                <option value="all">Todos os Projetos ({state.projects.length})</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-header flow-sidebar-header">
              <div className="seg">
                <button
                  className={flowFilter === 'active' ? 'on' : ''}
                  onClick={() => setFlowFilter('active')}
                >
                  Ativos <span className="seg-count">{filteredFlows.filter((f) => f.sessions.some((s) => isLiveState(s.state))).length}</span>
                </button>
                <button
                  className={flowFilter === 'all' ? 'on' : ''}
                  onClick={() => setFlowFilter('all')}
                >
                  Todos <span className="seg-count">{filteredFlows.length}</span>
                </button>
              </div>

              <div className="sidebar-quick-actions">
                <button
                  className="btn-icon-subtle"
                  title="Nova Sessão"
                  onClick={() => setModal({ delegateFrom: null })}
                >
                  +
                </button>
              </div>
            </div>

            <div className="sidebar-search-wrap">
              <input
                type="text"
                className="sidebar-search-input"
                placeholder="Filtrar fluxos ou agentes…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="scroll">
              <FlowList
                flows={filteredFlows}
                selectedId={selectedId}
                selectedRootId={selected?.rootId ?? null}
                expanded={expanded}
                onToggle={toggleFlow}
                onSelect={selectSession}
                revision={state.revision}
              />
            </div>
          </aside>

          {/* Coluna Central: Timeline */}
          <main className="col col-center" aria-label="Timeline">
            <div className="col-header timeline-header">
              {selected ? (
                <div className="session-head">
                  <div
                    className="session-avatar-dot"
                    style={{ background: agentColor(selected.agentId) }}
                  >
                    {selected.agentId.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="session-meta-stack">
                    <div className="session-title-line">
                      <span className="session-agent-pill" style={{ color: agentColor(selected.agentId) }}>
                        {selected.agentId}
                      </span>
                      <span className={`session-state-pill state-${selected.state}`}>
                        {STATE_LABEL[selected.state] ?? selected.state}
                      </span>
                      <span className="session-title" title={selected.title ?? undefined}>
                        {selected.title}
                      </span>
                    </div>
                    <div className="session-sub-line">
                      <span className="session-id-mono">{selected.id}</span>
                      <span>·</span>
                      <span className="session-when">{formatAgo(selected.updatedAt)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="session-head">
                  <span className="timeline-title-empty">Selecione uma sessão ao lado</span>
                </div>
              )}

              <div className="head-actions">
                <div className="seg" role="group" aria-label="Abrangência da timeline">
                  <button
                    className={scope === 'session' ? 'on' : ''}
                    aria-pressed={scope === 'session'}
                    onClick={() => setScope('session')}
                  >
                    Esta sessão
                  </button>
                  <button
                    className={scope === 'flow' ? 'on' : ''}
                    aria-pressed={scope === 'flow'}
                    onClick={() => setScope('flow')}
                  >
                    Fluxo inteiro
                  </button>
                </div>

                <div className="seg" role="group" aria-label="Nível de detalhe">
                  <button
                    className={!verbose ? 'on' : ''}
                    aria-pressed={!verbose}
                    onClick={() => setVerbose(false)}
                  >
                    Resumido
                  </button>
                  <button
                    className={verbose ? 'on' : ''}
                    aria-pressed={verbose}
                    onClick={() => setVerbose(true)}
                  >
                    Detalhado
                  </button>
                </div>
              </div>
            </div>

            <div className="timeline-wrap">
              <Timeline
                events={events}
                showVerbose={verbose}
                showAgent={scope === 'flow'}
                loading={!state.ready}
              />

              {selected && (
                <Composer session={selected} encerrada={!isLiveState(selected.state)} />
              )}
            </div>
          </main>

          {/* Coluna Direita: Controles e Custo */}
          <aside className="col col-right" aria-label="Controles e telemetria">
            <SidePanel
              session={selected}
              budget={budget}
              agents={state.agents}
              onDelegate={() => {
                if (selected) {
                  setModal({
                    delegateFrom: { sessionId: selected.id, agentId: selected.agentId },
                  });
                }
              }}
              onChanged={() => state.refresh()}
            />
          </aside>
        </div>
      )}

      {/* Modais */}
      {modal && (
        <SessionModal
          agents={state.agents}
          delegateFrom={modal.delegateFrom}
          defaultAgentId={modal.defaultAgentId}
          onClose={() => setModal(null)}
          onCreated={(sessionId) => {
            setModal(null);
            setSelectedId(sessionId);
            setActiveTab('timeline');
            void state.refresh();
          }}
          onNewProject={() => {
            setProjectModalOpen(true);
          }}
        />
      )}

      {projectModalOpen && (
        <ProjectModal
          onClose={() => setProjectModalOpen(false)}
          onCreated={(projectId) => {
            setProjectModalOpen(false);
            setSelectedProjectId(projectId);
            void state.refresh();
          }}
        />
      )}

      {cmdOpen && (
        <CommandPalette
          isOpen={cmdOpen}
          onClose={() => setCmdOpen(false)}
          sessions={state.sessions}
          agents={state.agents}
          onSelectSession={(id) => {
            selectSession(id);
            setActiveTab('timeline');
          }}
          onNewSession={(agentId) => {
            setModal({ delegateFrom: null, defaultAgentId: agentId });
          }}
        />
      )}

      <Toasts />
    </div>
  );
}
