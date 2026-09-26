/* ------------------------------------------------------------------------ */
/* Editor de política e auditoria (item 1.10)                               */
/* ------------------------------------------------------------------------ */

/**
 * Política como o daemon a devolve. Registro aberto de propósito: o formato é
 * o `PolicyDocument` do core (a UI lê/edita campos pelo caminho), e repetir o
 * tipo aqui divergiria no primeiro campo novo.
 */
export type PolicyDoc = Record<string, unknown>;

export interface PolicyLayerSummary {
  /** Arquivo onde a camada mora (`config.json` global ou `config.yaml` do projeto). */
  file: string;
  /** O que a camada declara (sem padrões). É isto que se edita. */
  layer: PolicyDoc;
  /** Resultado da fusão — o que vale na hora de decidir. */
  effective: PolicyDoc;
}

export interface ProjectPolicySummary extends PolicyLayerSummary {
  projectId: string;
  path: string;
  trusted: boolean;
  /** YAML inválido: a camada do projeto não está valendo. */
  error: string | null;
  /** Campos de execução ignorados porque o projeto não é confiável. */
  ignoredExecFields: string[];
  /** Campos da camada sem efeito por tentarem afrouxar a global (clamp). */
  clamped: string[];
}

export interface PolicySummary {
  global: PolicyLayerSummary;
  project: ProjectPolicySummary | null;
}

export type AuditKindSummary =
  | 'gate.decision'
  | 'approval.requested'
  | 'approval.resolved'
  | 'policy.updated'
  | 'project.trust'
  | 'project.context'
  | 'project.import'
  | 'project.folders'
  | 'maintenance.sweep'
  | 'maintenance.backup'
  | 'budget.updated'
  | 'integration.install'
  | 'daemon.shutdown';

export interface AuditEntrySummary {
  id: string;
  ts: string;
  /** `cli:<usuário>`, `web`, `gate`, `policy`, `tempo esgotado`... */
  actor: string;
  kind: AuditKindSummary;
  sessionId: string | null;
  projectId: string | null;
  approvalId: string | null;
  action: string;
  decision: string | null;
  risk: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface AuditQuery {
  sessionId?: string;
  projectId?: string;
  kind?: AuditKindSummary;
  /** ISO 8601 ou relativo (`30m`, `2h`, `7d`). */
  since?: string;
  until?: string;
  limit?: number;
}
