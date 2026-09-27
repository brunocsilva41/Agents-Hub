import React, { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '@agents-hub/client';
import { describeError } from '../actions';
import { formatAgo, hub, RISK_LABEL } from '../hub';
import {
  DECISAO_LABEL,
  historicoDeAprovacoes,
  PERIODOS,
  tomDaDecisao,
  type ItemDoHistorico,
} from '../logic/security';

interface Props {
  sessions: SessionSummary[];
  /** Projeto escolhido no topo da área; `''` = todos. */
  projectId: string;
  onSelectSession: (id: string) => void;
}

/**
 * Histórico de aprovações: o banner do topo só mostra as pendentes; aqui
 * ficam as resolvidas — o que foi pedido, a decisão e QUEM decidiu (`web`,
 * `cli:<usuário>`, `tempo esgotado`), a partir da auditoria.
 */
export function ApprovalHistory({ sessions, projectId, onSelectSession }: Props): React.JSX.Element {
  const [periodo, setPeriodo] = useState('7d');
  const [itens, setItens] = useState<ItemDoHistorico[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  const buscar = useCallback(async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const base = {
        limit: 1000,
        ...(periodo ? { since: periodo } : {}),
        ...(projectId ? { projectId } : {}),
      };
      // A rota filtra UM tipo por vez: pedido e resolução vêm em duas consultas.
      const [pedidos, resolvidas] = await Promise.all([
        hub.audit({ ...base, kind: 'approval.requested' }),
        hub.audit({ ...base, kind: 'approval.resolved' }),
      ]);
      setItens(historicoDeAprovacoes([...resolvidas.entries, ...pedidos.entries]));
    } catch (err) {
      const { title, detail } = describeError(err);
      setErro(detail ? `${title} (${detail})` : title);
    } finally {
      setCarregando(false);
    }
  }, [periodo, projectId]);

  useEffect(() => {
    void buscar();
  }, [buscar]);

  const existeSessao = (id: string | null): boolean => id !== null && sessions.some((s) => s.id === id);

  return (
    <div className="settings-card">
      <h3 className="card-title">Histórico de aprovações</h3>
      <p className="card-desc">
        Pedidos de aprovação e como terminaram — aprovada, negada ou expirada — e por quem.
      </p>

      <div className="sec-filtros">
        <label className="sec-filtro">
          <span>Período</span>
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
            {PERIODOS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.rotulo}
              </option>
            ))}
          </select>
        </label>
        <div className="sec-acoes sec-acoes-topo">
          <span className="dim" role="status">
            {carregando ? 'carregando…' : itens ? `${itens.length} aprovação(ões)` : ''}
          </span>
          <button onClick={() => void buscar()} disabled={carregando}>
            Atualizar
          </button>
        </div>
      </div>

      {erro && (
        <div className="settings-erro" role="alert">
          Falha ao ler o histórico: {erro}
          <button className="ghost" onClick={() => void buscar()} disabled={carregando}>
            tentar de novo
          </button>
        </div>
      )}
      {itens && itens.length === 0 && !erro && (
        <div className="settings-vazio">Nenhuma aprovação neste período.</div>
      )}

      {itens && itens.length > 0 && (
        <ul className="sec-lista" aria-label="Aprovações">
          {itens.map((i) => (
            <li key={i.approvalId} className="sec-item">
              <div className="sec-item-cab">
                <span className={`sec-badge tom-${i.decisao ? tomDaDecisao(i.decisao) : 'pede'}`}>
                  {i.decisao ? DECISAO_LABEL[i.decisao] ?? i.decisao : 'pendente'}
                </span>
                {i.risk && <span className="sec-badge">risco {RISK_LABEL[i.risk] ?? i.risk}</span>}
                <span className="sec-espaco" />
                {(i.resolvidoEm ?? i.pedidoEm) && (
                  <time dateTime={(i.resolvidoEm ?? i.pedidoEm)!} title={(i.resolvidoEm ?? i.pedidoEm)!} className="dim">
                    {formatAgo((i.resolvidoEm ?? i.pedidoEm)!)}
                  </time>
                )}
              </div>
              <div className="sec-acao">{i.action}</div>
              <div className="sec-meta dim">
                {i.por ? (
                  <>
                    decidida por <strong>{i.por}</strong>
                  </>
                ) : (
                  'sem decisão registrada'
                )}
                {i.pedidoPor && <> · pedida por {i.pedidoPor === 'gate' ? 'gate pré-execução' : 'política'}</>}
                {i.sessionId && (
                  <>
                    {' · '}
                    {existeSessao(i.sessionId) ? (
                      <button className="linkish" onClick={() => onSelectSession(i.sessionId!)}>
                        {i.sessionId}
                      </button>
                    ) : (
                      <code>{i.sessionId}</code>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
