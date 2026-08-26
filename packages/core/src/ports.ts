import type { BudgetLimits, BudgetUsage } from './budget.js';
import type {
  Approval,
  Artifact,
  BudgetRecord,
  Project,
  Session,
  SessionState,
  Task,
  TaskState,
} from './domain.js';
import type { EventEnvelope, EventType } from './events.js';
import type { GraphNode } from './graph.js';

/**
 * Portas do domínio. O core define as interfaces; `store` e `daemon` fornecem
 * as implementações. É o que permite testar orquestração, política e orçamento
 * sem SQLite e sem invocar nenhum agente de verdade.
 */

export interface ProjectRepository {
  create(input: Omit<Project, 'id' | 'createdAt'>): Project;
  get(id: string): Project | null;
  getByPath(path: string): Project | null;
  list(): Project[];
}

export interface SessionRepository {
  create(session: Session): Session;
  get(id: string): Session | null;
  update(id: string, patch: Partial<Session>): Session;
  list(filter?: { projectId?: string; state?: SessionState; rootId?: string }): Session[];
  children(parentId: string): Session[];
  /** Linhas planas do grafo de um fluxo, já com custo agregado por sessão. */
  graphRows(rootId: string): Array<Omit<GraphNode, 'children'>>;
  countActive(filter?: { agentId?: string }): number;
}

export interface TaskRepository {
  create(task: Task): Task;
  get(id: string): Task | null;
  update(id: string, patch: Partial<Task>): Task;
  list(filter?: { sessionId?: string; state?: TaskState }): Task[];
}

export interface EventRepository {
  append(event: EventEnvelope): void;
  list(filter: {
    sessionId?: string;
    taskId?: string;
    sinceSeq?: number;
    types?: EventType[];
    limit?: number;
  }): EventEnvelope[];
  lastSeq(sessionId: string): number;
  /** Custo acumulado de uma sessão, somando o `cost` dos eventos. */
  costOf(sessionId: string): BudgetUsage;
}

export interface ApprovalRepository {
  create(approval: Approval): Approval;
  get(id: string): Approval | null;
  update(id: string, patch: Partial<Approval>): Approval;
  listPending(filter?: { sessionId?: string }): Approval[];
}

export interface ArtifactRepository {
  create(artifact: Artifact): Artifact;
  list(filter: { sessionId?: string; taskId?: string }): Artifact[];
}

export interface BudgetRepository {
  upsert(record: BudgetRecord): BudgetRecord;
  get(rootId: string): BudgetRecord | null;
  ensure(rootId: string, limits: BudgetLimits): BudgetRecord;
}

export interface UnitOfWork {
  projects: ProjectRepository;
  sessions: SessionRepository;
  tasks: TaskRepository;
  events: EventRepository;
  approvals: ApprovalRepository;
  artifacts: ArtifactRepository;
  budgets: BudgetRepository;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Barramento de eventos: alimenta SSE, TUI e Web UI a partir da mesma fonte. */
export interface EventBus {
  publish(event: EventEnvelope): void;
  subscribe(
    filter: { sessionId?: string; rootId?: string },
    handler: (event: EventEnvelope) => void,
  ): () => void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
