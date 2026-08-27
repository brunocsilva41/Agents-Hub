import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@agents-hub/core';
import { describeEvent } from '../eventView';
import { agentColor, timeOf } from '../hub';

interface Props {
  events: EventEnvelope[];
  showVerbose: boolean;
  /** Numa visão de fluxo, vários agentes escrevem na mesma timeline. */
  showAgent: boolean;
}

/**
 * Timeline unificada: os oito agentes aparecem no mesmo formato, na mesma
 * ordem, com a cor do agente como única distinção. É o que permite ler um
 * fluxo com três agentes como se fosse uma conversa só.
 */
export function Timeline({ events, showVerbose, showAgent }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const visible = useMemo(
    () =>
      events
        .map((event) => ({ event, view: describeEvent(event) }))
        .filter(({ view }) => (showVerbose ? true : !view.verbose) && view.text.trim().length > 0),
    [events, showVerbose],
  );

  // Auto-scroll só enquanto você está no fim. Se rolou para cima para ler algo,
  // a chegada de eventos novos não pode arrancar a página de baixo de você.
  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, pinned]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  if (visible.length === 0) {
    return <div className="empty">nenhum evento ainda</div>;
  }

  return (
    <div className="scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="timeline">
        {visible.map(({ event, view }) => (
          <div key={event.id} className={`ev ev-${view.kind}`}>
            <span className="ev-time">{timeOf(event.ts)}</span>
            <span className="ev-agent" style={{ color: agentColor(event.agentId) }}>
              {showAgent ? event.agentId : ''}
            </span>
            <span className="ev-text">{view.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
