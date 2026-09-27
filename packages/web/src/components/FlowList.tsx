import { memo, useCallback, useRef } from 'react';
import { agentColor, formatAgo, isLiveState, STATE_LABEL } from '../hub';
import { fluxoAberto, type EstadoDaLista } from '../lib/flowListState';
import type { Situacao } from '../lib/indexStatus';
import type { FlowSummary } from '../useHubState';
import { useFlowGraph } from '../useHubState';
import { EstadoDaTela } from './EstadoDaTela';
import { FlowTree } from './FlowTree';

interface Props {
  flows: FlowSummary[];
  selectedId: string | null;
  /** Raiz do fluxo selecionado — abre sozinha, mas pode ser recolhida. */
  selectedRootId: string | null;
  /** Abertos/recolhidos à mão (`lib/flowListState`). */
  listState: EstadoDaLista;
  onToggle: (rootId: string) => void;
  /** Situação das sessões no índice: carregando/erro não é "nenhum fluxo". */
  situacao: Situacao;
  erro: string | null;
  onRetry: () => void;
  /** Lista vazia por filtro/busca (o Hub tem fluxos): volta a mostrar todos. */
  onShowAll: () => void;
  onNewSession: () => void;
  onSelect: (sessionId: string) => void;
  /**
   * Revisão do grafo POR fluxo: sobe só quando chega evento estrutural daquele
   * fluxo. Com uma revisão global, qualquer evento de qualquer sessão refazia o
   * `/graph` de todo fluxo aberto.
   */
  revisionOf: (rootId: string) => number;
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
  listState,
  onToggle,
  onSelect,
  revisionOf,
  situacao,
  erro,
  onRetry,
  onShowAll,
  onNewSession,
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
      <EstadoDaTela situacao={situacao} oQue="as sessões" erro={erro} onTentar={onRetry} compacto />
      {situacao === 'vazio' && (
        // Hub sem nenhuma sessão: não é filtro, é o começo.
        <div className="empty flow-list-empty">
          <span className="empty-hint">Nenhuma sessão no Hub ainda.</span>
          <div className="estado-vazio-acoes">
            <button type="button" className="primary" onClick={onNewSession}>
              Nova sessão
            </button>
          </div>
        </div>
      )}
      {situacao === 'ok' && flows.length === 0 && (
        // Barra lateral em branco não diz se é filtro, busca ou Hub vazio.
        <div className="empty flow-list-empty">
          <span className="empty-hint">Nenhum fluxo com este filtro ou busca.</span>
          <div className="estado-vazio-acoes">
            <button type="button" onClick={onShowAll}>
              Ver todos
            </button>
          </div>
        </div>
      )}
      {flows.map((flow) => (
        <FlowItem
          key={flow.rootId}
          flow={flow}
          open={fluxoAberto(listState, flow.rootId, selectedRootId)}
          selectedId={selectedId}
          onToggle={onToggle}
          onSelect={onSelect}
          revision={revisionOf(flow.rootId)}
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
  const { graph, failed: graphFailed, retry } = useFlowGraph(open ? flow.rootId : null, revision);
  const contains = flow.sessions.some((s) => s.id === selectedId);

  return (
    <div className={`flow${contains ? ' flow-selected' : ''}${open ? ' flow-open' : ''}`}>
      <button
        className="flow-head"
        data-nav
        aria-expanded={open}
        onClick={() => {
          onToggle(flow.rootId);
          if (!contains) {
            const target =
              flow.sessions.find((s) => isLiveState(s.state)) ?? flow.sessions[0];
            if (target) onSelect(target.id);
          }
        }}
      >
        <span className={`dot ${flow.state}`} aria-hidden="true" />
        <div className="flow-head-body">
          <div className="flow-line">
            <div className="flow-agents">
              {flow.agents.map((id) => (
                <span key={id} className="flow-agent-tag" style={{ color: agentColor(id) }}>
                  {id}
                </span>
              ))}
              {flow.sessions.length > flow.agents.length && (
                <span className="flow-count">· {flow.sessions.length} sessões</span>
              )}
            </div>
            <span className="flow-when">{formatAgo(flow.updatedAt)}</span>
          </div>
          <div className="flow-title" title={flow.title}>
            {flow.title}
          </div>
          <div className="flow-meta-line">
            <span className={`flow-state-badge state-${flow.state}`}>
              {STATE_LABEL[flow.state] ?? flow.state}
            </span>
          </div>
        </div>
        <span className={`chevron-icon${open ? ' rotated' : ''}`} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </span>
      </button>

      {open &&
        (graph === null ? (
          <div className="flow-loading" role="status">
            <span className="spinner-small" /> Carregando árvore do fluxo…
          </div>
        ) : (
          <div className="flow-tree">
            <FlowTree nodes={graph} selectedId={selectedId} onSelect={onSelect} failed={graphFailed} onRetry={retry} />
          </div>
        ))}
    </div>
  );
});
