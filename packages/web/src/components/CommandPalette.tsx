import React, { useEffect, useState, useRef } from 'react';
import type { AgentSummary, SessionSummary } from '@agents-hub/client';
import { agentColor } from '../hub';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  sessions: SessionSummary[];
  agents: AgentSummary[];
  onSelectSession: (id: string) => void;
  onNewSession: (agentId?: string) => void;
}

export function CommandPalette({
  isOpen,
  onClose,
  sessions,
  agents,
  onSelectSession,
  onNewSession,
}: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
      } else if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const cleanQuery = query.toLowerCase().trim();

  const filteredSessions = sessions.filter(
    (s) =>
      s.id.toLowerCase().includes(cleanQuery) ||
      (s.title ?? '').toLowerCase().includes(cleanQuery) ||
      s.agentId.toLowerCase().includes(cleanQuery),
  ).slice(0, 6);

  const filteredAgents = agents.filter(
    (a) =>
      a.id.toLowerCase().includes(cleanQuery) ||
      a.name.toLowerCase().includes(cleanQuery) ||
      a.vendor.toLowerCase().includes(cleanQuery),
  );

  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <div className="cmd-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cmd-input-wrap">
          <svg className="cmd-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="cmd-input"
            placeholder="Buscar sessões, agentes ou ações rápidas… (Esc para fechar)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="cmd-badge">ESC</kbd>
        </div>

        <div className="cmd-results">
          <div className="cmd-group">
            <div className="cmd-group-title">Ações Rápidas</div>
            <button
              className="cmd-item"
              onClick={() => {
                onClose();
                onNewSession();
              }}
            >
              <span className="cmd-icon-action">+</span>
              <span className="cmd-item-label">Criar Nova Sessão</span>
              <kbd className="cmd-kbd">N</kbd>
            </button>
          </div>

          {filteredAgents.length > 0 && (
            <div className="cmd-group">
              <div className="cmd-group-title">Iniciar com Agente ({filteredAgents.length})</div>
              {filteredAgents.map((agent) => (
                <button
                  key={agent.id}
                  className="cmd-item"
                  onClick={() => {
                    onClose();
                    onNewSession(agent.id);
                  }}
                >
                  <span
                    className="cmd-agent-dot"
                    style={{ background: agentColor(agent.id) }}
                  />
                  <span className="cmd-item-label">{agent.name}</span>
                  <span className="cmd-item-meta">{agent.vendor} · {agent.id}</span>
                </button>
              ))}
            </div>
          )}

          {filteredSessions.length > 0 && (
            <div className="cmd-group">
              <div className="cmd-group-title">Sessões ({filteredSessions.length})</div>
              {filteredSessions.map((session) => (
                <button
                  key={session.id}
                  className="cmd-item"
                  onClick={() => {
                    onClose();
                    onSelectSession(session.id);
                  }}
                >
                  <span
                    className="cmd-agent-tag"
                    style={{ color: agentColor(session.agentId) }}
                  >
                    {session.agentId}
                  </span>
                  <span className="cmd-item-label">{session.title || session.id}</span>
                  <span className={`cmd-status-badge state-${session.state}`}>
                    {session.state}
                  </span>
                </button>
              ))}
            </div>
          )}

          {filteredAgents.length === 0 && filteredSessions.length === 0 && (
            <div className="cmd-empty">Nenhum resultado encontrado para "{query}"</div>
          )}
        </div>
      </div>
    </div>
  );
}
