import type { BudgetLimits, BudgetUsage } from './budget.js';
import type {
  Approval,
  Artifact,
  BudgetRecord,
  Project,
  ProjectFolder,
  ProjectHubContext,
  Session,
  SessionState,
  Task,
  TaskState,
} from './domain.js';
import type { EventEnvelope, EventType } from './events.js';
import type { GraphNode } from './graph.js';
import type { AuditEntry, AuditFilter } from './audit.js';

/**
 * Portas do domínio. O core define as interfaces; `store` e `daemon` fornecem
 * as implementações. É o que permite testar orquestração, política e orçamento
 * sem SQLite e sem invocar nenhum agente de verdade.
 */

export interface ProjectRepository {
  create(input: Omit<Project, 'id' | 'createdAt' | 'trusted' | 'trustedHash'>): Project;
  /**
   * Marca/desmarca o projeto como confiável (ver `Project.trusted`), gravando
   * junto o hash do conteúdo sensível que foi confiado (`Project.trustedHash`).
   */
  setTrusted(id: string, trusted: boolean, contentHash?: string | null): Project | null;
  /** Contexto configurado pelo usuário via Hub (ver `ProjectHubContext`); `{}` se nenhum. */
  getHubContext(id: string): ProjectHubContext;
  setHubContext(id: string, ctx: ProjectHubContext): void;
  get(id: string): Project | null;
  getByPath(path: string): Project | null;
  list(): Project[];

  /** Pastas que compõem o projeto, principal primeiro. */
  listFolders(projectId: string): ProjectFolder[];
  addFolder(input: Omit<ProjectFolder, 'id' | 'createdAt'>): ProjectFolder;
  removeFolder(folderId: string): void;
  /** A quem esta pasta pertence, se a alguém. */
  findFolderByPath(path: string): ProjectFolder | null;
  /** Todas as pastas de todos os projetos — base da checagem de sobreposição. */
  allFolders(): ProjectFolder[];
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
    /** Só `seq` menor que este (página para trás); implica `newest`. */
    beforeSeq?: number;
    /** Os `limit` mais recentes em vez dos primeiros; a ordem devolvida segue crescente. */
    newest?: boolean;
    types?: EventType[];
    /** Máximo de eventos (1..5000; padrão 500). */
    limit?: number;
    /**
     * `true` devolve os ÚLTIMOS `limit` eventos (ainda em ordem crescente de
     * `seq`). Sem isto, o corte pega o começo — que é o que o replay e o
     * `hub_context_fetch` entregavam por engano em sessões longas.
     */
    tail?: boolean;
  }): EventEnvelope[];
  lastSeq(sessionId: string): number;
  /**
   * Custo acumulado de uma sessão, somando o `cost` dos eventos — exceto as
   * estimativas parciais (`cost.provisional`), que o custo final substitui.
   */
  costOf(sessionId: string): BudgetUsage;
  /**
   * Compacta (zera) `raw_json` de eventos cuja sessão terminou antes de
   * `cutoffIso` — nunca deleta a linha, nunca toca `payload_json` (ADR 06.3:
   * eventos para sempre). Devolve quantas linhas foram afetadas. Com `limit`,
   * afeta no máximo N linhas por chamada — quem chama repete em lotes.
   */
  compactRawBefore(cutoffIso: string, limit?: number): number;
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

/** Trilha de auditoria: só acrescenta, nunca edita nem apaga (item 1.10). */
export interface AuditRepository {
  append(entry: AuditEntry): AuditEntry;
  /** Mais recentes primeiro. */
  list(filter?: AuditFilter): AuditEntry[];
}

export interface UnitOfWork {
  projects: ProjectRepository;
  sessions: SessionRepository;
  tasks: TaskRepository;
  events: EventRepository;
  approvals: ApprovalRepository;
  artifacts: ArtifactRepository;
  budgets: BudgetRepository;
  audit: AuditRepository;
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
