import type { GraphSummary } from '@agents-hub/client';
import { agentColor, formatTokens, formatUsd } from '../hub';

interface Props {
  nodes: GraphSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  depth?: number;
}

/**
 * O grafo de chamadas é a NAVEGAÇÃO, não um enfeite.
 *
 * Clicar num nó abre a timeline daquele agente — é assim que você desce de
 * "o fluxo inteiro" para "o que exatamente o Codex fez aqui" sem precisar
 * decorar id nenhum.
 */
export function FlowTree({ nodes, selectedId, onSelect, depth = 0 }: Props) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.sessionId}>
          <div
            className={`node${node.sessionId === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(node.sessionId)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(node.sessionId);
            }}
          >
            <span className={`dot ${node.state}`} style={{ marginTop: 5 }} />
            <div className="node-body">
              <div className="node-line">
                <span className="node-agent" style={{ color: agentColor(node.agentId) }}>
                  {node.agentId}
                </span>
                <span className="node-cost">
                  {formatUsd(node.usd)} · {formatTokens(node.tokens)}
                </span>
              </div>
              <div className="node-title" title={node.title ?? node.sessionId}>
                {node.title ?? node.sessionId}
              </div>
            </div>
          </div>

          {node.children.length > 0 && (
            <div className="children">
              <FlowTree
                nodes={node.children}
                selectedId={selectedId}
                onSelect={onSelect}
                depth={depth + 1}
              />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
