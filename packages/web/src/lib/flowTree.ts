/**
 * Árvore de um fluxo a partir da lista de sessões que o painel já tem.
 *
 * A aba "Grafo DAG" desenhava a raiz e, depois de uma seta, TODAS as outras
 * sessões numa faixa só: A→B→C e A→{B,C} ficavam iguais. Aqui cada sessão vai
 * para baixo do seu `parentId`, e a aresta diz o tipo — delegação (tem pai) ou
 * transferência (handoff cria sessão irmã: mesma raiz, sem pai).
 *
 * Sem requisição: `parentId`/`rootId` já vêm em `/sessions`. Buscar `/graph`
 * de cada fluxo para desenhar a aba era parte do fan-out de requisições.
 */

export interface TreeSession {
  id: string;
  rootId: string;
  parentId: string | null;
  createdAt: string;
}

export type EdgeKind = 'root' | 'delegation' | 'handoff';

export interface TreeRow<T extends TreeSession> {
  session: T;
  /** Nível visual (0 = raiz do fluxo). */
  depth: number;
  edge: EdgeKind;
  /** De quem a aresta sai; `null` para a raiz. */
  fromId: string | null;
  /** Índices (nesta lista) dos filhos diretos. */
  children: number[];
}

/**
 * Linhas em pré-ordem (pai antes dos filhos, irmãos por criação). Pai
 * desconhecido — sessão cujo pai não está na lista — sobe como filho da raiz,
 * para nunca sumir da tela.
 */
export function buildFlowTree<T extends TreeSession>(
  rootId: string,
  sessions: readonly T[],
): TreeRow<T>[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const root = byId.get(rootId);
  const kids = new Map<string, T[]>();
  const push = (parent: string, child: T): void => {
    const list = kids.get(parent);
    if (list) list.push(child);
    else kids.set(parent, [child]);
  };

  for (const session of sessions) {
    if (session.id === rootId) continue;
    if (session.parentId && byId.has(session.parentId)) push(session.parentId, session);
    else if (root) push(rootId, session);
  }
  for (const list of kids.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const rows: TreeRow<T>[] = [];
  const visit = (session: T, depth: number, edge: EdgeKind, fromId: string | null): number => {
    const index = rows.length;
    rows.push({ session, depth, edge, fromId, children: [] });
    for (const child of kids.get(session.id) ?? []) {
      // Sem pai na mesma raiz = sessão irmã criada por transferência. Com pai
      // (mesmo que fora da lista) foi delegada por alguém.
      const kind: EdgeKind = child.parentId === null ? 'handoff' : 'delegation';
      (rows[index] as TreeRow<T>).children.push(visit(child, depth + 1, kind, session.id));
    }
    return index;
  };

  if (root) {
    visit(root, 0, 'root', null);
  } else {
    // Raiz fora da lista (filtrada, apagada): cada órfão vira uma raiz própria.
    for (const session of [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!session.parentId || !byId.has(session.parentId)) visit(session, 0, 'root', null);
    }
  }
  return rows;
}

/**
 * Navegação por teclado numa árvore (padrão WAI-ARIA `tree`): ↑/↓ percorrem as
 * linhas na ordem da tela, → desce ao primeiro filho, ← sobe ao pai, Home/End
 * vão às pontas. Devolve o índice novo, ou `null` se a tecla não é de navegação.
 */
export function treeKeyTarget(
  rows: ReadonlyArray<{ fromId: string | null; children: number[]; session: { id: string } }>,
  current: number,
  key: string,
): number | null {
  if (rows.length === 0) return null;
  const last = rows.length - 1;
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, current + 1);
    case 'ArrowUp':
      return Math.max(0, current - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowRight': {
      const first = rows[current]?.children[0];
      return first ?? current;
    }
    case 'ArrowLeft': {
      const from = rows[current]?.fromId;
      if (!from) return current;
      const parent = rows.findIndex((r) => r.session.id === from);
      return parent === -1 ? current : parent;
    }
    default:
      return null;
  }
}
