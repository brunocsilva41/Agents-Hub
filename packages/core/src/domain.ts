import type { Brief } from './brief.js';
import type { BudgetLimits, BudgetUsage } from './budget.js';
import type { RiskLevel } from './policy.js';

/** Ciclo de vida de Task, alinhado ao A2A v1.0 (8 estados). */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'auth_required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
];

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

export type SessionState =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'killed';

/**
 * Modo de supervisão. Herdado do pai para o filho e NUNCA escalado:
 * um filho de sessão `supervised` não vira `autonomous`.
 */
export type SessionMode = 'supervised' | 'semi' | 'autonomous';

export const MODE_RANK: Record<SessionMode, number> = {
  supervised: 0,
  semi: 1,
  autonomous: 2,
};

/** Retorna o modo mais restritivo entre os dois — base da regra de não-escalação. */
export function narrowestMode(a: SessionMode, b: SessionMode): SessionMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

export type IsolationMode = 'none' | 'worktree' | 'container';

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  agentId: string;
  /** Id da sessão no CLI nativo (thread do Codex, session do Claude...). */
  nativeSessionId: string | null;
  /** Sessão-raiz do fluxo. Para a própria raiz, `rootId === id`. */
  rootId: string;
  parentId: string | null;
  /** Distância até a raiz. Raiz = 0. */
  depth: number;
  /** Cadeia `agentId:objectiveHash` da raiz até aqui — usada na detecção de ciclo. */
  path: string[];
  state: SessionState;
  mode: SessionMode;
  isolation: IsolationMode;
  /** Diretório onde o agente realmente roda (worktree, ou o próprio repo). */
  workdir: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface TaskAttempt {
  n: number;
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: 'success' | 'error' | 'invalid' | 'timeout' | null;
  error: string | null;
}

export interface Task {
  id: string;
  sessionId: string;
  /** Sessão que pediu esta task. `null` quando quem pediu foi um humano. */
  requesterSessionId: string | null;
  brief: Brief;
  state: TaskState;
  attempts: TaskAttempt[];
  result: TaskResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  summary: string;
  artifacts: string[];
  usage: BudgetUsage;
  /** Preenchido quando o portão de validação rodou. */
  validation?: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail?: string }> };
}

export interface Approval {
  id: string;
  sessionId: string;
  taskId: string | null;
  risk: RiskLevel;
  /** O que o agente quer fazer, em texto legível. */
  action: string;
  detail: Record<string, unknown>;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export type ArtifactKind = 'diff' | 'file' | 'report' | 'log' | 'transcript';

export interface Artifact {
  id: string;
  sessionId: string;
  taskId: string | null;
  kind: ArtifactKind;
  path: string;
  hash: string | null;
  createdAt: string;
}

export interface BudgetRecord {
  rootId: string;
  limits: BudgetLimits;
  consumed: BudgetUsage;
  /** Reservado por tasks em andamento, ainda não consumido. */
  reserved: BudgetUsage;
  updatedAt: string;
}
