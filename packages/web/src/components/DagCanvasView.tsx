import React from 'react';
import type { FlowSummary } from '../useHubState';
import { agentColor, STATE_LABEL, formatAgo } from '../hub';

interface Props {
  flows: FlowSummary[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

export function DagCanvasView({
  flows,
  selectedId,
  onSelectSession,
  onNewSession,
}: Props): React.JSX.Element {
  if (flows.length === 0) {
    return (
      <div className="dag-empty-canvas">
        <div className="dag-empty-icon">🕸</div>
        <h3>Nenhum Grafo DAG em Execução</h3>
        <p>Inicie uma sessão para visualizar o grafo de tarefas e delegações entre agentes em tempo real.</p>
        <button className="primary" onClick={onNewSession}>Criar Nova Sessão</button>
      </div>
    );
  }

  return (
    <div className="dag-canvas-container">
      <div className="dag-canvas-header">
        <div>
          <h2 className="dag-title">Grafo de Orquestração DAG</h2>
          <p className="dag-subtitle">Visualização topológica dos fluxos, sub-sessões e transferências entre agentes.</p>
        </div>
      </div>

      <div className="dag-flows-list">
        {flows.map((flow) => {
          const root = flow.sessions[flow.sessions.length - 1] ?? flow.sessions[0];
          if (!root) return null;
          const isSelected = selectedId === root.id;

          return (
            <div key={flow.rootId} className={`dag-flow-cluster ${isSelected ? 'dag-selected' : ''}`}>
              <div className="dag-cluster-header">
                <div className="dag-cluster-title">
                  <span className="dot running" />
                  <strong>Fluxo #{flow.rootId.slice(4, 12)}</strong>
                  <span className="dag-cluster-when">{formatAgo(flow.updatedAt)}</span>
                </div>
                <div className="dag-cluster-agents">
                  {flow.agents.map((ag: string) => (
                    <span
                      key={ag}
                      className="dag-agent-badge"
                      style={{ color: agentColor(ag), borderColor: agentColor(ag) }}
                    >
                      {ag}
                    </span>
                  ))}
                  <span className="dag-cost-badge">{flow.sessions.length} sessões</span>
                </div>
              </div>

              {/* Nós do DAG */}
              <div className="dag-nodes-lane">
                <div
                  className={`dag-node-card ${selectedId === root.id ? 'node-active' : ''}`}
                  style={{ '--node-color': agentColor(root.agentId) } as React.CSSProperties}
                  onClick={() => onSelectSession(root.id)}
                >
                  <div className="dag-node-header">
                    <div className="dag-node-id-wrap">
                      <span className="dag-node-avatar" style={{ background: agentColor(root.agentId) }}>
                        {root.agentId.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <div className="dag-node-agent">{root.agentId}</div>
                        <div className="dag-node-role">Root Coordinator</div>
                      </div>
                    </div>
                    <span className={`session-state-pill state-${root.state}`}>
                      {STATE_LABEL[root.state] ?? root.state}
                    </span>
                  </div>

                  <div className="dag-node-title">{root.title || 'Sem título'}</div>

                  <div className="dag-node-footer">
                    <span>{formatAgo(root.updatedAt)}</span>
                    <span className="dag-node-cost">ID: {root.id.slice(0, 10)}</span>
                  </div>
                </div>

                {/* Sub-nós do fluxo se houver */}
                {flow.sessions.length > 1 && (
                  <div className="dag-children-lane">
                    <div className="dag-connector-arrow">➔</div>
                    {flow.sessions.slice(0, flow.sessions.length - 1).map((sub) => (
                      <div
                        key={sub.id}
                        className={`dag-node-card ${selectedId === sub.id ? 'node-active' : ''}`}
                        style={{ '--node-color': agentColor(sub.agentId) } as React.CSSProperties}
                        onClick={() => onSelectSession(sub.id)}
                      >
                        <div className="dag-node-header">
                          <div className="dag-node-id-wrap">
                            <span className="dag-node-avatar" style={{ background: agentColor(sub.agentId) }}>
                              {sub.agentId.slice(0, 2).toUpperCase()}
                            </span>
                            <div>
                              <div className="dag-node-agent">{sub.agentId}</div>
                              <div className="dag-node-role">Sub-agent / Task</div>
                            </div>
                          </div>
                          <span className={`session-state-pill state-${sub.state}`}>
                            {STATE_LABEL[sub.state] ?? sub.state}
                          </span>
                        </div>
                        <div className="dag-node-title">{sub.title || 'Tarefa secundária'}</div>
                        <div className="dag-node-footer">
                          <span>{formatAgo(sub.updatedAt)}</span>
                          <span className="dag-node-cost">ID: {sub.id.slice(0, 10)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
