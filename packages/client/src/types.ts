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
  /**
   * Se o CLI aceita modelo por invocação. `supported: false` = não oferecer o
   * controle de modelo para este agente (o valor não chegaria a ele).
   */
  model: { supported: boolean; format: string };
  /** Contra qual versão do binário o manifesto foi conferido. */
  verified: {
    status: 'verified' | 'partial' | 'unverified';
    version: string | null;
    date: string;
    notes: string;
  };
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
  /**
   * Confiado pelo usuário: os campos sensíveis do config.yaml do repo
   * (`validation.command`/revisão, `env`, `prompts`, `memory`) valem —
   * enquanto o conteúdo for o confiado (ver `RepoConfigStatusDto.trust`).
   */
  trusted?: boolean;
  /** Hash do conteúdo sensível confiado (trust-on-first-use). */
  trustedHash?: string | null;
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
  /**
   * Sessão adotada de um agente externo (`POST /sessions/adopt`). Só ela
   * aceita `detach`. Ausente em daemons anteriores a este campo.
   */
  adopted?: boolean;
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
/** Estado do `.agents-hub/config.yaml` do repositório (item 1.9 do GOAL). */
export interface RepoConfigStatusDto {
  path: string;
  /** `suspended`: confiado, mas o conteúdo sensível mudou depois — reconfirme. */
  trust: 'untrusted' | 'trusted' | 'suspended';
  /** Campos sensíveis que o repositório declara. */
  sensitiveFields: string[];
  /** Aviso quando campos do repositório estão sendo ignorados. */
  warning: string | null;
  /** O que o repositório declara (para revisar antes de confiar). */
  context: ProjectContextDto;
}

export interface ProjectContextDto {
  memory?: string;
  prompts?: Record<string, string>;
  /** Variáveis de ambiente por agente — é como "modelo local" chega ao CLI. */
  env?: Record<string, Record<string, string>>;
}

/** Resultado de `POST /workflows/validate`. */
export type WorkflowValidationSummary =
  | {
      valid: true;
      errors: [];
      workflow: {
        name: string;
        description: string | null;
        steps: Array<{ id: string; agent: string; dependsOn: string[] }>;
      };
      /** Lotes paralelos, em ordem topológica. */
      executionOrder: string[][];
    }
  | { valid: false; errors: string[]; workflow: null; executionOrder: [] };

export type WorkflowRunStepStateSummary =
  'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked' | 'timeout';

/** Execução de workflow conduzida pelo daemon (`/workflows/runs`). */
export interface WorkflowRunSummary {
  id: string;
  name: string;
  description: string | null;
  projectId: string;
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  budgetUsd: number | null;
  batches: string[][];
  currentBatch: number | null;
  steps: Array<{
    stepId: string;
    agent: string;
    dependsOn: string[];
    state: WorkflowRunStepStateSummary;
    sessionId: string | null;
    taskId: string | null;
    summary: string | null;
    detail: string | null;
    usd: number;
    capUsd: number | null;
  }>;
  totalUsd: number;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}
