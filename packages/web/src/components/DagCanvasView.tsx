import React, { useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@agents-hub/client';
import type { FlowSummary } from '../useHubState';
import { agentColor, STATE_LABEL, formatAgo } from '../hub';
import { buildFlowTree, treeKeyTarget, type EdgeKind, type TreeRow } from '../lib/flowTree';

interface Props {
  flows: FlowSummary[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

const EDGE_LABEL: Record<EdgeKind, string> = {
  root: 'Raiz do fluxo',
  delegation: 'Delegada',
  handoff: 'Transferida (handoff)',
};

/**
 * Grafo de orquestração: cada fluxo como ÁRVORE, com aresta por `parentId`.
 *
 * Antes era a raiz e, depois de uma seta, todas as outras sessões numa faixa
 * só — delegação em cadeia (A→B→C) ficava igual a irmãos (A→B, A→C), e os
 * cartões eram `div` clicáveis, fora do alcance do teclado. Agora é um `tree`
 * WAI-ARIA: Tab entra no fluxo, setas navegam (→ filho, ← pai), Enter abre.
 * A árvore sai da lista de sessões que o painel já tem — nenhuma requisição.
 */
export function DagCanvasView({
  flows,
  selectedId,
  onSelectSession,
  onNewSession,
}: Props): React.JSX.Element {
  if (flows.length === 0) {
    return (
      <div className="dag-empty-canvas">
        <div className="dag-empty-icon" aria-hidden="true">🕸</div>
        <h3>Nenhum Grafo DAG em Execução</h3>
        <p>Inicie uma sessão para visualizar o grafo de tarefas e delegações entre agentes em tempo real.</p>
        <button className="primary" onClick={onNewSession}>Criar Nova Sessão</button>
      </div>
    );
  }

  return (
    <div className="dag-canvas-container">
      <div className="dag-canvas-header">
        <div>
          <h2 className="dag-title">Grafo de Orquestração DAG</h2>
          <p className="dag-subtitle">
            Cada fluxo como árvore: quem delegou para quem, e onde houve transferência. Setas navegam; Enter abre a sessão.
          </p>
        </div>
      </div>

      <div className="dag-flows-list">
        {flows.map((flow) => (
          <FlowGraph
            key={flow.rootId}
            flow={flow}
            selectedId={selectedId}
            onSelectSession={onSelectSession}
          />
        ))}
      </div>
    </div>
  );
}

function FlowGraph({
  flow,
  selectedId,
  onSelectSession,
}: {
  flow: FlowSummary;
  selectedId: string | null;
  onSelectSession: (id: string) => void;
}): React.JSX.Element {
  const rows = useMemo(() => buildFlowTree(flow.rootId, flow.sessions), [flow.rootId, flow.sessions]);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = rows.findIndex((r) => r.session.id === selectedId);
  // Tabulação itinerante: um só nó do fluxo na ordem de Tab.
  const [focusIndex, setFocusIndex] = useState(0);
  const tabIndexOf = (i: number): number =>
    i === (selectedIndex >= 0 ? selectedIndex : Math.min(focusIndex, rows.length - 1)) ? 0 : -1;
  const contains = selectedIndex >= 0;

  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    const target = treeKeyTarget(rows, index, e.key);
    if (target === null) return;
    e.preventDefault();
    setFocusIndex(target);
    buttons.current[target]?.focus();
  };

  return (
    <section
      className={`dag-flow-cluster ${contains ? 'dag-selected' : ''}`}
      aria-label={`Fluxo ${flow.title}`}
    >
      <div className="dag-cluster-header">
        <div className="dag-cluster-title">
          <span className={`dot ${flow.state}`} aria-hidden="true" />
          <strong>Fluxo #{flow.rootId.slice(4, 12)}</strong>
          <span className={`flow-state-badge state-${flow.state}`}>
            {STATE_LABEL[flow.state] ?? flow.state}
          </span>
          <span className="dag-cluster-when">{formatAgo(flow.updatedAt)}</span>
        </div>
        <div className="dag-cluster-agents">
          {flow.agents.map((ag: string) => (
            <span
              key={ag}
              className="dag-agent-badge"
              style={{ color: agentColor(ag), borderColor: agentColor(ag) }}
            >
              {ag}
            </span>
          ))}
          <span className="dag-cost-badge">{flow.sessions.length} sessões</span>
        </div>
      </div>

      <div className="dag-tree" role="tree" aria-label={`Sessões do fluxo ${flow.title}`}>
        {rows.map((row, index) => (
          <DagNode
            key={row.session.id}
            row={row}
            index={index}
            selected={row.session.id === selectedId}
            tabIndex={tabIndexOf(index)}
            buttonRef={(el) => {
              buttons.current[index] = el;
            }}
            onFocus={() => setFocusIndex(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
            onSelect={() => onSelectSession(row.session.id)}
          />
        ))}
      </div>
    </section>
  );
}

function DagNode({
  row,
  selected,
  tabIndex,
  buttonRef,
  onFocus,
  onKeyDown,
  onSelect,
}: {
  row: TreeRow<SessionSummary>;
  index: number;
  selected: boolean;
  tabIndex: number;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: () => void;
}): React.JSX.Element {
  const { session, depth, edge } = row;
  const color = agentColor(session.agentId);
  return (
    <div
      className={`dag-tree-row dag-edge-${edge}`}
      style={{ '--dag-depth': depth } as React.CSSProperties}
    >
      {depth > 0 && (
        <span className={`dag-edge-label dag-edge-label-${edge}`} aria-hidden="true">
          {edge === 'handoff' ? '⇄' : '↳'}
        </span>
      )}
      <button
        ref={buttonRef}
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={row.children.length > 0 ? true : undefined}
        tabIndex={tabIndex}
        className={`dag-node-card ${selected ? 'node-active' : ''}`}
        style={{ '--node-color': color } as React.CSSProperties}
        onClick={onSelect}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        <div className="dag-node-header">
          <div className="dag-node-id-wrap">
            <span className="dag-node-avatar" style={{ background: color }} aria-hidden="true">
              {session.agentId.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <div className="dag-node-agent">{session.agentId}</div>
              <div className="dag-node-role">{EDGE_LABEL[edge]}</div>
            </div>
          </div>
          <span className={`session-state-pill state-${session.state}`}>
            {STATE_LABEL[session.state] ?? session.state}
          </span>
        </div>

        <div className="dag-node-title">{session.title || (depth === 0 ? 'Sem título' : 'Tarefa secundária')}</div>

        <div className="dag-node-footer">
          <span>{formatAgo(session.updatedAt)}</span>
          <span className="dag-node-cost">ID: {session.id.slice(0, 10)}</span>
        </div>
      </button>
    </div>
  );
}
