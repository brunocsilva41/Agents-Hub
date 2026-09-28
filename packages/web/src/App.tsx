import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@agents-hub/client';
import { Approvals } from './components/Approvals';
import { Composer } from './components/Composer';
import { FlowList } from './components/FlowList';
import { SessionModal } from './components/SessionModal';
import { ProjectModal } from './components/ProjectModal';
import { SettingsView } from './components/SettingsView';
import { SecurityView } from './components/SecurityView';
import { podeTrocarDeAba } from './logic/security';
import { Onboarding } from './components/Onboarding';
import { precisaDeBoasVindas } from './logic/settings-form';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { CommandPalette, rotuloAtalhoPaleta } from './components/CommandPalette';
import { TopbarMenu, type OpcaoDeAba } from './components/TopbarMenu';
import { focaveisEm, haDialogoAberto } from './useDialog';
import { useMediaQuery } from './useMediaQuery';
import { useTema } from './theme';
import { AgentSwarmView } from './components/AgentSwarmView';
import { DagCanvasView } from './components/DagCanvasView';
import { TelemetryView } from './components/TelemetryView';
import { OperationView } from './components/OperationView';
import { EstadoDaTela } from './components/EstadoDaTela';
import { agentColor, formatAgo, isLiveState, STATE_LABEL } from './hub';
import {
  alternarFluxo,
  aoSelecionarFluxo,
  LISTA_INICIAL,
  type EstadoDaLista,
} from './lib/flowListState';
import { falhaDosRecursos, situacaoDaTela, type Recurso } from './lib/indexStatus';
import {
  useHubState,
  useBudget,
  mergeFlowEvents,
  MAX_FLOW_HISTORIES,
  timelineStatus,
} from './useHubState';

type ActiveTab = 'timeline' | 'dag' | 'swarm' | 'telemetry' | 'operation' | 'settings' | 'security';

