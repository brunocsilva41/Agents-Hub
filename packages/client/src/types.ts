export interface AgentSummary {
  id: string;
  name: string;
  vendor: string;
  description: string;
  capabilities: string[];
  sessionStrategy: string;
  streamFormat: string;
  caveats: string[];
  loginHint: string;
  probe: ProbeSummary | null;
}

export interface ProbeSummary {
  agentId: string;
  installed: boolean;
  version: string | null;
  binPath: string | null;
  error: string | null;
  checkedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  agentId: string;
  nativeSessionId: string | null;
  rootId: string;
  parentId: string | null;
  depth: number;
  state: string;
  mode: string;
  isolation: string;
  title: string | null;
  workdir: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface TaskSummary {
  id: string;
  sessionId: string;
  requesterSessionId: string | null;
  state: string;
  brief: { agent: string; objective: string; acceptanceCriteria: string[] };
  attempts: Array<{ n: number; agentId: string; outcome: string | null; error: string | null }>;
  result: {
    summary: string;
    artifacts: string[];
    usage: { usd: number; tokens: number; seconds: number };
    /** Presente quando o portão de validação rodou (ADR 04.3). */
    validation?: {
      passed: boolean;
      checks: Array<{ name: string; passed: boolean; detail?: string }>;
    };
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface GraphSummary {
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
  children: GraphSummary[];
}

export interface UsageSummary {
  usd: number;
  tokens: number;
  seconds: number;
}

export interface BudgetSummary {
  limits: UsageSummary;
  consumed: UsageSummary;
  reserved: UsageSummary;
  remaining: UsageSummary;
  pressure: number;
  exhausted: boolean;
  isWarning?: boolean;
  projection?: {
    projectedUsd: number;
    projectedTokens: number;
    burnRateUsdPerSec: number;
  };
}

export interface HealthSummary {
  ok: boolean;
  version: string;
  now: string;
  home: string;
  liveSessions: number;
  subscribers: number;
}

export interface ApprovalSummary {
  id: string;
  sessionId: string;
  taskId: string | null;
  risk: string;
  /** Frase legível do que está sendo pedido. */
  action: string;
  detail: Record<string, unknown>;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface ArtifactSummary {
  id: string;
  sessionId: string;
  taskId: string | null;
  kind: 'diff' | 'file' | 'report' | 'log' | 'transcript';
  path: string;
  createdAt: string;
}

/** Uma das pastas que compõem um projeto. */
export interface ProjectFolder {
  id: string;
  projectId: string;
  path: string;
  label: string | null;
  isPrimary: boolean;
  createdAt: string;
}

/** Memória e instruções por agente, guardadas no projeto. */
export interface ProjectContextDto {
  memory?: string;
  prompts?: Record<string, string>;
}
