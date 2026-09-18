import { useState, useEffect } from 'react';
import type { AgentSummary, BudgetSummary, SessionSummary } from '@agents-hub/client';
import { useAction } from '../actions';
import { agentColor, hub, STATE_LABEL, formatDuration, formatTokens, formatUsd } from '../hub';

interface Props {
  session: SessionSummary | null;
  budget: BudgetSummary | null;
  agents?: AgentSummary[];
  onDelegate: () => void;
  onChanged: () => void;
}

/**
 * Painel de custo, controles e memórias ao vivo.
 */
export function SidePanel({ session, budget, agents = [], onDelegate, onChanged }: Props) {
  const action = useAction();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [targetAgent, setTargetAgent] = useState('');
  const [handoffReason, setHandoffReason] = useState('');
  const [memoryExpanded, setMemoryExpanded] = useState(true);
  const [projectGuidelines, setProjectGuidelines] = useState<string | null>(null);

  /**
   * Memória do projeto, vinda do daemon.
   *
   * Antes saía do `localStorage`, o que exibia aqui uma coisa e mandava ao
   * agente outra: a memória que a sessão realmente recebeu é a do arquivo do
   * projeto, e só o daemon a conhece. Um painel de memória que não mostra a
   * memória em uso é pior do que não ter painel.
   */
  useEffect(() => {
    const projectId = session?.projectId;
    if (!projectId) {
      setProjectGuidelines(null);
      return;
    }

    let cancelado = false;
    hub
      .projectContext(projectId)
      .then(({ context }) => {
        if (!cancelado) setProjectGuidelines(context.memory?.trim() || null);
      })
      .catch(() => {
        // Falha de leitura não pode virar "este projeto não tem memória" — são
        // coisas diferentes, e confundi-las esconde justamente o problema.
        if (!cancelado) setProjectGuidelines(null);
      });

    // Trocar de sessão antes da resposta chegar mostraria a memória do projeto
    // anterior sob o nome do novo.
    return () => {
      cancelado = true;
    };
  }, [session?.projectId]);

  const act = (label: string, fn: () => Promise<unknown>, ok: string): void => {
    void action.run(label, fn, ok).then((done) => {
      if (done) onChanged();
    });
  };

  const submitHandoff = (): void => {
    if (!session || !targetAgent) return;
    void action
      .run(
        'handoff',
        () => hub.handoff(session.id, targetAgent, handoffReason.trim() || undefined),
        `Sessão transferida para ${targetAgent}.`,
      )
      .then((done) => {
        if (!done) return;
        setHandoffOpen(false);
        setTargetAgent('');
        setHandoffReason('');
        onChanged();
      });
  };

  const active = session?.state === 'running' || session?.state === 'waiting_approval';
  const installedAgents = agents.filter(
    (a) => a.probe?.installed === true && a.id !== session?.agentId,
  );

  const pressure = budget ? Math.min(1, budget.pressure) : 0;
  const level = budget?.exhausted || pressure >= 0.9 ? 'danger' : pressure >= 0.6 ? 'warn' : 'ok';

  return (
    <>
      <div className="col-header">
        <span>Painel & Telemetria</span>
        {session && (
          <span className="badge-agent" style={{ color: agentColor(session.agentId) }}>
            {session.agentId}
          </span>
        )}
      </div>
      <div className="scroll">
        {budget && (
          <div className="section budget-section">
            <div className="section-header-row">
              <h3>Orçamento do fluxo</h3>
              {budget.projection && budget.projection.burnRateUsdPerSec > 0 && (
                <span className="burn-rate-chip" title="Taxa de queima atual">
                  ⚡ ${(budget.projection.burnRateUsdPerSec * 60).toFixed(3)}/min
                </span>
              )}
              {budget.projection && budget.projection.burnRateUsdPerSec > 0 && (
                <span
                  className="burn-rate-chip"
                  title="Projeção de custo e tokens ao fim do orçamento, no ritmo atual"
                >
                  📈 {formatUsd(budget.projection.projectedUsd)} · {formatTokens(budget.projection.projectedTokens)}
                </span>
              )}
            </div>

            <div className={`budget-head level-${level}`}>
              <div className="budget-pct-wrap">
                <span className="budget-pct">{Math.round(pressure * 100)}%</span>
                <span className="budget-label">consumido</span>
              </div>
              <div className="budget-rest-wrap">
                <span className="budget-rest-val">{formatUsd(Math.max(0, budget.remaining.usd))}</span>
                <span className="budget-rest-label">restante</span>
              </div>
            </div>

            <div
              className="gauge"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pressure * 100)}
              aria-label="Consumo do orçamento do fluxo"
            >
              <div className={`gauge-fill ${level}`} style={{ width: `${pressure * 100}%` }} />
            </div>

            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">Custo</span>
                <span className="metric-val">{formatUsd(budget.consumed.usd)}</span>
                <span className="metric-sub">de ${budget.limits.usd.toFixed(2)}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Tokens</span>
                <span className="metric-val">{formatTokens(budget.consumed.tokens)}</span>
                <span className="metric-sub">de {formatTokens(budget.limits.tokens)}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Tempo</span>
                <span className="metric-val">{formatDuration(budget.consumed.seconds)}</span>
                <span className="metric-sub">de {formatDuration(budget.limits.seconds)}</span>
              </div>
            </div>

            {budget.isWarning && !budget.exhausted && (
              <div className="notice warn" role="status">
                ⚠️ <strong>Atenção:</strong> Consumo passou de 80% do teto.
              </div>
            )}
            {budget.exhausted && (
              <div className="notice danger" role="status">
                🛑 <strong>Orçamento esgotado:</strong> Tarefas novas estão bloqueadas.
              </div>
            )}
          </div>
        )}

        {session && (
          <>
            {/* Bloco de Memória e Contexto */}
            <div className="section memory-section">
              <div
                className="section-header-row clickable"
                onClick={() => setMemoryExpanded(!memoryExpanded)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                <h3>🧠 Memória & Contexto</h3>
                <span className={`chevron-icon ${memoryExpanded ? 'rotated' : ''}`}>›</span>
              </div>

              {memoryExpanded && (
                <div className="memory-body">
                  {projectGuidelines && (
                    <div className="memory-card">
                      <div className="memory-tag">📁 Regras do Projeto</div>
                      <div className="memory-text">{projectGuidelines}</div>
                    </div>
                  )}

                  <div className="memory-card">
                    <div className="memory-tag">🛡️ Modo de Isolamento</div>
                    <div className="memory-text">
                      {session.isolation === 'worktree'
                        ? 'Worktree Git isolado — Arquivos protegidos contra conflitos.'
                        : 'Diretório Principal — Execução in-place direta.'}
                    </div>
                  </div>

                  <div className="memory-card">
                    <div className="memory-tag">📂 Pasta de Execução</div>
                    <div className="memory-mono-text" title={session.workdir}>
                      {session.workdir}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Controles de Execução */}
            <div className="section controls-section">
              <h3>Controles da Sessão</h3>
              <div className="controls-grid">
                <button
                  className="btn-ctrl btn-interrupt"
                  disabled={!active || action.busy !== null}
                  onClick={() =>
                    act('interrupt', () => hub.interrupt(session.id), 'Turno interrompido.')
                  }
                  title="Interrompe o turno sem matar o processo"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="4" width="4" height="16"></rect>
                    <rect x="14" y="4" width="4" height="16"></rect>
                  </svg>
                  <span>{action.busy === 'interrupt' ? '…' : 'Pausar'}</span>
                </button>
                <button
                  className="btn-ctrl btn-handoff"
                  disabled={!active || installedAgents.length === 0}
                  onClick={() => setHandoffOpen((open) => !open)}
                  title="Transfere o controle da sessão para outro agente"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="17 1 21 5 17 9"></polyline>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                    <polyline points="7 23 3 19 7 15"></polyline>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                  </svg>
                  <span>Transferir</span>
                </button>
                <button
                  className="btn-ctrl btn-cancel danger"
                  disabled={!active || action.busy !== null}
                  onClick={() =>
                    act('cancel', () => hub.cancel(session.id, 'via painel'), 'Sessão encerrada.')
                  }
                  title="Encerra a sessão imediatamente"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                  </svg>
                  <span>{action.busy === 'cancel' ? '…' : 'Encerrar'}</span>
                </button>
              </div>

              <button className="btn-delegate-full" onClick={onDelegate}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>Delegar sub-tarefa a partir daqui</span>
              </button>

              {handoffOpen && (
                <div className="subform handoff-card">
                  <div className="subform-title">
                    <span>🔄 Transferir Sessão (Handoff)</span>
                  </div>
                  <label className="sr-only" htmlFor="handoff-agent">
                    Novo agente
                  </label>
                  <select
                    id="handoff-agent"
                    className="handoff-select"
                    value={targetAgent}
                    onChange={(e) => setTargetAgent(e.target.value)}
                  >
                    <option value="">Selecione o novo agente…</option>
                    {installedAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.id})
                      </option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor="handoff-reason">
                    Motivo da transferência
                  </label>
                  <input
                    id="handoff-reason"
                    type="text"
                    placeholder="Motivo da transferência (opcional)…"
                    value={handoffReason}
                    onChange={(e) => setHandoffReason(e.target.value)}
                  />
                  <div className="subform-actions">
                    <button
                      className="primary"
                      disabled={!targetAgent || action.busy !== null}
                      onClick={submitHandoff}
                    >
                      {action.busy === 'handoff' ? 'Transferindo…' : 'Confirmar Handoff'}
                    </button>
                    <button onClick={() => setHandoffOpen(false)}>Cancelar</button>
                  </div>
                </div>
              )}
            </div>

            <div className="section session-details-section">
              <h3>Detalhes Técnicos</h3>
              <dl className="kv-list">
                <div className="kv">
                  <dt>Agente</dt>
                  <dd>
                    <span className="badge-agent" style={{ color: agentColor(session.agentId) }}>
                      {session.agentId}
                    </span>
                  </dd>
                </div>
                <div className="kv">
                  <dt>Estado</dt>
                  <dd>
                    <span className={`badge-state state-${session.state}`}>
                      {STATE_LABEL[session.state] ?? session.state}
                    </span>
                  </dd>
                </div>
                <div className="kv">
                  <dt>Supervisão</dt>
                  <dd>
                    <span className="badge-mode">{session.mode}</span>
                  </dd>
                </div>
                <div className="kv">
                  <dt>Profundidade</dt>
                  <dd>Nível {session.depth}</dd>
                </div>
                <div className="kv">
                  <dt>Sessão Nativa</dt>
                  <dd title={session.nativeSessionId ?? ''}>
                    {session.nativeSessionId ? 'Sim' : '—'}
                  </dd>
                </div>
                <div className="kv">
                  <dt>ID da Sessão</dt>
                  <dd className="mono-val" title={session.id}>
                    {session.id.slice(0, 12)}…
                  </dd>
                </div>
              </dl>
            </div>
          </>
        )}

        {!session && (
          <div className="empty sidepanel-empty">
            <div className="empty-icon">🧭</div>
            <div className="empty-title">Nenhuma sessão selecionada</div>
            <span className="empty-hint">Selecione um fluxo para ver detalhes, memórias e telemetria.</span>
          </div>
        )}
      </div>
    </>
  );
}
