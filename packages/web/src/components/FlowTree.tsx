import type { GraphSummary } from '@agents-hub/client';
import { agentColor, formatTokens, formatUsdShort, STATE_LABEL } from '../hub';

interface Props {
  nodes: GraphSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}

/**
 * O grafo de chamadas é a NAVEGAÇÃO, não um enfeite.
 *
 * Clicar num nó abre a timeline daquele agente — é assim que você desce de
 * "o fluxo inteiro" para "o que exatamente o Codex fez aqui" sem precisar
 * decorar id nenhum.
 */
export function FlowTree({ nodes, selectedId, onSelect }: Props) {
  if (nodes.length === 0) {
    return <div className="flow-loading">este fluxo não tem sessões registradas</div>;
  }

  return (
    <>
      {nodes.map((node) => (
        <div key={node.sessionId}>
          {/* <button> de verdade em vez de div[role=button]: Enter, Espaço, foco
              e semântica vêm do navegador. A versão manual não chamava
              preventDefault no Espaço, então selecionar rolava a página. */}
          <button
            className={`node${node.sessionId === selectedId ? ' selected' : ''}`}
            data-nav
            aria-current={node.sessionId === selectedId ? 'true' : undefined}
            onClick={() => onSelect(node.sessionId)}
          >
            <span className={`dot ${node.state}`} aria-hidden="true" />
            <span className="node-body">
              <span className="node-line">
                <span className="node-agent" style={{ color: agentColor(node.agentId) }}>
                  {node.agentId}
                </span>
                <span className="node-cost">
                  {formatUsdShort(node.usd)} · {formatTokens(node.tokens)}
                </span>
              </span>
              <span className="node-title" title={node.title ?? node.sessionId}>
                {node.title ?? node.sessionId}
              </span>
            </span>
            <span className="sr-only">{STATE_LABEL[node.state] ?? node.state}</span>
          </button>

          {node.children.length > 0 && (
            <div className="children">
              <FlowTree nodes={node.children} selectedId={selectedId} onSelect={onSelect} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