export function App() {
  const state = useHubState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<'session' | 'flow'>('session');
  const [verbose, setVerbose] = useState(false);
  const [listaDeFluxos, setListaDeFluxos] = useState<EstadoDaLista>(LISTA_INICIAL);

  const [modal, setModal] = useState<{
    delegateFrom: { sessionId: string; agentId: string } | null;
    defaultAgentId?: string;
  } | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [cmdOpen, setCmdOpen] = useState(false);
  const [activeTab, setAbaAtiva] = useState<ActiveTab>('timeline');

  // Edição não salva por área (Configurações, editor de política). Trocar de
  // aba desmonta a área e a edição sumia sem aviso (vistoria 03): TODA troca
  // de aba passa por aqui e pergunta antes. Ref, não estado — marcar "sujo" a
  // cada tecla não precisa re-renderizar o App.
  const sujosRef = useRef<Record<string, boolean>>({});
  const abaAtualRef = useRef<ActiveTab>('timeline');
  abaAtualRef.current = activeTab;
  const setActiveTab = useCallback((destino: ActiveTab): boolean => {
    const ok = podeTrocarDeAba(abaAtualRef.current, destino, sujosRef.current, () =>
      window.confirm('Há alterações não salvas nesta aba. Sair e descartá-las?'),
    );
    if (!ok) return false;
    if (destino !== abaAtualRef.current) sujosRef.current = {};
    setAbaAtiva(destino);
    return true;
  }, []);
  const marcarSujoConfig = useCallback((sujo: boolean) => {
    sujosRef.current = { ...sujosRef.current, settings: sujo };
  }, []);
  const marcarSujoSeguranca = useCallback((sujo: boolean) => {
    sujosRef.current = { ...sujosRef.current, security: sujo };
  }, []);
  const [flowFilter, setFlowFilter] = useState<'active' | 'all'>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [boasVindasDispensadas, setBoasVindasDispensadas] = useState(false);

  const selected: SessionSummary | null = useMemo(
    () => (selectedId ? (state.sessions.find((s) => s.id === selectedId) ?? null) : null),
    [selectedId, state.sessions],
  );

  const siblings = useMemo(() => {
    if (!selected || scope !== 'flow') return [];
    const rootId = selected.rootId ?? selected.id;
    const all = state.sessions.filter((s) => s.rootId === rootId || s.id === rootId);
    // Teto de sessões-irmãs buscadas de uma vez: sem isto, um fluxo com 30+
    // sub-sessões dispara uma requisição HTTP simultânea por sessão-irmã ao
    // abrir "Fluxo inteiro". Ficam as mais recentes, que é o que se está lendo.
    return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_FLOW_HISTORIES);
  }, [selected, scope, state.sessions]);

  const events = useMemo(() => {
    if (!selected) return [];
    if (scope === 'session') return state.eventsOf(selected.id);
    // `seq` só é monotônico DENTRO de uma sessão; intercalar streams de agentes
    // diferentes por `seq` embaralha a ordem cronológica real. `mergeFlowEvents`
    // ordena por timestamp entre sessões (ver useHubState.ts).
    return mergeFlowEvents(siblings.map((s) => state.eventsOf(s.id)));
  }, [selected, scope, siblings, state]);

  // Falha de rede na busca de eventos é indistinguível de "sessão sem
  // eventos" sem este sinal à parte — sem ele a timeline mostra "nenhum
  // evento" tanto para uma sessão genuinamente vazia quanto para uma falha de
  // rede (daemon reiniciando, conexão instável).
  const eventsFailed = useMemo(() => {
    if (!selected) return false;
    if (scope === 'session') return state.eventsFailedFor(selected.id);
    return siblings.some((s) => state.eventsFailedFor(s.id));
  }, [selected, scope, siblings, state]);

  // Histórico das sessões na tela: carregando, há anteriores, próxima tentativa.
  const timeline = useMemo(() => {
    if (!selected) return null;
    return timelineStatus(state, scope === 'session' ? [selected.id] : siblings.map((s) => s.id));
  }, [selected, scope, siblings, state]);

  // Orçamento da sessão ativa: o ledger é chaveado pela RAIZ do fluxo, não pela
  // sessão selecionada — buscar por `selected.id` numa sub-sessão delegada
  // criava (ou lia) um ledger órfão, sempre zerado. `useBudget` já busca pela
  // raiz correta.
  const budgetRoot = selected?.rootId ?? selected?.id ?? null;
  const budget = useBudget(budgetRoot, state.revisionOf(budgetRoot));

  // O fluxo selecionado abre sozinho, mas pode ser recolhido (lib/flowListState).
  const selectedRootId = selected?.rootId ?? null;
  const toggleFlow = (rootId: string) => {
    setListaDeFluxos((prev) => alternarFluxo(prev, rootId, selectedRootId));
  };

  const selectSession = (id: string) => {
    setSelectedId(id);
    setFlowsOpen(false);
    const root = state.sessions.find((s) => s.id === id)?.rootId ?? null;
    setListaDeFluxos((prev) => aoSelecionarFluxo(prev, root));
  };

  // Situação do índice por tela: carregando/erro não pode virar "vazio".
  const situacaoDe = (recursos: Recurso[], vazia: boolean) =>
    situacaoDaTela(state.indice, recursos, vazia);
  const erroDe = (recursos: Recurso[]) => falhaDosRecursos(state.indice, recursos);
  const tentarDeNovo = () => void state.refresh();
  const situacaoSessoes = situacaoDe(['sessions'], state.sessions.length === 0);
  /** Aviso no topo das abas de formulário, que dependem de vários recursos. */
  const avisoDoIndice = (recursos: Recurso[], oQue: string) => {
    const s = situacaoDe(recursos, false);
    return s === 'erro' ? (
      <EstadoDaTela situacao={s} oQue={oQue} erro={erroDe(recursos)} onTentar={tentarDeNovo} compacto />
    ) : null;
  };

  // Gavetas (colunas que viram painel deslizante em tela estreita).
  //
  // Antes as duas abriam juntas e se empilhavam uma sobre a outra, e fechadas
  // continuavam na ordem de Tab (só um `transform` as tirava da tela). Agora
  // abrir uma fecha a outra, a fechada fica `inert` e Esc/fundo fecham.
  // Os valores têm de bater com os `@media` do CSS.
  const painelEhGaveta = useMediaQuery('(max-width: 1200px)');
  const fluxosEhGaveta = useMediaQuery('(max-width: 768px)');
  const fluxosToggleRef = useRef<HTMLButtonElement>(null);
  const painelToggleRef = useRef<HTMLButtonElement>(null);
  const colunaFluxosRef = useRef<HTMLElement>(null);
  const colunaPainelRef = useRef<HTMLElement>(null);
  const fluxosGavetaAberta = fluxosEhGaveta && flowsOpen && activeTab === 'timeline';
  const painelGavetaAberto = painelEhGaveta && panelOpen && activeTab === 'timeline';

  const alternarFluxos = () => {
    const abrir = !(flowsOpen && activeTab === 'timeline');
    if (!setActiveTab('timeline')) return;
    setFlowsOpen(abrir);
    if (abrir) setPanelOpen(false);
  };

  const alternarPainel = () => {
    const abrir = !(panelOpen && activeTab === 'timeline');
    if (!setActiveTab('timeline')) return;
    setPanelOpen(abrir);
    if (abrir) setFlowsOpen(false);
  };

  const fecharGavetas = (devolverFoco: boolean) => {
    const voltarPara = fluxosGavetaAberta ? fluxosToggleRef.current : painelToggleRef.current;
    setFlowsOpen(false);
    setPanelOpen(false);
    if (devolverFoco) voltarPara?.focus();
  };

  // Gaveta que acabou de abrir recebe o foco: quem abriu pelo teclado continua
  // no lugar certo em vez de ter de atravessar a timeline inteira.
  useEffect(() => {
    if (fluxosGavetaAberta && colunaFluxosRef.current) focaveisEm(colunaFluxosRef.current)[0]?.focus();
  }, [fluxosGavetaAberta]);
  useEffect(() => {
    if (painelGavetaAberto && colunaPainelRef.current) focaveisEm(colunaPainelRef.current)[0]?.focus();
  }, [painelGavetaAberto]);

  const { tema, alternar: alternarTema } = useTema();
  const atalhoPaleta = useMemo(() => rotuloAtalhoPaleta(), []);

  // Atalhos globais. Ctrl/⌘+K alterna a paleta — o listener mora AQUI porque a
  // paleta só existe depois de aberta (o que morava nela nunca abria nada).
  // Não abre por cima de outro modal: roubaria o foco de um formulário.
  const estadoAtalhos = useRef({ gavetaAberta: false, fecharGavetas });
  estadoAtalhos.current = { gavetaAberta: fluxosGavetaAberta || painelGavetaAberto, fecharGavetas };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((aberta) => (aberta ? false : !haDialogoAberto()));
        return;
      }
      if (e.key === 'Escape' && !haDialogoAberto() && estadoAtalhos.current.gavetaAberta) {
        e.preventDefault();
        estadoAtalhos.current.fecharGavetas(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        const matchesTitle = flow.sessions.some(
          (s) => (s.title ?? '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
        );
        if (!matchesAgent && !matchesTitle) return false;
      }
      return true;
    });
  }, [state.flows, selectedProjectId, flowFilter, searchQuery]);

  const activeSessionsCount = state.sessions.filter((s) => isLiveState(s.state)).length;

  const abas: Array<OpcaoDeAba<ActiveTab>> = [
    { id: 'timeline', rotulo: 'Timeline', icone: '💬' },
    { id: 'dag', rotulo: 'Grafo DAG', icone: '🕸' },
    { id: 'swarm', rotulo: `Swarm (${state.agents.length})`, icone: '🤖' },
    { id: 'telemetry', rotulo: 'Telemetria', icone: '📊' },
    { id: 'operation', rotulo: 'Operação', icone: '🛠' },
    { id: 'settings', rotulo: 'Configurações', icone: '⚙️' },
    { id: 'security', rotulo: 'Segurança', icone: '🔐' },
  ];

  return (
    <div className={`app${panelOpen ? ' panel-open' : ''}${flowsOpen ? ' flows-open' : ''}`}>
      {/* 1. Topbar.
          Encolhe em degraus (ver "TOPBAR RESPONSIVA" no CSS): abaixo de 1200 px
          as abas ficam só com ícone, abaixo de 1000 a busca vira ícone, abaixo
          de 768 as ações também, e abaixo de 600 as abas e o tema vão para o
          menu "Mais opções". Os rótulos escondidos continuam no nome acessível
          (`.rotulo-compacto` recorta, não remove). */}
      <header className="topbar">
        <div className="topbar-left">
          <button
            ref={fluxosToggleRef}
            type="button"
            className="drawer-toggle flows-toggle"
            aria-label="Fluxos"
            aria-expanded={flowsOpen && fluxosEhGaveta}
            aria-controls="coluna-fluxos"
            onClick={alternarFluxos}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          <button
            type="button"
            className="brand"
            aria-label="Agents-Hub — ir para a Timeline"
            onClick={() => setActiveTab('timeline')}
          >
            <span className="brand-logo-icon" aria-hidden="true">
              ⚡
            </span>
            <span className="brand-text" aria-hidden="true">
              <span className="brand-badge">AGENTS</span>
              <span className="brand-hub">HUB</span>
            </span>
            <span className="brand-version" aria-hidden="true">
              v0.1
            </span>
          </button>

          <nav className="nav-tabs" aria-label="Seções">
            {abas.map((aba) => (
              <button
                key={aba.id}
                type="button"
                className={`nav-tab ${activeTab === aba.id ? 'active' : ''}`}
                aria-current={activeTab === aba.id ? 'page' : undefined}
                title={aba.rotulo}
                onClick={() => setActiveTab(aba.id)}
              >
                <span className="tab-icon" aria-hidden="true">
                  {aba.icone}
                </span>
                <span className="tab-label rotulo-compacto">{aba.rotulo}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="topbar-center">
          <button
            type="button"
            className="spotlight-btn"
            aria-label={`Buscar sessões, agentes e comandos (${atalhoPaleta})`}
            aria-keyshortcuts="Control+K Meta+K"
            title={`Buscar (${atalhoPaleta})`}
            onClick={() => setCmdOpen(true)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span className="spotlight-text" aria-hidden="true">
              Buscar sessões, agentes, comandos…
            </span>
            <kbd className="kbd-shortcut" aria-hidden="true">
              {atalhoPaleta}
            </kbd>
          </button>
        </div>

        <div className="topbar-right">
          <div
            className={`pill status ${state.connected ? 'on' : 'off-air'}`}
            role="status"
            title={state.connected ? `${activeSessionsCount} sessões ao vivo` : 'Desconectado do Hub'}
          >
            <span className={`radar-dot ${state.connected ? 'running' : 'failed'}`} aria-hidden="true">
              <span className="radar-pulse" />
            </span>
            {state.connected ? (
              <span className="status-text">
                {activeSessionsCount}
                <span className="rotulo-compacto status-rotulo"> ao vivo</span>
              </span>
            ) : (
              <span className="status-text">
                <span className="rotulo-compacto status-rotulo">Desconectado</span>
              </span>
            )}
          </div>

          <button
            type="button"
            className="theme-toggle"
            aria-label={tema === 'light' ? 'Usar tema escuro' : 'Usar tema claro'}
            title={tema === 'light' ? 'Usar tema escuro' : 'Usar tema claro'}
            onClick={alternarTema}
          >
            <span aria-hidden="true">{tema === 'light' ? '☾' : '☀'}</span>
          </button>

          <button
            ref={painelToggleRef}
            type="button"
            className="drawer-toggle panel-toggle"
            aria-expanded={panelOpen && painelEhGaveta}
            aria-controls="coluna-painel"
            onClick={alternarPainel}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2"></rect>
              <line x1="15" y1="4" x2="15" y2="20"></line>
            </svg>
            <span className="rotulo-compacto rotulo-acao">Painel</span>
          </button>

          <button
            type="button"
            className="primary btn-hero-new"
            onClick={() => setModal({ delegateFrom: null })}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span className="rotulo-compacto rotulo-acao">Nova Sessão</span>
          </button>

          <TopbarMenu
            abas={abas}
            ativa={activeTab}
            onEscolher={setActiveTab}
            tema={tema}
            onAlternarTema={alternarTema}
          />
        </div>
      </header>

      {/* Erro de rede ao recarregar o índice (sessões/agentes/aprovações/projetos).
          Sem isto, uma falha de `refresh()` ficava só em `state.error`, que
          ninguém lia — o painel parecia funcionando enquanto mostrava dados
          desatualizados sem aviso nenhum. */}
      {state.error && (
        <div className="error-banner app-error-banner" role="alert">
          <span>Falha ao atualizar dados do Hub — {state.error}</span>
          <button type="button" onClick={tentarDeNovo}>
            Tentar de novo
          </button>
        </div>
      )}

      {/* Pending Approvals */}
      <Approvals
        approvals={state.approvals}
        sessions={state.sessions}
        onSelectSession={(id) => {
          // O banner aparece em todas as abas: "ver a sessão" precisa levar à timeline.
          if (setActiveTab('timeline')) selectSession(id);
        }}
        onResolved={() => void state.refresh()}
      />

      {/* Primeira execução, sem projeto: guia para registrar e ver agentes. */}
      {precisaDeBoasVindas(state.indice.carregado.projects, state.projects.length) &&
        !boasVindasDispensadas &&
        activeTab !== 'settings' && (
          <Onboarding
            onNewProject={() => setProjectModalOpen(true)}
            onVerAgentes={() => setActiveTab('settings')}
            onDispensar={() => setBoasVindasDispensadas(true)}
          />
        )}

      {/* 2. Main Body Content Area */}
      {activeTab === 'settings' ? (
        <main className="tab-view-container">
          {avisoDoIndice(['projects', 'agents'], 'os projetos e agentes')}
          <SettingsView
            agents={state.agents}
            projects={state.projects}
            onNewProject={() => setProjectModalOpen(true)}
            onSujoChange={marcarSujoConfig}
            projetosCarregados={state.indice.carregado.projects}
          />
        </main>
      ) : activeTab === 'security' ? (
        <main className="tab-view-container">
          {avisoDoIndice(['projects', 'agents', 'sessions'], 'os projetos, agentes e sessões')}
          <SecurityView
            agents={state.agents}
            projects={state.projects}
            projectIdCorrente={selectedProjectId}
            onProjectChange={setSelectedProjectId}
            sessions={state.sessions}
            onSujoChange={marcarSujoSeguranca}
            onSelectSession={(id) => {
              if (setActiveTab('timeline')) selectSession(id);
            }}
            onProjectsChanged={() => void state.refresh()}
          />
        </main>
      ) : activeTab === 'swarm' ? (
        <main className="tab-view-container">
          <AgentSwarmView
            agents={state.agents}
            onNewSession={(agentId) => setModal({ delegateFrom: null, defaultAgentId: agentId })}
            situacao={situacaoDe(['agents'], state.agents.length === 0)}
            erro={erroDe(['agents'])}
            onRetry={tentarDeNovo}
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
            projects={state.projects}
            projectId={selectedProjectId}
            onProjectChange={setSelectedProjectId}
            revisionOf={state.revisionOf}
            situacao={situacaoSessoes}
            erro={erroDe(['sessions'])}
            onRetry={tentarDeNovo}
          />
        </main>
      ) : activeTab === 'operation' ? (
        <main className="tab-view-container">
          {avisoDoIndice(['sessions', 'projects', 'agents'], 'as sessões, projetos e agentes')}
          <OperationView
            sessions={state.sessions}
            agents={state.agents}
            projects={state.projects}
            selectedSessionId={selectedId}
            onSelectSession={setSelectedId}
            onOpenSession={(id) => {
              selectSession(id);
              setActiveTab('timeline');
            }}
            onChanged={() => void state.refresh()}
          />
        </main>
      ) : activeTab === 'telemetry' ? (
        <main className="tab-view-container">
          <TelemetryView
            sessions={state.sessions}
            flows={state.flows}
            projects={state.projects}
            projectId={selectedProjectId}
            onProjectChange={setSelectedProjectId}
            revisionOf={state.revisionOf}
            situacao={situacaoSessoes}
            erro={erroDe(['sessions'])}
            onRetry={tentarDeNovo}
          />
        </main>
      ) : (
        /* Timeline 3-Column Layout */
        <div className="columns">
          {(fluxosGavetaAberta || painelGavetaAberto) && (
            <div className="drawer-backdrop" aria-hidden="true" onClick={() => fecharGavetas(false)} />
          )}

          {/* Coluna Esquerda: Fluxos */}
          <aside
            ref={colunaFluxosRef}
            id="coluna-fluxos"
            className="col col-left"
            aria-label="Navegação de fluxos"
            inert={fluxosEhGaveta && !fluxosGavetaAberta}
          >
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
                aria-label="Filtrar por projeto"
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
                  Ativos{' '}
                  <span className="seg-count">
                    {filteredFlows.filter((f) => f.sessions.some((s) => isLiveState(s.state))).length}
                  </span>
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
                  aria-label="Nova Sessão"
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
                aria-label="Filtrar fluxos ou agentes"
                placeholder="Filtrar fluxos ou agentes…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="scroll">
              <FlowList
                flows={filteredFlows}
                selectedId={selectedId}
                selectedRootId={selectedRootId}
                listState={listaDeFluxos}
                onToggle={toggleFlow}
                onSelect={selectSession}
                revisionOf={state.revisionOf}
                situacao={situacaoSessoes}
                erro={erroDe(['sessions'])}
                onRetry={tentarDeNovo}
                onShowAll={() => {
                  setFlowFilter('all');
                  setSearchQuery('');
                  setSelectedProjectId('all');
                }}
                onNewSession={() => setModal({ delegateFrom: null })}
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
                      <span
                        className="session-agent-pill"
                        style={{ color: agentColor(selected.agentId) }}
                      >
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
              {!selected && (situacaoSessoes === 'erro' || situacaoSessoes === 'carregando') ? (
                <EstadoDaTela
                  situacao={situacaoSessoes}
                  oQue="as sessões"
                  erro={erroDe(['sessions'])}
                  onTentar={tentarDeNovo}
                />
              ) : (
                <Timeline
                  events={events}
                  showVerbose={verbose}
                  showAgent={scope === 'flow'}
                  loading={!state.ready || (timeline?.loading ?? false)}
                  failed={eventsFailed}
                  unselected={(situacaoSessoes === 'ok' || situacaoSessoes === 'vazio') && !selected}
                  hubVazio={situacaoSessoes === 'vazio'}
                  resetKey={`${selected?.id ?? ''}:${scope}`}
                  hasMoreBefore={timeline?.hasMoreBefore ?? false}
                  loadingOlder={timeline?.loadingOlder ?? false}
                  olderFailed={timeline?.olderFailed ?? false}
                  onLoadOlder={timeline?.loadOlder}
                  retryAt={timeline?.retryAt ?? null}
                  onRetry={timeline?.retry}
                />
              )}

              {selected && <Composer session={selected} encerrada={!isLiveState(selected.state)} />}
            </div>
          </main>

          {/* Coluna Direita: Controles e Custo */}
          <aside
            ref={colunaPainelRef}
            id="coluna-painel"
            className="col col-right"
            aria-label="Controles e telemetria"
            inert={painelEhGaveta && !painelGavetaAberto}
          >
            <SidePanel
              session={selected}
              budgetState={budget}
              agents={state.agents}
              onDelegate={() => {
                if (selected) {
                  setModal({
                    delegateFrom: { sessionId: selected.id, agentId: selected.agentId },
                  });
                }
              }}
              onChanged={() => void state.refresh()}
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
          defaultProjectId={selectedProjectId !== 'all' ? selectedProjectId : undefined}
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
          onProjectExists={(projectId) => {
            setSelectedProjectId(projectId);
            void state.refresh();
          }}
        />
      )}

      {cmdOpen && (
        <CommandPalette
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
