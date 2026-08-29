import { useState } from 'react';
import type { AgentSummary, BudgetSummary, SessionSummary } from '@agents-hub/client';
import { useAction } from '../actions';
import { hub, STATE_LABEL, formatDuration, formatTokens, formatUsd } from '../hub';

interface Props {
  session: SessionSummary | null;
  budget: BudgetSummary | null;
  agents?: AgentSummary[];
  onDelegate: () => void;
  onChanged: () => void;
}

/**
 * Painel de custo e controles ao vivo.
 *
 * Os controles ficam AQUI, ao lado do orçamento, de propósito: a decisão de
 * interromper um agente quase sempre vem de olhar quanto ele já gastou.
 */
export function SidePanel({ session, budget, agents = [], onDelegate, onChanged }: Props) {
  const action = useAction();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [targetAgent, setTargetAgent] = useState('');
  const [handoffReason, setHandoffReason] = useState('');

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
      <div className="col-header">Fluxo</div>
      <div className="scroll">
        {budget && (
          <div className="section">
            <h3>Orçamento do fluxo</h3>

            {/* O número grande antes da barra: "quanto sobra" é a pergunta, e
                lê-la de uma barra exige comparar dois pontos na horizontal. */}
            <div className={`budget-head level-${level}`}>
              <span className="budget-pct">{Math.round(pressure * 100)}%</span>
              <span className="budget-rest">
                restam {formatUsd(Math.max(0, budget.remaining.usd))}
              </span>
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

            <dl className="kv-list">
              <div className="kv">
                <dt>custo</dt>
                <dd>
                  {formatUsd(budget.consumed.usd)} <span className="kv-sep">/</span>{' '}
                  {budget.limits.usd.toFixed(2)}
                </dd>
              </div>
              <div className="kv">
                <dt>tokens</dt>
                <dd>
                  {formatTokens(budget.consumed.tokens)} <span className="kv-sep">/</span>{' '}
                  {formatTokens(budget.limits.tokens)}
                </dd>
              </div>
              <div className="kv">
                <dt>tempo</dt>
                <dd>
                  {formatDuration(budget.consumed.seconds)} <span className="kv-sep">/</span>{' '}
                  {formatDuration(budget.limits.seconds)}
                </dd>
              </div>
              {budget.projection && budget.projection.burnRateUsdPerSec > 0 && (
                <div className="kv">
                  <dt>taxa de queima</dt>
                  <dd>US$ {(budget.projection.burnRateUsdPerSec * 60).toFixed(3)}/min</dd>
                </div>
              )}
            </dl>

            {budget.isWarning && !budget.exhausted && (
              <div className="notice warn" role="status">
                Consumo passou de 80% do teto. No ritmo atual o fluxo para em breve.
              </div>
            )}
            {budget.exhausted && (
              <div className="notice danger" role="status">
                Orçamento esgotado. Tarefas novas ficam bloqueadas até você aumentar o teto.
              </div>
            )}
          </div>
        )}

        {session && (
          <>
            <div className="section">
              <h3>Controles</h3>
              {action.error && (
                <div className="error-banner" role="alert">
                  {action.error}
                </div>
              )}
              {!active && (
                <p className="help">
                  Sessão {STATE_LABEL[session.state] ?? session.state}: só resta delegar a partir
                  dela.
                </p>
              )}
              <div className="controls">
                <button
                  disabled={!active || action.busy !== null}
                  onClick={() =>
                    act('interrupt', () => hub.interrupt(session.id), 'Turno interrompido.')
                  }
                >
                  {action.busy === 'interrupt' ? '…' : 'Interromper turno'}
                </button>
                <button
                  disabled={!active || action.busy !== null}
                  onClick={() => act('pause', () => hub.pause(session.id), 'Sessão pausada.')}
                >
                  {action.busy === 'pause' ? '…' : 'Pausar'}
                </button>
                <button
                  disabled={!active || action.busy !== null}
                  aria-expanded={handoffOpen}
                  onClick={() => setHandoffOpen(!handoffOpen)}
                  title="Transfere o controle da sessão para outro agente especialista"
                >
                  Transferir
                </button>
                <button
                  className="danger"
                  disabled={!active || action.busy !== null}
                  onClick={() =>
                    act('cancel', () => hub.cancel(session.id, 'via painel'), 'Sessão encerrada.')
                  }
                >
                  {action.busy === 'cancel' ? '…' : 'Encerrar'}
                </button>
                <button onClick={onDelegate}>Delegar a partir daqui</button>
              </div>

              {handoffOpen && (
                <div className="subform">
                  <div className="subform-title">Transferir controle da sessão</div>
                  <label className="sr-only" htmlFor="handoff-agent">
                    Novo agente
                  </label>
                  <select
                    id="handoff-agent"
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
                      {action.busy === 'handoff' ? 'Transferindo…' : 'Confirmar'}
                    </button>
                    <button onClick={() => setHandoffOpen(false)}>Cancelar</button>
                  </div>
                </div>
              )}

              <p className="help">Encerrar derruba também o que esta sessão delegou.</p>
            </div>

            <div className="section">
              <h3>Sessão</h3>
              <dl className="kv-list">
                <div className="kv">
                  <dt>agente</dt>
                  <dd>{session.agentId}</dd>
                </div>
                <div className="kv">
                  <dt>estado</dt>
                  <dd>{STATE_LABEL[session.state] ?? session.state}</dd>
                </div>
                <div className="kv">
                  <dt>supervisão</dt>
                  <dd>{session.mode}</dd>
                </div>
                <div className="kv">
                  <dt>isolamento</dt>
                  <dd>{session.isolation}</dd>
                </div>
                <div className="kv">
                  <dt>profundidade</dt>
                  <dd>{session.depth}</dd>
                </div>
                <div className="kv">
                  <dt>sessão nativa</dt>
                  <dd title={session.nativeSessionId ?? ''}>
                    {session.nativeSessionId ? 'sim' : '—'}
                  </dd>
                </div>
                <div className="kv">
                  <dt>worktree</dt>
                  <dd title={session.workdir}>{session.workdir.split(/[\\/]/).pop()}</dd>
                </div>
                <div className="kv">
                  <dt>id</dt>
                  <dd title={session.id}>{session.id.slice(0, 12)}…</dd>
                </div>
              </dl>
            </div>
          </>
        )}

        {!session && <div className="empty">selecione uma sessão no grafo</div>}
      </div>
    </>
  );
}
