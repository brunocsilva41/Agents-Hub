import type { GraphSummary } from '@agents-hub/client';
import { agentColor, formatTokens, formatUsdShort, STATE_LABEL } from '../hub';

interface Props {
  nodes: GraphSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** `true` quando a busca do grafo falhou — vazio por erro, não por fluxo sem sessões. */
  failed?: boolean;
}

export function FlowTree({ nodes, selectedId, onSelect, failed = false }: Props) {
  if (nodes.length === 0) {
    if (failed) {
      return (
        <div className="flow-loading" role="alert">
          ⚠️ Falha ao carregar o grafo deste fluxo — não é um fluxo sem sessões, a busca falhou.
        </div>
      );
    }
    return <div className="flow-loading">Este fluxo não possui sessões registradas</div>;
  }

  return (
    <div className="flow-tree-container">
      {nodes.map((node) => {
        const isSelected = node.sessionId === selectedId;
        const color = agentColor(node.agentId);

        return (
          <div key={node.sessionId} className="tree-node-wrapper">
            <button
              className={`node${isSelected ? ' selected' : ''}`}
              data-nav
              aria-current={isSelected ? 'true' : undefined}
              onClick={() => onSelect(node.sessionId)}
            >
              <div className="node-status-col">
                <span className={`dot ${node.state}`} aria-hidden="true" />
              </div>
              <div className="node-body">
                <div className="node-line">
                  <span className="node-agent" style={{ color }}>
                    {node.agentId}
                  </span>
                  <span className="node-cost-badge">
                    {formatUsdShort(node.usd)} · {formatTokens(node.tokens)}
                  </span>
                </div>
                <div className="node-title" title={node.title ?? node.sessionId}>
                  {node.title || node.sessionId}
                </div>
              </div>
              <span className="sr-only">{STATE_LABEL[node.state] ?? node.state}</span>
            </button>

            {node.children.length > 0 && (
              <div className="children">
                <FlowTree nodes={node.children} selectedId={selectedId} onSelect={onSelect} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
