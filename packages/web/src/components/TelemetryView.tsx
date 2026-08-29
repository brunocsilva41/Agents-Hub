import React from 'react';
import type { SessionSummary, AgentSummary } from '@agents-hub/client';
import type { FlowSummary } from '../useHubState';
import { agentColor } from '../hub';

interface Props {
  sessions: SessionSummary[];
  flows: FlowSummary[];
  agents: AgentSummary[];
}

export function TelemetryView({ sessions, flows }: Props): React.JSX.Element {
  const activeSessions = sessions.filter((s) => s.state === 'running' || s.state === 'waiting_approval').length;
  const completedSessions = sessions.filter((s) => s.state === 'completed').length;
  const successRate = sessions.length > 0 ? Math.round((completedSessions / sessions.length) * 100) : 100;

  // Sessões por Agente
  const byAgent: Record<string, { count: number; active: number }> = {};
  for (const s of sessions) {
    if (!byAgent[s.agentId]) {
      byAgent[s.agentId] = { count: 0, active: 0 };
    }
    const current = byAgent[s.agentId]!;
    current.count += 1;
    if (s.state === 'running' || s.state === 'waiting_approval') {
      current.active += 1;
    }
  }

  return (
    <div className="telemetry-page">
      <div className="telemetry-header">
        <div>
          <h2 className="telemetry-title">Telemetria & Métricas do Hub</h2>
          <p className="telemetry-subtitle">Atividade dos agentes, distribuição de sessões e performance operacional em tempo real.</p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Total de Sessões</div>
          <div className="kpi-val highlight-cyan">{sessions.length}</div>
          <div className="kpi-sub">Execuções registradas no banco</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Fluxos Orquestrados</div>
          <div className="kpi-val highlight-purple">{flows.length}</div>
          <div className="kpi-sub">Grafos e árvores de tarefas</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Sessões Ativas / Ao Vivo</div>
          <div className="kpi-val highlight-green">{activeSessions} <span className="kpi-total">/ {sessions.length}</span></div>
          <div className="kpi-sub">{activeSessions > 0 ? 'Processos rodando' : 'Cluster ocioso'}</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Taxa de Conclusão</div>
          <div className="kpi-val highlight-amber">{successRate}%</div>
          <div className="kpi-sub">{completedSessions} sessões concluídas</div>
        </div>
      </div>

      {/* Tabela de Atividade por Agente */}
      <div className="telemetry-section">
        <h3 className="section-title">Distribuição de Sessões por Agente</h3>
        <div className="agent-telemetry-table-wrap">
          <table className="telemetry-table">
            <thead>
              <tr>
                <th>Agente</th>
                <th>Sessões Totais</th>
                <th>Sessões Ativas</th>
                <th>Participação no Volume</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(byAgent).map(([agentId, data]) => {
                const pct = sessions.length > 0 ? ((data.count / sessions.length) * 100).toFixed(1) : '0';
                return (
                  <tr key={agentId}>
                    <td>
                      <div className="table-agent-cell">
                        <span className="dot" style={{ background: agentColor(agentId) }} />
                        <strong>{agentId}</strong>
                      </div>
                    </td>
                    <td>{data.count}</td>
                    <td><code className="mono">{data.active}</code></td>
                    <td>
                      <div className="pct-bar-wrap">
                        <div className="pct-bar" style={{ width: `${pct}%`, background: agentColor(agentId) }} />
                        <span>{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
