import {
  newId,
  nowIso,
  type AuditEntry,
  type AuditFilter,
  type EventEnvelope,
  type UnitOfWork,
} from '@agents-hub/core';
import type { InMemoryEventBus } from './bus.js';

/** O que quem registra informa; id, horário e nulos o `record` completa. */
export type AuditInput = Pick<AuditEntry, 'actor' | 'kind' | 'action'> &
  Partial<Omit<AuditEntry, 'id' | 'ts' | 'actor' | 'kind' | 'action'>>;

/** Texto de ação com teto: a auditoria não precisa carregar um heredoc de 50 KB. */
const MAX_ACTION = 500;

/**
 * Trilha de auditoria do Hub (item 1.10 do GOAL).
 *
 * Duas fontes:
 * - o barramento de eventos (`approval.requested`/`approval.resolved`),
 *   observado por `tap` — assim quem resolve a aprovação (CLI, painel, o
 *   tempo esgotado do gate) aparece com o `by` que o daemon gravou, sem esta
 *   classe precisar conhecer o gate por dentro;
 * - chamadas diretas das rotas que o operador autentica (política, confiança,
 *   contexto, import, shutdown) e da rota do gate (`gate.decision`).
 *
 * Gravar auditoria nunca derruba a operação auditada: falha vira log.
 */
export class AuditTrail {
  #untap: (() => void) | null = null;

  constructor(
    private readonly store: Pick<UnitOfWork, 'audit' | 'sessions'>,
    private readonly bus: InMemoryEventBus,
  ) {}

  start(): void {
    if (this.#untap) return;
    this.#untap = this.bus.tap((event) => this.#fromEvent(event));
  }

  stop(): void {
    this.#untap?.();
    this.#untap = null;
  }

  record(input: AuditInput): AuditEntry | null {
    const sessionId = input.sessionId ?? null;
    const entry: AuditEntry = {
      id: newId('aud'),
      ts: nowIso(),
      actor: input.actor,
      kind: input.kind,
      sessionId,
      projectId: input.projectId ?? (sessionId ? this.#projectOf(sessionId) : null),
      approvalId: input.approvalId ?? null,
      action: input.action.length > MAX_ACTION ? `${input.action.slice(0, MAX_ACTION)}…` : input.action,
      decision: input.decision ?? null,
      risk: input.risk ?? null,
      reason: input.reason ?? null,
      detail: input.detail ?? {},
    };
    try {
      return this.store.audit.append(entry);
    } catch (err) {
      console.error(`[audit] falha ao gravar ${entry.kind}: ${(err as Error).message}`);
      return null;
    }
  }

  list(filter: AuditFilter = {}): AuditEntry[] {
    return this.store.audit.list(filter);
  }

  #projectOf(sessionId: string): string | null {
    try {
      return this.store.sessions.get(sessionId)?.projectId ?? null;
    } catch {
      return null;
    }
  }

  #fromEvent(event: EventEnvelope): void {
    const p = event.payload;
    const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

    if (event.type === 'approval.requested') {
      // Pedido do gate pré-execução = `tool-call`; o resto (vigilância,
      // delegação, orçamento) é a política pedindo decisão humana.
      const kindDoPedido = texto(p['kind']);
      this.record({
        actor: kindDoPedido === 'tool-call' ? 'gate' : 'policy',
        kind: 'approval.requested',
        sessionId: event.sessionId,
        approvalId: texto(p['approvalId']),
        action: texto(p['action']) ?? '(ação não informada)',
        decision: 'approve',
        risk: texto(p['risk']),
        reason: texto(p['reason']),
        detail: { requestKind: kindDoPedido, tool: p['tool'] ?? null, agentId: event.agentId },
      });
      return;
    }

    if (event.type === 'approval.resolved') {
      this.record({
        actor: texto(p['by']) ?? 'desconhecido',
        kind: 'approval.resolved',
        sessionId: event.sessionId,
        approvalId: texto(p['approvalId']),
        action: texto(p['action']) ?? '(ação não informada)',
        decision: texto(p['decision']),
        detail: { agentId: event.agentId },
      });
    }
  }
}

/** Resumo legível de uma chamada de ferramenta para a coluna `action`. */
export function resumoDaFerramenta(toolName: string, toolInput: Record<string, unknown>): string {
  for (const chave of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const v = toolInput[chave];
    if (typeof v === 'string' && v.length > 0) return `${toolName}: ${v}`;
  }
  return toolName;
}
