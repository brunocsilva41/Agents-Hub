import { PolicyEngine, type PolicyDocument, type Session, type UnitOfWork } from '@agents-hub/core';
import { loadProjectOverrides, mergeProjectPolicy } from './project-config.js';

/**
 * Resolução de política efetiva (pai→filho e projeto→global), extraída de
 * `session-manager.ts` (dívida arquitetural do arquivo grande). Fica no
 * daemon, não em `core`, porque `projectPolicyFor` depende de I/O de arquivo
 * (`loadProjectOverrides`) e de `UnitOfWork` — não é lógica pura.
 */
export interface EffectivePolicyDeps {
  store: Pick<UnitOfWork, 'projects' | 'sessions'>;
  globalPolicy: PolicyDocument;
}

/**
 * Política global com os ajustes do projeto aplicados por cima (ADR 05.2).
 *
 * O projeto só consegue APERTAR — a fusão garante isso. Um repositório que
 * pudesse elevar o próprio teto transformaria qualquer clone malicioso em
 * execução arbitrária.
 */
export function projectPolicyFor(deps: EffectivePolicyDeps, projectId: string): PolicyDocument {
  const project = deps.store.projects.get(projectId);
  if (!project) return deps.globalPolicy;
  return mergeProjectPolicy(deps.globalPolicy, loadProjectOverrides(project.path).overrides);
}

/**
 * Política efetiva de uma sessão.
 *
 * Numa sessão-raiz é a política do Hub (com os ajustes do projeto); num
 * filho é a interseção com a do pai, que é o que garante que delegar nunca
 * aumente privilégio (ADR 03).
 */
export function policyFor(
  deps: EffectivePolicyDeps,
  session: Session,
  visited = new Set<string>(),
): PolicyEngine {
  const base = new PolicyEngine(projectPolicyFor(deps, session.projectId));
  if (!session.parentId || visited.has(session.id)) return base;
  visited.add(session.id);

  const parent = deps.store.sessions.get(session.parentId);
  if (!parent) return base;

  return policyFor(deps, parent, visited).intersect(base.policy);
}
