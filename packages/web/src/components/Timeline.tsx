import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@agents-hub/core';
import { viewOf } from '../lib/eventView';
import { agentColor, timeOf } from '../hub';
import { olderAction, sliceWindow, TIMELINE_WINDOW, TIMELINE_WINDOW_STEP } from '../lib/timelineWindow';

interface Props {
  events: EventEnvelope[];
  showVerbose: boolean;
  showAgent: boolean;
  loading: boolean;
  /** `true` quando a última busca de eventos falhou — timeline vazia por erro
   * de rede não pode ser mostrada como "sessão sem eventos". */
  failed?: boolean;
  /** Troca de sessão/abrangência: volta a acompanhar o fim e fecha a janela. */
  resetKey?: string;
  /** Nenhuma sessão escolhida — não é "sessão sem eventos". */
  unselected?: boolean;
  /** O Hub não tem sessão nenhuma: não há o que escolher ao lado. */
  hubVazio?: boolean;
  /** Há eventos mais antigos no daemon, ainda não pedidos. */
  hasMoreBefore?: boolean;
  loadingOlder?: boolean;
  olderFailed?: boolean;
  onLoadOlder?: () => void;
  /** Próxima tentativa automática (epoch ms), ou `null` quando acabaram. */
  retryAt?: number | null;
  onRetry?: () => void;
}

