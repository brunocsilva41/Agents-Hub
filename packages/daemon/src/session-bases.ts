import { HubError, type IsolationMode, type Project, type UnitOfWork } from '@agents-hub/core';
import { branchExiste } from './worktree-commit.js';

/**
 * De onde o worktree de uma sessão nova parte, quando ela continua o trabalho
 * de outras (`baseSessionIds` — o passo seguinte de um workflow).
 *
 * Cada sessão-base isolada deixou o trabalho commitado em `hub/<id>` ao
 * concluir (`commitarTrabalho`); é esse branch que vira a base. Sessão-base
 * sem worktree não tem branch — o trabalho dela está no diretório do projeto —
 * e vira aviso, não erro: o passo ainda pode rodar, só não herda o código.
 */
export async function resolverBases(
  store: Pick<UnitOfWork, 'sessions'>,
  project: Project,
  isolation: IsolationMode,
  baseSessionIds: string[],
): Promise<{ refs: string[]; avisos: string[] }> {
  const refs: string[] = [];
  const avisos: string[] = [];
  if (baseSessionIds.length === 0) return { refs, avisos };

  for (const id of new Set(baseSessionIds)) {
    const base = store.sessions.get(id);
    if (!base) {
      throw new HubError('SESSION_NOT_FOUND', `Sessão-base ${id} não encontrada`, { sessionId: id });
    }
    if (base.projectId !== project.id) {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão-base ${id} é de outro projeto; o código dela não pode ser a base desta sessão`,
        { sessionId: id, projectId: base.projectId },
      );
    }
    if (base.isolation !== 'worktree') {
      avisos.push(
        `a sessão-base ${id} rodou sem worktree: o trabalho dela está no diretório do projeto, não num branch — este worktree não o recebe`,
      );
      continue;
    }
    const ref = `hub/${id}`;
    if (!(await branchExiste(project.path, ref))) {
      avisos.push(`o branch ${ref} da sessão-base não existe mais — este worktree não recebe o trabalho dela`);
      continue;
    }
    refs.push(ref);
  }

  if (isolation !== 'worktree' && refs.length > 0) {
    avisos.push(
      `sessões-base informadas (${refs.join(', ')}), mas esta sessão roda sem worktree — ela trabalha direto no diretório do projeto`,
    );
    return { refs: [], avisos };
  }
  return { refs, avisos };
}
