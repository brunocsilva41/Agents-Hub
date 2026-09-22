import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@agents-hub/core';
import { viewOf } from '../eventView';
import { agentColor, timeOf } from '../hub';

interface Props {
  events: EventEnvelope[];
  showVerbose: boolean;
  showAgent: boolean;
  loading: boolean;
  /** `true` quando a última busca de eventos falhou — timeline vazia por erro
   * de rede não pode ser mostrada como "sessão sem eventos". */
  failed?: boolean;
}

const WINDOW = 400;
const WINDOW_STEP = 800;

export function Timeline({ events, showVerbose, showAgent, loading, failed = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [window_, setWindow] = useState(WINDOW);

  const visible = useMemo(
    () =>
      events.filter((event) => {
        const view = viewOf(event);
        return (showVerbose || !view.verbose) && view.text.trim().length > 0;
      }),
    [events, showVerbose],
  );

  const first = visible[0]?.id;
  useEffect(() => setWindow(WINDOW), [showVerbose, first]);

  const hidden = Math.max(0, visible.length - window_);
  const shown = hidden > 0 ? visible.slice(hidden) : visible;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (pinned && el) el.scrollTop = el.scrollHeight;
  }, [shown.length, pinned]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setPinned((current) => (current === atBottom ? current : atBottom));
  };

  if (loading) {
    return (
      <div className="timeline-loading-skeleton" role="status" aria-label="Carregando timeline">
        <div className="skeleton-item" style={{ width: '40%' }} />
        <div className="skeleton-item" style={{ width: '85%' }} />
        <div className="skeleton-item" style={{ width: '65%' }} />
        <div className="skeleton-item" style={{ width: '90%' }} />
        <div className="skeleton-item" style={{ width: '50%' }} />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="empty timeline-empty-state" role="alert">
        <div className="empty-icon">⚠️</div>
        <div className="empty-title">Falha ao carregar os eventos desta sessão</div>
        <span className="empty-hint">
          Não é uma sessão sem eventos — a busca falhou (rede instável ou daemon reiniciando).
          Tente selecionar a sessão de novo.
        </span>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="empty timeline-empty-state">
        <div className="empty-icon">💬</div>
        <div className="empty-title">Nenhum evento {showVerbose ? '' : 'visível '}nesta sessão</div>
        {!showVerbose && (
          <span className="empty-hint">
            Raciocínio, deltas e logs internos estão ocultos — ative a opção <strong>“detalhado”</strong> no topo.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="timeline-wrap">
      <div className="scroll timeline-scroll-container" ref={scrollRef} onScroll={onScroll}>
        <div
          className={`timeline${showAgent ? ' with-agent' : ''}`}
          role="log"
          aria-live="off"
          aria-label="Eventos da sessão"
        >
          {hidden > 0 && (
            <div className="timeline-more">
              <button className="btn-load-more" onClick={() => setWindow((n) => n + WINDOW_STEP)}>
                ↑ Carregar {Math.min(hidden, WINDOW_STEP)} eventos anteriores
              </button>
              <span className="empty-hint">{hidden} ocultos acima</span>
            </div>
          )}

          {shown.map((event) => (
            <EventRow key={event.id} event={event} showAgent={showAgent} />
          ))}
        </div>
      </div>

      {!pinned && (
        <button
          className="jump-bottom"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setPinned(true);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <polyline points="19 12 12 19 5 12"></polyline>
          </svg>
          <span>Ir para o fim</span>
        </button>
      )}
    </div>
  );
}

const EventRow = memo(function EventRow({
  event,
  showAgent,
}: {
  event: EventEnvelope;
  showAgent: boolean;
}) {
  const view = viewOf(event);
  const color = agentColor(event.agentId);
  const [expandedCoT, setExpandedCoT] = useState(false);

  // 1. Bloco de Raciocínio (Chain of Thought)
  if (view.kind === 'reasoning') {
    return (
      <div className="ev-bubble ev-reasoning-bubble">
        <div className="ev-reasoning-header" onClick={() => setExpandedCoT((v) => !v)}>
          <span className="ev-reasoning-icon">🧠</span>
          <span className="ev-reasoning-title">Raciocínio Interno ({event.agentId})</span>
          <span className="ev-time">{timeOf(event.ts)}</span>
          <span className={`ev-chevron ${expandedCoT ? 'rotated' : ''}`}>▸</span>
        </div>
        {expandedCoT && (
          <div className="ev-reasoning-body">
            <pre className="ev-text">{view.text}</pre>
          </div>
        )}
      </div>
    );
  }

  // 2. Bloco de Tool Call / Command / File
  if (view.kind === 'tool' || view.kind === 'command' || view.kind === 'file') {
    return (
      <div className={`ev-bubble ev-tool-card ev-card-${view.kind}`}>
        <div className="ev-tool-header">
          <div className="ev-tool-title-wrap">
            <span className="ev-tool-badge">
              {view.kind === 'command' ? 'TERMINAL' : view.kind === 'file' ? 'FILE_OP' : 'TOOL_CALL'}
            </span>
            {showAgent && (
              <span className="ev-agent-pill" style={{ color }}>{event.agentId}</span>
            )}
          </div>
          <span className="ev-time">{timeOf(event.ts)}</span>
        </div>
        <div className="ev-tool-body">
          <pre className="ev-text">{view.text}</pre>
        </div>
      </div>
    );
  }

  // 3. Handoff Banner
  if (view.kind === 'handoff') {
    return (
      <div className="ev-bubble ev-handoff-banner">
        <div className="ev-handoff-icon">🔄</div>
        <div className="ev-handoff-content">
          <div className="ev-handoff-title">Transferência de Controle (Handoff)</div>
          <div className="ev-text">{view.text}</div>
        </div>
        <span className="ev-time">{timeOf(event.ts)}</span>
      </div>
    );
  }

  // 4. Mensagem Normal / Resposta do Agente
  return (
    <div className={`ev-bubble ev-message-bubble ${event.agentId ? 'from-agent' : 'from-user'}`}>
      <div className="ev-bubble-avatar-col">
        <div
          className="ev-avatar"
          style={{ background: color }}
        >
          {event.agentId.slice(0, 2).toUpperCase()}
        </div>
      </div>

      <div className="ev-bubble-main">
        <div className="ev-bubble-header">
          <span className="ev-bubble-author" style={{ color }}>{event.agentId}</span>
          <span className="ev-time">{timeOf(event.ts)}</span>
        </div>
        <div className="ev-bubble-content">
          <span className="ev-text">{view.text}</span>
        </div>
      </div>
    </div>
  );
});
