import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@agents-hub/core';
import { viewOf } from '../eventView';
import { agentColor, timeOf } from '../hub';

interface Props {
  events: EventEnvelope[];
  showVerbose: boolean;
  /** Numa visão de fluxo, vários agentes escrevem na mesma timeline. */
  showAgent: boolean;
  loading: boolean;
}

/**
 * Quantos eventos ficam no DOM.
 *
 * Não há virtualização porque as linhas têm altura variável (o texto quebra), e
 * medir cada uma custaria mais do que se ganha. A janela resolve o mesmo
 * problema de forma direta: o DOM fica limitado a algumas centenas de nós por
 * mais falante que a sessão seja, e quem quiser o começo pede.
 */
const WINDOW = 400;
const WINDOW_STEP = 800;

/**
 * Timeline unificada: os oito agentes aparecem no mesmo formato, na mesma
 * ordem, com a cor do agente como única distinção. É o que permite ler um
 * fluxo com três agentes como se fosse uma conversa só.
 */
export function Timeline({ events, showVerbose, showAgent, loading }: Props) {
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

  // Trocar de sessão ou de escopo recomeça a janela: herdar o "carregar mais"
  // da sessão anterior deixaria o DOM crescendo sessão após sessão.
  const first = visible[0]?.id;
  useEffect(() => setWindow(WINDOW), [showVerbose, first]);

  const hidden = Math.max(0, visible.length - window_);
  const shown = hidden > 0 ? visible.slice(hidden) : visible;

  // Auto-scroll só enquanto você está no fim. Se rolou para cima para ler algo,
  // a chegada de eventos novos não pode arrancar a página de baixo de você.
  //
  // `scrollTop` direto, e não `scrollIntoView`: aquele rola também os
  // contêineres acima e força um layout síncrono a cada evento que chega.
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
      <div className="empty" role="status">
        carregando a timeline…
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="empty">
        nenhum evento {showVerbose ? '' : 'visível '}nesta sessão.
        {!showVerbose && (
          <>
            <br />
            <span className="empty-hint">
              raciocínio e logs internos estão ocultos — troque para “detalhado”.
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="timeline-wrap">
      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        {/* aria-live desligado de propósito: um agente falante emitiria centenas
            de anúncios por minuto. `role="log"` mantém a navegação por leitor de
            tela sem transformar a timeline em ruído. */}
        <div
          className={`timeline${showAgent ? ' with-agent' : ''}`}
          role="log"
          aria-live="off"
          aria-label="Eventos da sessão"
        >
          {hidden > 0 && (
            <div className="timeline-more">
              <button onClick={() => setWindow((n) => n + WINDOW_STEP)}>
                carregar {Math.min(hidden, WINDOW_STEP)} eventos anteriores
              </button>
              <span className="empty-hint">{hidden} ocultos acima</span>
            </div>
          )}

          {shown.map((event) => (
            <Row key={event.id} event={event} showAgent={showAgent} />
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
          ↓ acompanhar o fim
        </button>
      )}
    </div>
  );
}

/**
 * Linha memoizada.
 *
 * O envelope nunca muda depois de criado, então uma linha já renderizada nunca
 * precisa render de novo — nem quando chega evento novo, nem quando se digita
 * no campo de mensagem logo abaixo.
 */
const Row = memo(function Row({
  event,
  showAgent,
}: {
  event: EventEnvelope;
  showAgent: boolean;
}) {
  const view = viewOf(event);
  return (
    <div className={`ev ev-${view.kind}`}>
      <span className="ev-time">{timeOf(event.ts)}</span>
      {showAgent && (
        <span className="ev-agent" style={{ color: agentColor(event.agentId) }}>
          {event.agentId}
        </span>
      )}
      <span className="ev-text">{view.text}</span>
    </div>
  );
});