export function Timeline({
  events,
  showVerbose,
  showAgent,
  loading,
  failed = false,
  resetKey,
  unselected = false,
  hubVazio = false,
  hasMoreBefore = false,
  loadingOlder = false,
  olderFailed = false,
  onLoadOlder,
  retryAt = null,
  onRetry,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [window_, setWindow] = useState(TIMELINE_WINDOW);
  /** Altura antes de crescer para cima: mantém sob os olhos o que se lia. */
  const anchor = useRef<{ height: number; top: number } | null>(null);

  const visible = useMemo(
    () =>
      events.filter((event) => {
        const view = viewOf(event);
        return (showVerbose || !view.verbose) && view.text.trim().length > 0;
      }),
    [events, showVerbose],
  );

  // Outra sessão (ou outra abrangência) é outra leitura: acompanha o fim de
  // novo. Antes `pinned` vazava de uma sessão para a outra.
  useEffect(() => {
    setWindow(TIMELINE_WINDOW);
    setPinned(true);
  }, [showVerbose, resetKey]);

  const { hidden, shown, followKey } = sliceWindow(visible, window_);
  const firstShown = shown[0]?.id;

  // Pendurado no FIM da lista, não no tamanho do que é mostrado: com a janela
  // cheia o tamanho fica constante e a tela parava de acompanhar no 401º evento.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (pinned && el) el.scrollTop = el.scrollHeight;
  }, [followKey, pinned]);

  // Conteúdo novo no topo: devolve a posição relativa ao que já estava na tela.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const saved = anchor.current;
    if (!el || !saved) return;
    anchor.current = null;
    el.scrollTop = el.scrollHeight - saved.height + saved.top;
  }, [firstShown]);

  const remember = (): void => {
    const el = scrollRef.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
  };

  const showOlder = (): void => {
    if (hidden > 0) {
      remember();
      setWindow((n) => n + TIMELINE_WINDOW_STEP);
    } else if (hasMoreBefore && !loadingOlder && onLoadOlder) {
      remember();
      onLoadOlder();
    }
  };

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setPinned((current) => (current === atBottom ? current : atBottom));
    const next = olderAction({
      scrollTop: el.scrollTop,
      hidden,
      hasMoreBefore: hasMoreBefore && !olderFailed && onLoadOlder !== undefined,
      loadingOlder,
    });
    if (next) showOlder();
  };

  if (unselected) {
    return (
      <div className="empty timeline-empty-state timeline-unselected-state">
        <div className="empty-icon">🧭</div>
        <div className="empty-title">
          {hubVazio ? 'Nenhuma sessão no Hub ainda' : 'Nenhuma sessão selecionada'}
        </div>
        <span className="empty-hint">
          {hubVazio
            ? 'Inicie uma em “Nova Sessão” para acompanhar a timeline aqui.'
            : 'Escolha um fluxo ao lado para ver a timeline.'}
        </span>
      </div>
    );
  }

  if (loading && events.length === 0) {
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

  const retryText =
    retryAt !== null
      ? `Tentando de novo automaticamente em ${Math.max(1, Math.round((retryAt - Date.now()) / 1000))} s.`
      : 'As tentativas automáticas acabaram.';

  if (failed && events.length === 0) {
    return (
      <div className="empty timeline-empty-state" role="alert">
        <div className="empty-icon">⚠️</div>
        <div className="empty-title">Falha ao carregar os eventos desta sessão</div>
        <span className="empty-hint">
          Não é uma sessão sem eventos — a busca falhou (rede instável ou daemon reiniciando).{' '}
          {retryText}
        </span>
        {onRetry && (
          <button className="btn-load-more" onClick={onRetry}>
            Tentar de novo agora
          </button>
        )}
      </div>
    );
  }

  if (visible.length === 0 && !hasMoreBefore) {
    return (
      <div className="empty timeline-empty-state">
        <div className="empty-icon">💬</div>
        <div className="empty-title">Nenhum evento {showVerbose ? '' : 'visível '}nesta sessão</div>
        {!showVerbose && (
          <span className="empty-hint">
            Raciocínio, deltas e logs internos estão ocultos — ative a opção <strong>“detalhado”</strong>{' '}
            no topo.
          </span>
        )}
      </div>
    );
  }

  const canLoadMore = hidden > 0 || (hasMoreBefore && onLoadOlder !== undefined);

  return (
    <div className="timeline-wrap">
      {failed && (
        // Há o que mostrar (veio ao vivo), mas o histórico falhou: aviso, não tela cheia.
        <div className="notice warn timeline-notice" role="alert">
          ⚠️ O histórico desta sessão não carregou; mostrando só o que chegou ao vivo. {retryText}
          {onRetry && (
            <button className="linkish" onClick={onRetry}>
              tentar de novo
            </button>
          )}
        </div>
      )}
      <div className="scroll timeline-scroll-container" ref={scrollRef} onScroll={onScroll}>
        <div
          className={`timeline${showAgent ? ' with-agent' : ''}`}
          role="log"
          aria-live="off"
          aria-label="Eventos da sessão"
          aria-busy={loadingOlder}
        >
          {canLoadMore && (
            <div className="timeline-more">
              <button
                className="btn-load-more"
                onClick={showOlder}
                disabled={hidden === 0 && loadingOlder}
              >
                {hidden > 0
                  ? `↑ Mostrar ${Math.min(hidden, TIMELINE_WINDOW_STEP)} eventos anteriores`
                  : loadingOlder
                    ? 'Carregando anteriores…'
                    : olderFailed
                      ? '↻ Falhou — tentar carregar anteriores de novo'
                      : '↑ Carregar eventos anteriores'}
              </button>
              {hidden > 0 && <span className="empty-hint">{hidden} ocultos acima</span>}
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
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
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
        <div
          className="ev-reasoning-header"
          role="button"
          tabIndex={0}
          aria-expanded={expandedCoT}
          onClick={() => setExpandedCoT((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpandedCoT((v) => !v);
            }
          }}
        >
          <span className="ev-reasoning-icon" aria-hidden="true">
            🧠
          </span>
          <span className="ev-reasoning-title">Raciocínio Interno ({event.agentId})</span>
          <span className="ev-time">{timeOf(event.ts)}</span>
          <span className={`ev-chevron ${expandedCoT ? 'rotated' : ''}`} aria-hidden="true">
            ▸
          </span>
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
              <span className="ev-agent-pill" style={{ color }}>
                {event.agentId}
              </span>
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
        <div className="ev-handoff-icon" aria-hidden="true">
          🔄
        </div>
        <div className="ev-handoff-content">
          <div className="ev-handoff-title">Transferência de Controle (Handoff)</div>
          <div className="ev-text">{view.text}</div>
        </div>
        <span className="ev-time">{timeOf(event.ts)}</span>
      </div>
    );
  }

  // 4. Fala do usuário (`user.message`): o lado da conversa que faltava.
  if (view.kind === 'user') {
    return (
      <div className="ev-bubble ev-message-bubble from-user">
        <div className="ev-bubble-main">
          <div className="ev-bubble-header">
            <span className="ev-bubble-author">você{showAgent ? ` → ${event.agentId}` : ''}</span>
            <span className="ev-time">{timeOf(event.ts)}</span>
          </div>
          <div className="ev-bubble-content">
            <span className="ev-text">{view.text}</span>
          </div>
        </div>
      </div>
    );
  }

  // 5. Mensagem Normal / Resposta do Agente
  return (
    <div className="ev-bubble ev-message-bubble from-agent">
      <div className="ev-bubble-avatar-col">
        <div className="ev-avatar" style={{ background: color }}>
          {event.agentId.slice(0, 2).toUpperCase()}
        </div>
      </div>

      <div className="ev-bubble-main">
        <div className="ev-bubble-header">
          <span className="ev-bubble-author" style={{ color }}>
            {event.agentId}
          </span>
          <span className="ev-time">{timeOf(event.ts)}</span>
        </div>
        <div className="ev-bubble-content">
          <span className="ev-text">{view.text}</span>
        </div>
      </div>
    </div>
  );
});
