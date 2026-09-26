/**
 * Trilha de auditoria (item 1.10 do GOAL).
 *
 * Decisões do gate, pedidos e respostas de aprovação e mudanças de política
 * ou de confiança — quem, quando, o quê, decisão e motivo. Tabela própria,
 * fora de `events`: a timeline é para acompanhar o trabalho; a auditoria é
 * para responder "quem liberou isto?" depois, e não pode depender de o evento
 * ainda estar lá nem de o campo `by` ter vindo do corpo da requisição.
 */
export type AuditKind =
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
  | 'daemon.shutdown';

export interface AuditEntry {
  id: string;
  ts: string;
  /**
   * Quem decidiu ou agiu: `cli:<usuário>`, `web`, `gate` (a política decidiu
   * sozinha), `policy` (a vigilância abriu uma aprovação), `daemon` ou o texto
   * que o próprio daemon usa (ex.: `tempo esgotado`). Vem SEMPRE da origem
   * autenticada ou do próprio daemon — nunca do corpo da requisição.
   */
  actor: string;
  kind: AuditKind;
  sessionId: string | null;
  projectId: string | null;
  approvalId: string | null;
  /** O que foi pedido/feito, em texto legível (comando, ferramenta, rota). */
  action: string;
  /** `allow`/`approve`/`deny`, `approved`/`denied`, `trusted`/`untrusted`... */
  decision: string | null;
  risk: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface AuditFilter {
  sessionId?: string;
  projectId?: string;
  kind?: AuditKind;
  /** ISO 8601, inclusivo. */
  since?: string;
  /** ISO 8601, exclusivo. */
  until?: string;
  limit?: number;
}

export const AUDIT_KINDS: readonly AuditKind[] = [
  'gate.decision',
  'approval.requested',
  'approval.resolved',
  'policy.updated',
  'project.trust',
  'project.context',
  'project.import',
  'project.folders',
  'maintenance.sweep',
  'maintenance.backup',
  'budget.updated',
  'daemon.shutdown',
];
