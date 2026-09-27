import React, { useMemo, useRef, useState } from 'react';
import type { ProjectSummary, SessionSummary } from '@agents-hub/client';
import type { FlowSummary } from '../useHubState';
import { agentColor, STATE_LABEL, formatAgo, formatTokens, formatUsdShort } from '../hub';
import { custoPorSessao } from '../lib/flowGraphs';
import { buildFlowTree, treeKeyTarget, type EdgeKind, type TreeRow } from '../lib/flowTree';
import type { Situacao } from '../lib/indexStatus';
import { useFlowGraphs, type GrafosDosFluxos } from '../useFlowGraphs';
import { EstadoDaTela } from './EstadoDaTela';

interface Props {
  /** Todos os fluxos; o filtro de projeto é aplicado aqui. */
  flows: FlowSummary[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  /** Filtro de projeto, compartilhado com a lista da Timeline. */
  projects: ProjectSummary[];
  projectId: string;
  onProjectChange: (id: string) => void;
  /** Revisão por fluxo: o custo só é relido quando o fluxo muda. */
  revisionOf: (rootId: string) => number;
  situacao: Situacao;
  erro: string | null;
  onRetry: () => void;
}

/** Fluxos com ao menos uma sessão do projeto (`all` = todos). */
export function fluxosDoProjeto(flows: FlowSummary[], projectId: string): FlowSummary[] {
  if (projectId === 'all') return flows;
  return flows.filter((f) => f.sessions.some((s) => s.projectId === projectId));
}

type CustoDoNo = { estado: 'carregando' | 'erro' } | { estado: 'ok'; usd: number; tokens: number };

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
  projects,
  projectId,
  onProjectChange,
  revisionOf,
  situacao,
  erro,
  onRetry,
}: Props): React.JSX.Element {
  const visiveis = useMemo(() => fluxosDoProjeto(flows, projectId), [flows, projectId]);
  const rootIds = useMemo(() => visiveis.map((f) => f.rootId), [visiveis]);
  // Custo por nó: só o `/graph` o expõe (uma busca por fluxo, relida só quando
  // o fluxo muda).
  const grafos = useFlowGraphs(situacao === 'ok' ? rootIds : [], revisionOf);
  const nomeDoProjeto = projects.find((p) => p.id === projectId)?.name;

  const cabecalho = (
    <div className="dag-canvas-header">
      <div>
        <h2 className="dag-title">Grafo de Orquestração DAG</h2>
        <p className="dag-subtitle">
          Cada fluxo como árvore: quem delegou para quem, e onde houve transferência, com o custo de cada
          sessão. Setas navegam; Enter abre a sessão.
        </p>
      </div>
      <div className="filtro-da-aba">
        <label>
          Projeto
          <select value={projectId} onChange={(e) => onProjectChange(e.target.value)}>
            <option value="all">Todos os projetos ({projects.length})</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );

  if (situacao === 'carregando' || situacao === 'erro') {
    return (
      <div className="dag-canvas-container">
        {cabecalho}
        <EstadoDaTela situacao={situacao} oQue="as sessões" erro={erro} onTentar={onRetry} />
      </div>
    );
  }

  if (visiveis.length === 0) {
    const filtrado = situacao === 'ok' && projectId !== 'all';
    return (
      <div className="dag-canvas-container">
        {cabecalho}
        <div className="dag-empty-canvas">
          <div className="dag-empty-icon" aria-hidden="true">🕸</div>
          <h3>{filtrado ? `Nenhum fluxo em “${nomeDoProjeto ?? projectId}”` : 'Nenhum fluxo no Hub ainda'}</h3>
          <p>
            {filtrado
              ? 'Este projeto ainda não tem sessões. Veja todos os projetos ou inicie uma sessão nele.'
              : 'Inicie uma sessão para visualizar o grafo de tarefas e delegações entre agentes.'}
          </p>
          <div className="estado-vazio-acoes">
            {filtrado && (
              <button type="button" onClick={() => onProjectChange('all')}>
                Ver todos os projetos
              </button>
            )}
            <button type="button" className="primary" onClick={onNewSession}>
              Criar Nova Sessão
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dag-canvas-container">
      {cabecalho}
      {grafos.resumo.falhas > 0 && (
        <div className="notice warn" role="alert">
          O custo de {grafos.resumo.falhas} fluxo(s) não carregou: {grafos.resumo.erro}{' '}
          <button type="button" className="linkish" onClick={grafos.tentarDeNovo}>
            tentar de novo
          </button>
        </div>
      )}

      <div className="dag-flows-list">
        {visiveis.map((flow) => (
          <FlowGraph
            key={flow.rootId}
            flow={flow}
            selectedId={selectedId}
            onSelectSession={onSelectSession}
            grafos={grafos}
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
  grafos,
}: {
  flow: FlowSummary;
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  grafos: GrafosDosFluxos;
}): React.JSX.Element {
  const entrada = grafos.grafoDe(flow.rootId);
  const custos = useMemo(() => (entrada?.nos ? custoPorSessao(entrada.nos) : null), [entrada]);
  const custoDe = (sessionId: string): CustoDoNo => {
    if (custos) {
      const c = custos.get(sessionId);
      // Sessão que o grafo ainda não conhece (acabou de nascer): sem custo ainda.
      return c ? { estado: 'ok', ...c } : { estado: 'ok', usd: 0, tokens: 0 };
    }
    return { estado: entrada?.estado === 'erro' ? 'erro' : 'carregando' };
  };
  const total = custos ? [...custos.values()].reduce((s, c) => ({ usd: s.usd + c.usd, tokens: s.tokens + c.tokens }), { usd: 0, tokens: 0 }) : null;
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
          <span className="dag-cost-badge">
            {flow.sessions.length} {flow.sessions.length === 1 ? 'sessão' : 'sessões'}
            {total && ` · ${formatUsdShort(total.usd)} · ${formatTokens(total.tokens)} tokens`}
          </span>
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
            custo={custoDe(row.session.id)}
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
  custo,
}: {
  custo: CustoDoNo;
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
          {custo.estado === 'ok' ? (
            <span className="dag-node-cost" title={session.id}>
              {formatUsdShort(custo.usd)} · {formatTokens(custo.tokens)} tokens
            </span>
          ) : custo.estado === 'erro' ? (
            <span className="dag-custo-falhou">custo indisponível</span>
          ) : (
            <span className="dag-custo-carregando">custo…</span>
          )}
        </div>
      </button>
    </div>
  );
}
