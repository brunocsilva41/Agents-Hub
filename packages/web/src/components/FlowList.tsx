import { memo, useCallback, useRef } from 'react';
import { agentColor, formatAgo, isLiveState, STATE_LABEL } from '../hub';
import type { FlowSummary } from '../useHubState';
import { useFlowGraph } from '../useHubState';
import { FlowTree } from './FlowTree';

interface Props {
  flows: FlowSummary[];
  selectedId: string | null;
  /** Raiz do fluxo selecionado — fica sempre aberta. */
  selectedRootId: string | null;
  expanded: ReadonlySet<string>;
  onToggle: (rootId: string) => void;
  onSelect: (sessionId: string) => void;
  revision: number;
}

/**
 * Lista de fluxos, colapsada por padrão.
 *
 * Antes cada fluxo vinha aberto e com o grafo carregado, o que dava uma
 * requisição `/graph` e outra `/budget` POR RAIZ a cada evento estrutural — 54
 * requisições e ~865 ms de rede só para desenhar uma barra lateral onde quase
 * tudo já tinha terminado. O cabeçalho do fluxo é montado com o que a lista de
 * sessões já traz; o grafo (única fonte do custo por nó) só é buscado quando
 * alguém abre o fluxo.
 */
export function FlowList({
  flows,
  selectedId,
  selectedRootId,
  expanded,
  onToggle,
  onSelect,
  revision,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Setas navegam entre os fluxos; sem isto a única forma de percorrer a lista
  // por teclado é Tab, que passa por cada nó de cada árvore aberta.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    e.preventDefault();
    items[Math.min(items.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }, []);

  return (
    <div ref={listRef} onKeyDown={onKeyDown}>
      {flows.map((flow) => (
        <FlowItem
          key={flow.rootId}
          flow={flow}
          open={expanded.has(flow.rootId) || flow.rootId === selectedRootId}
          selectedId={selectedId}
          onToggle={onToggle}
          onSelect={onSelect}
          revision={revision}
        />
      ))}
    </div>
  );
}

const FlowItem = memo(function FlowItem({
  flow,
  open,
  selectedId,
  onToggle,
  onSelect,
  revision,
}: {
  flow: FlowSummary;
  open: boolean;
  selectedId: string | null;
  onToggle: (rootId: string) => void;
  onSelect: (sessionId: string) => void;
  revision: number;
}) {
  // `null` enquanto fechado: o hook não busca nada de um fluxo que ninguém vê.
  const graph = useFlowGraph(open ? flow.rootId : null, revision);
  const contains = flow.sessions.some((s) => s.id === selectedId);

  return (
    <div className={`flow${contains ? ' flow-selected' : ''}`}>
      <button
        className="flow-head"
        data-nav
        aria-expanded={open}
        onClick={() => {
          onToggle(flow.rootId);
          // Abrir um fluxo é quase sempre querer ver o que ele fez: leva junto
          // a sessão que pede atenção, ou a mais recente.
          if (!contains) {
            const target =
              flow.sessions.find((s) => isLiveState(s.state)) ?? flow.sessions[0];
            if (target) onSelect(target.id);
          }
        }}
      >
        <span className={`dot ${flow.state}`} aria-hidden="true" />
        <span className="flow-head-body">
          <span className="flow-line">
            <span className="flow-agents">
              {flow.agents.map((id) => (
                <span key={id} style={{ color: agentColor(id) }}>
                  {id}
                </span>
              ))}
              {flow.sessions.length > flow.agents.length && (
                <span className="flow-count">{flow.sessions.length} sessões</span>
              )}
            </span>
            <span className="flow-when">{formatAgo(flow.updatedAt)}</span>
          </span>
          <span className="flow-title" title={flow.title}>
            {flow.title}
          </span>
          <span className="flow-state">{STATE_LABEL[flow.state] ?? flow.state}</span>
        </span>
        <span className="chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open &&
        (graph === null ? (
          <div className="flow-loading" role="status">
            carregando o grafo…
          </div>
        ) : (
          <div className="flow-tree">
            <FlowTree nodes={graph} selectedId={selectedId} onSelect={onSelect} />
          </div>
        ))}
    </div>
  );
});
