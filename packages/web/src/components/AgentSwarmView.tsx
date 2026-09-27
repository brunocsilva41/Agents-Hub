import React from 'react';
import type { AgentSummary } from '@agents-hub/client';
import { agentColor } from '../hub';
import type { Situacao } from '../lib/indexStatus';
import { EstadoDaTela } from './EstadoDaTela';

interface Props {
  agents: AgentSummary[];
  onNewSession: (agentId: string) => void;
  /** Situação de `/agents`: sem resposta não é "0 de 0 agentes". */
  situacao: Situacao;
  erro: string | null;
  onRetry: () => void;
}

export function AgentSwarmView({ agents, onNewSession, situacao, erro, onRetry }: Props): React.JSX.Element {
  if (situacao === 'carregando' || situacao === 'erro') {
    return (
      <div className="swarm-container">
        <div className="swarm-header">
          <h2 className="swarm-title">Swarm de Agentes Conectados</h2>
        </div>
        <EstadoDaTela situacao={situacao} oQue="os agentes" erro={erro} onTentar={onRetry} />
      </div>
    );
  }
  if (situacao === 'vazio') {
    return (
      <div className="swarm-container">
        <div className="swarm-header">
          <h2 className="swarm-title">Swarm de Agentes Conectados</h2>
        </div>
        <div className="empty estado-tela">
          <div className="empty-title">Nenhum agente registrado no Hub</div>
          <span className="empty-hint">
            O daemon não tem manifesto de agente carregado. Rode <code>hub doctor</code> para ver o motivo.
          </span>
          <div className="estado-vazio-acoes">
            <button type="button" onClick={onRetry}>
              Verificar de novo
            </button>
          </div>
        </div>
      </div>
    );
  }
  // Contagem real, calculada da sondagem de instalação de cada agente — o texto
  // antes era fixo ("8 de 9") e ficava errado assim que a lista de agentes ou
  // o que está instalado nesta máquina mudasse.
  const instalados = agents.filter((a) => a.probe?.installed === true).length;

  return (
    <div className="swarm-container">
      <div className="swarm-header">
        <div>
          <h2 className="swarm-title">Swarm de Agentes Conectados</h2>
          <p className="swarm-subtitle">
            {instalados} de {agents.length} agentes de IA integrados e prontos para orquestração autônoma e colaborativa pelo Agents-Hub.
          </p>
        </div>
      </div>

      <div className="swarm-grid">
        {agents.map((agent) => {
          const isInstalled = agent.probe?.installed === true;
          const color = agentColor(agent.id);

          return (
            <div
              key={agent.id}
              className={`swarm-card ${isInstalled ? 'card-online' : 'card-offline'}`}
              style={{ '--agent-theme': color } as React.CSSProperties}
            >
              <div className="swarm-card-top">
                <div className="swarm-avatar-wrap">
                  <div
                    className="swarm-avatar"
                    style={{ background: color }}
                  >
                    {agent.id.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="swarm-agent-name">{agent.name}</h3>
                    <span className="swarm-vendor">{agent.vendor} · <code className="swarm-id">{agent.id}</code></span>
                  </div>
                </div>

                <span className={`swarm-status-pill ${isInstalled ? 'pill-online' : 'pill-offline'}`}>
                  <span className="dot-radar" style={{ background: isInstalled ? 'var(--ok)' : 'var(--text-faint)' }} />
                  {isInstalled ? `v${agent.probe?.version ?? 'detectado'}` : 'Não Instalado'}
                </span>
              </div>

              <p className="swarm-desc">{agent.description}</p>

              <div className="swarm-capabilities">
                <span className="swarm-cap-title">Capacidades:</span>
                <div className="swarm-caps-list">
                  {agent.capabilities.map((cap) => (
                    <span key={cap} className="cap-badge">{cap}</span>
                  ))}
                  <span className="cap-badge format-badge">stream: {agent.streamFormat}</span>
                  <span className="cap-badge strategy-badge">strategy: {agent.sessionStrategy}</span>
                </div>
              </div>

              {agent.caveats && agent.caveats.length > 0 && (
                <div className="swarm-caveats">
                  {agent.caveats.map((c, i) => (
                    <div key={i} className="caveat-item">⚠ {c}</div>
                  ))}
                </div>
              )}

              <div className="swarm-card-actions">
                <button
                  className="primary btn-start-agent"
                  disabled={!isInstalled}
                  onClick={() => onNewSession(agent.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                  <span>Iniciar Sessão</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
