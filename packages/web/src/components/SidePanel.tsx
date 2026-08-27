import { useState } from 'react';
import type { BudgetSummary, SessionSummary } from '@agents-hub/client';
import { hub, STATE_LABEL, formatDuration, formatTokens, formatUsd } from '../hub';

interface Props {
  session: SessionSummary | null;
  budget: BudgetSummary | undefined;
  onDelegate: () => void;
  onChanged: () => void;
}

/**
 * Painel de custo e controles ao vivo.
 *
 * Os controles ficam AQUI, ao lado do orçamento, de propósito: a decisão de
 * interromper um agente quase sempre vem de olhar quanto ele já gastou.
 */
export function SidePanel({ session, budget, onDelegate, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const active = session?.state === 'running' || session?.state === 'waiting_approval';

  return (
    <>
      <div className="col-header">Fluxo</div>
      <div className="scroll">
        {budget && (
          <div className="section">
            <h3>Orçamento do fluxo</h3>
            <div className="gauge">
              <div
                className={`gauge-fill${budget.pressure >= 0.9 ? ' danger' : budget.pressure >= 0.6 ? ' warn' : ''}`}
                style={{ width: `${Math.min(100, budget.pressure * 100)}%` }}
              />
            </div>
            <dl style={{ margin: 0 }}>
              <div className="kv">
                <dt>custo</dt>
                <dd>
                  {formatUsd(budget.consumed.usd)} / {budget.limits.usd.toFixed(2)}
                </dd>
              </div>
              <div className="kv">
                <dt>tokens</dt>
                <dd>
                  {formatTokens(budget.consumed.tokens)} / {formatTokens(budget.limits.tokens)}
                </dd>
              </div>
              <div className="kv">
                <dt>tempo</dt>
                <dd>
                  {formatDuration(budget.consumed.seconds)} /{' '}
                  {formatDuration(budget.limits.seconds)}
                </dd>
              </div>
            </dl>
            {budget.exhausted && (
              <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
                Orçamento esgotado. Tarefas novas ficam bloqueadas até você aumentar o teto.
              </div>
            )}
          </div>
        )}

        {session && (
          <>
            <div className="section">
              <h3>Sessão</h3>
              <dl style={{ margin: 0 }}>
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

            <div className="section">
              <h3>Controles</h3>
              {error && <div className="error-banner">{error}</div>}
              <div className="controls">
                <button
                  disabled={!active || busy !== null}
                  onClick={() => void act('interrupt', () => hub.interrupt(session.id))}
                >
                  {busy === 'interrupt' ? '…' : 'Interromper turno'}
                </button>
                <button
                  disabled={!active || busy !== null}
                  onClick={() => void act('pause', () => hub.pause(session.id))}
                >
                  {busy === 'pause' ? '…' : 'Pausar'}
                </button>
                <button
                  className="danger"
                  disabled={!active || busy !== null}
                  onClick={() => void act('cancel', () => hub.cancel(session.id, 'via painel'))}
                >
                  {busy === 'cancel' ? '…' : 'Encerrar'}
                </button>
                <button onClick={onDelegate}>Delegar a partir daqui</button>
              </div>
              <div className="help" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)' }}>
                Encerrar derruba também o que esta sessão delegou.
              </div>
            </div>
          </>
        )}

        {!session && <div className="empty">selecione uma sessão no grafo</div>}
      </div>
    </>
  );
}
