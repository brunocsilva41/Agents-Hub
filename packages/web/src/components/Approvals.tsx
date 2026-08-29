import type { ApprovalSummary, SessionSummary } from '@agents-hub/client';
import { useAction } from '../actions';
import { agentColor, formatAgo, hub, RISK_LABEL, timeOf } from '../hub';

interface Props {
  approvals: ApprovalSummary[];
  sessions: SessionSummary[];
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
export function Approvals({ approvals, sessions, onResolved, onSelectSession }: Props) {
  const action = useAction();

  if (approvals.length === 0) return null;

  const decide = (approval: ApprovalSummary, decision: 'approved' | 'denied'): void => {
    void action
      .run(
        `${approval.id}:${decision}`,
        () => hub.resolveApproval(approval.id, decision),
        decision === 'approved' ? 'Liberado — a sessão volta a andar.' : 'Negado.',
      )
      .then((ok) => {
        if (ok) onResolved();
      });
  };

  return (
    <section className="approvals" aria-label="Decisões pendentes">
      <div className="approvals-head" role="status" aria-live="polite">
        <span className="approvals-count">{approvals.length}</span>
        {approvals.length === 1
          ? 'sessão parada esperando sua decisão'
          : 'sessões paradas esperando sua decisão'}
      </div>

      {action.error && (
        <div className="error-banner" role="alert">
          {action.error}
        </div>
      )}

      {approvals.map((approval) => {
        const session = sessions.find((s) => s.id === approval.sessionId);
        const jaExecutou = approval.detail['alreadyExecuted'] === true;
        const orcamento = approval.risk === 'budget';

        return (
          <div key={approval.id} className="approval">
            <div className="approval-body">
              <div className="approval-head">
                <span className="badge risk">{RISK_LABEL[approval.risk] ?? approval.risk}</span>
                {/* "retida antes de executar" só faz sentido para um gate de
                    ferramenta. Num estouro de orçamento nada foi retido: o
                    fluxo ficou sem teto, e a frase errada faz a pessoa procurar
                    um comando perigoso que não existe. */}
                {!orcamento && (
                  <span className={`badge ${jaExecutou ? 'danger' : 'ok'}`}>
                    {jaExecutou ? 'já executada — sessão parada' : 'retida antes de executar'}
                  </span>
                )}
                {session && (
                  <span className="approval-who" style={{ color: agentColor(session.agentId) }}>
                    {session.agentId}
                  </span>
                )}
                <span className="approval-time" title={approval.requestedAt}>
                  {formatAgo(approval.requestedAt)} · {timeOf(approval.requestedAt)}
                </span>
              </div>

              <div className="approval-action">{approval.action}</div>

              {/* Qual tarefa travou. Sem isto a fila mostra a ação sem dizer a
                  que trabalho ela pertence, e decidir vira adivinhação. */}
              {session?.title && <div className="approval-context">{session.title}</div>}

              {typeof approval.detail['reason'] === 'string' && (
                <div className="approval-reason">{String(approval.detail['reason'])}</div>
              )}

              <button
                className="linkish"
                onClick={() => onSelectSession(approval.sessionId)}
                title="abrir a timeline da sessão que está parada"
              >
                ver a sessão
              </button>
            </div>

            <div className="approval-actions">
              <button
                className="primary"
                disabled={action.busy !== null}
                onClick={() => decide(approval, 'approved')}
              >
                {action.busy === `${approval.id}:approved` ? '…' : 'Liberar'}
              </button>
              <button
                className="danger"
                disabled={action.busy !== null}
                onClick={() => decide(approval, 'denied')}
              >
                {action.busy === `${approval.id}:denied` ? '…' : 'Negar'}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
