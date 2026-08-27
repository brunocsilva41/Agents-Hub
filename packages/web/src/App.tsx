import { useEffect, useMemo, useState } from 'react';
import { FlowTree } from './components/FlowTree';
import { SessionModal } from './components/SessionModal';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { agentColor, hub, STATE_LABEL } from './hub';
import { mergeEvents, useHubState, useSessionHistory } from './useHubState';

export function App() {
  const state = useHubState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<'session' | 'flow'>('session');
  const [verbose, setVerbose] = useState(false);
  const [modal, setModal] = useState<null | { delegateFrom: { sessionId: string; agentId: string } | null }>(
    null,
  );
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const selected = useMemo(
    () => state.sessions.find((s) => s.id === selectedId) ?? null,
    [state.sessions, selectedId],
  );

  // Sem seleção, abre a sessão mais recente: chegar num painel vazio não ajuda.
  useEffect(() => {
    if (selectedId === null && state.sessions.length > 0) {
      setSelectedId(state.sessions[0]?.id ?? null);
    }
  }, [state.sessions, selectedId]);

  const { history } = useSessionHistory(selectedId);

  /** Sessões incluídas na timeline: só a atual, ou o fluxo inteiro. */
  const timelineSessions = useMemo(() => {
    if (!selected) return [];
    if (scope === 'session') return [selected.id];
    return state.sessions.filter((s) => s.rootId === selected.rootId).map((s) => s.id);
  }, [selected, scope, state.sessions]);

  const events = useMemo(() => {
    if (!selected) return [];
    if (scope === 'session') return mergeEvents(history, state.eventsOf(selected.id));

    // Na visão de fluxo, ordenamos por tempo: `seq` só é monotônico DENTRO de
    // uma sessão, então usá-lo aqui embaralharia agentes diferentes.
    return timelineSessions
      .flatMap((id) => state.eventsOf(id))
      .concat(history)
      .filter((event, index, all) => all.findIndex((e) => e.id === event.id) === index)
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  }, [selected, scope, history, state, timelineSessions]);

  const send = async (): Promise<void> => {
    if (!selected || message.trim().length === 0) return;
    setSending(true);
    setSendError(null);
    try {
      await hub.send(selected.id, message.trim());
      setMessage('');
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Agents<span>-Hub</span>
        </div>

        <div className="agent-pills">
          {state.agents.map((agent) => (
            <div
              key={agent.id}
              className={`pill${agent.probe?.installed === true ? '' : ' off'}`}
              title={
                agent.probe?.installed === true
                  ? `${agent.name} ${agent.probe.version ?? ''}`
                  : `${agent.name} — não instalado`
              }
            >
              <span
                className="dot"
                style={{
                  background:
                    agent.probe?.installed === true ? agentColor(agent.id) : 'var(--text-faint)',
                }}
              />
              {agent.id}
            </div>
          ))}
        </div>

        <div className="pill" title={state.connected ? 'stream ao vivo conectado' : 'reconectando'}>
          <span className={`dot ${state.connected ? 'running' : 'failed'}`} />
          {state.connected ? 'ao vivo' : 'desconectado'}
        </div>

        <button className="primary" onClick={() => setModal({ delegateFrom: null })}>
          Nova sessão
        </button>
      </header>

      <div className="columns">
        <aside className="col col-left">
          <div className="col-header">
            <span>Fluxos</span>
            <span className="badge">{state.roots.length}</span>
          </div>
          <div className="scroll">
            {state.error && <div className="error-banner" style={{ margin: 10 }}>{state.error}</div>}

            {state.roots.length === 0 && (
              <div className="empty">
                nenhuma sessão ainda.
                <br />
                comece uma para ver o grafo aqui.
              </div>
            )}

            {state.roots.map((root) => (
              <div className="flow" key={root.id}>
                <FlowTree
                  nodes={state.graphs[root.id] ?? []}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
            ))}
          </div>
        </aside>

        <main className="col">
          <div className="col-header">
            <span>
              {selected ? (
                <>
                  <span style={{ color: agentColor(selected.agentId) }}>{selected.agentId}</span>
                  {' · '}
                  {STATE_LABEL[selected.state] ?? selected.state}
                </>
              ) : (
                'Timeline'
              )}
            </span>

            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                onClick={() => setScope(scope === 'session' ? 'flow' : 'session')}
                title="alterna entre esta sessão e o fluxo inteiro"
              >
                {scope === 'session' ? 'só esta sessão' : 'fluxo inteiro'}
              </button>
              <button onClick={() => setVerbose(!verbose)} title="mostra raciocínio e logs internos">
                {verbose ? 'detalhado' : 'resumido'}
              </button>
            </span>
          </div>

          {selected ? (
            <Timeline events={events} showVerbose={verbose} showAgent={scope === 'flow'} />
          ) : (
            <div className="empty">selecione uma sessão</div>
          )}

          {selected && (
            <div className="composer">
              {sendError && <div className="error-banner">{sendError}</div>}
              <div className="composer-row">
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={`falar com ${selected.agentId}…`}
                  disabled={sending}
                />
                <button
                  className="primary"
                  onClick={() => void send()}
                  disabled={sending || message.trim().length === 0}
                >
                  {sending ? '…' : 'Enviar'}
                </button>
              </div>
            </div>
          )}
        </main>

        <aside className="col col-right">
          <SidePanel
            session={selected}
            budget={selected ? state.budgets[selected.rootId] : undefined}
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
    </div>
  );
}
