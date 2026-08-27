import { useState } from 'react';
import type { ApprovalSummary } from '@agents-hub/client';
import { hub, timeOf } from '../hub';

interface Props {
  approvals: ApprovalSummary[];
  onResolved: () => void;
  onSelectSession: (sessionId: string) => void;
}

/**
 * Fila de aprovações, no topo da tela e sem como ignorar.
 *
 * Uma sessão parada esperando decisão é trabalho congelado e orçamento
 * reservado sem uso — se isso ficar escondido numa aba, o Hub vira um lugar
 * onde tarefas somem em silêncio.
 */
export function Approvals({ approvals, onResolved, onSelectSession }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  const decide = async (id: string, decision: 'approved' | 'denied'): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await hub.resolveApproval(id, decision);
      onResolved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="approvals">
      {error && <div className="error-banner">{error}</div>}

      {approvals.map((approval) => {
        const jaExecutou = approval.detail['alreadyExecuted'] === true;
        return (
          <div key={approval.id} className="approval">
            <div className="approval-body">
              <div className="approval-head">
                <span className="badge risk">{approval.risk}</span>
                <span className={`badge ${jaExecutou ? 'danger' : ''}`}>
                  {jaExecutou ? 'já executada — sessão parada' : 'retida antes de executar'}
                </span>
                <span className="approval-time">{timeOf(approval.requestedAt)}</span>
              </div>

              <div className="approval-action">{approval.action}</div>

              {typeof approval.detail['reason'] === 'string' && (
                <div className="approval-reason">{String(approval.detail['reason'])}</div>
              )}

              <button
                className="linkish"
                onClick={() => onSelectSession(approval.sessionId)}
                title="abrir a sessão que está parada"
              >
                ver a sessão
              </button>
            </div>

            <div className="approval-actions">
              <button
                className="primary"
                disabled={busy !== null}
                onClick={() => void decide(approval.id, 'approved')}
              >
                {busy === approval.id ? '…' : 'Liberar'}
              </button>
              <button
                className="danger"
                disabled={busy !== null}
                onClick={() => void decide(approval.id, 'denied')}
              >
                Negar
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
