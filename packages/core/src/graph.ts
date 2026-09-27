import { HubError } from './errors.js';
import { objectiveHash } from './ids.js';

/**
 * Guarda do grafo de delegação (ADR 03).
 *
 * A falha mais cara de "agente chama agente" não é o erro — é o loop: A pede a
 * B, B acha que A resolve melhor e devolve, e os dois queimam orçamento em
 * ping-pong. Por isso a detecção é *semântica*: o mesmo par
 * `(agente, objetivo)` não pode reaparecer na cadeia, mesmo que por caminhos
 * diferentes.
 */

export interface CallNodeRef {
  agentId: string;
  objective: string;
}

export function pathKey(agentId: string, objective: string): string {
  return `${agentId}:${objectiveHash(objective)}`;
}

export interface DelegationCheck {
  /** Cadeia de `pathKey` da raiz até o chamador, inclusive. */
  parentPath: string[];
  parentDepth: number;
  maxDepth: number;
  target: CallNodeRef;
}

export interface DelegationVerdict {
  depth: number;
  path: string[];
  key: string;
}

export function checkDelegation(check: DelegationCheck): DelegationVerdict {
  const depth = check.parentDepth + 1;
  const key = pathKey(check.target.agentId, check.target.objective);

  if (depth > check.maxDepth) {
    throw new HubError(
      'DEPTH_EXCEEDED',
      `Profundidade de delegação ${depth} excede o máximo de ${check.maxDepth}`,
      { depth, maxDepth: check.maxDepth, path: check.parentPath },
    );
  }

  if (check.parentPath.includes(key)) {
    throw new HubError(
      'CYCLE_DETECTED',
      `Ciclo detectado: ${check.target.agentId} já recebeu este mesmo objetivo nesta cadeia`,
      { key, path: check.parentPath },
    );
  }

  return { depth, path: [...check.parentPath, key], key };
}

/** Nó do grafo para a UI (árvore ao vivo de quem chamou quem). */
export interface GraphNode {
  sessionId: string;
  parentId: string | null;
  agentId: string;
  title: string | null;
  state: string;
  depth: number;
  usd: number;
  tokens: number;
  startedAt: string;
  endedAt: string | null;
  children: GraphNode[];
}

/** Monta a árvore a partir de uma lista plana — o que a UI consome. */
export function buildGraph(rows: Array<Omit<GraphNode, 'children'>>): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const row of rows) byId.set(row.sessionId, { ...row, children: [] });

  const roots: GraphNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Ciclo de `parent_id` (A→B→A, só possível com dado corrompido): nenhum nó
  // do ciclo é raiz, então todos sumiam da árvore — e a recursão abaixo nunca
  // os alcançava. Nó não alcançável a partir das raízes vira raiz ele mesmo
  // (o mais antigo do ciclo), com a aresta de volta cortada (R09-19).
  const alcancados = new Set<GraphNode>();
  const marcar = (n: GraphNode): void => {
    if (alcancados.has(n)) return;
    alcancados.add(n);
    for (const c of n.children) marcar(c);
  };
  for (const r of roots) marcar(r);
  const orfaos = [...byId.values()]
    .filter((n) => !alcancados.has(n))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const n of orfaos) {
    if (alcancados.has(n)) continue;
    const pai = n.parentId ? byId.get(n.parentId) : undefined;
    if (pai) pai.children = pai.children.filter((c) => c !== n);
    roots.push(n);
    marcar(n);
  }

  const sortRecursive = (nodes: GraphNode[]): void => {
    nodes.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const n of nodes) sortRecursive(n.children);
  };
  sortRecursive(roots);

  return roots;
}

/** Custo agregado de uma subárvore — usado no painel por sessão-raiz. */
export function rollupCost(node: GraphNode): { usd: number; tokens: number } {
  let usd = node.usd;
  let tokens = node.tokens;
  for (const child of node.children) {
    const sub = rollupCost(child);
    usd += sub.usd;
    tokens += sub.tokens;
  }
  return { usd, tokens };
}
