import {
  HubError,
  newId,
  nowIso,
  ZERO_USAGE,
  type Approval,
  type Artifact,
  type ApprovalRepository,
  type ArtifactRepository,
  type BudgetLimits,
  type BudgetRecord,
  type BudgetRepository,
  type BudgetUsage,
  type EventEnvelope,
  type EventRepository,
  type EventType,
  type GraphNode,
  type Project,
  type ProjectRepository,
  type Session,
  type SessionRepository,
  type SessionState,
  type Task,
  type TaskAttempt,
  type TaskRepository,
  type TaskState,
  type TaskResult,
  type UnitOfWork,
} from '@agents-hub/core';
import type { Brief } from '@agents-hub/core';
import { fromJson, nullableJson, toJson, type Db } from './db.js';

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: Db) {}

  create(input: Omit<Project, 'id' | 'createdAt'>): Project {
    const project: Project = { ...input, id: newId('prj'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(project.id, project.name, project.path, project.defaultBranch, project.createdAt);
    return project;
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? mapProject(row) : null;
  }

  getByPath(p: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(p) as Row | undefined;
    return row ? mapProject(row) : null;
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Row[]).map(
      mapProject,
    );
  }
}

class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  create(session: Session): Session {
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, project_id, agent_id, native_session_id, root_id, parent_id, depth, path_json,
          state, mode, isolation, workdir, title, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.projectId,
        session.agentId,
        session.nativeSessionId,
        session.rootId,
        session.parentId,
        session.depth,
        toJson(session.path),
        session.state,
        session.mode,
        session.isolation,
        session.workdir,
        session.title,
        session.createdAt,
        session.updatedAt,
        session.endedAt,
      );
    return session;
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? mapSession(row) : null;
  }

  update(id: string, patch: Partial<Session>): Session {
    const current = this.get(id);
    if (!current) throw new HubError('SESSION_NOT_FOUND', `Sessão ${id} não encontrada`, { id });

    const next: Session = { ...current, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE sessions SET
           native_session_id = ?, state = ?, mode = ?, isolation = ?, workdir = ?,
           title = ?, depth = ?, path_json = ?, updated_at = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(
        next.nativeSessionId,
        next.state,
        next.mode,
        next.isolation,
        next.workdir,
        next.title,
        next.depth,
        toJson(next.path),
        next.updatedAt,
        next.endedAt,
        id,
      );
    return next;
  }

  list(filter: { projectId?: string; state?: SessionState; rootId?: string } = {}): Session[] {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (filter.projectId) {
      clauses.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.state) {
      clauses.push('state = ?');
      params.push(filter.state);
    }
    if (filter.rootId) {
      clauses.push('root_id = ?');
      params.push(filter.rootId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`)
      .all(...params) as Row[];
    return rows.map(mapSession);
  }

  children(parentId: string): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at')
      .all(parentId) as Row[];
    return rows.map(mapSession);
  }

  graphRows(rootId: string): Array<Omit<GraphNode, 'children'>> {
    const rows = this.db
      .prepare(
        `SELECT s.id            AS session_id,
                s.parent_id     AS parent_id,
                s.agent_id      AS agent_id,
                s.title         AS title,
                s.state         AS state,
                s.depth         AS depth,
                s.created_at    AS started_at,
                s.ended_at      AS ended_at,
                COALESCE(SUM(json_extract(e.cost_json, '$.usd')), 0) AS usd,
                COALESCE(SUM(
                  COALESCE(json_extract(e.cost_json, '$.inputTokens'), 0) +
                  COALESCE(json_extract(e.cost_json, '$.outputTokens'), 0)
                ), 0) AS tokens
         FROM sessions s
         LEFT JOIN events e ON e.session_id = s.id
         WHERE s.root_id = ?
         GROUP BY s.id
         ORDER BY s.created_at`,
      )
      .all(rootId) as Row[];

    return rows.map((r) => ({
      sessionId: str(r['session_id']),
      parentId: strOrNull(r['parent_id']),
      agentId: str(r['agent_id']),
      title: strOrNull(r['title']),
      state: str(r['state']),
      depth: num(r['depth']),
      usd: num(r['usd']),
      tokens: num(r['tokens']),
      startedAt: str(r['started_at']),
      endedAt: strOrNull(r['ended_at']),
    }));
  }

  countActive(filter: { agentId?: string } = {}): number {
    const active = `state IN ('running', 'waiting_approval')`;
    const row = filter.agentId
      ? (this.db
          .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${active} AND agent_id = ?`)
          .get(filter.agentId) as Row)
      : (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${active}`).get() as Row);
    return num(row?.['n']);
  }
}

class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: Db) {}

  create(task: Task): Task {
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, session_id, requester_session_id, brief_json, state, attempts_json, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.sessionId,
        task.requesterSessionId,
        toJson(task.brief),
        task.state,
        toJson(task.attempts),
        task.result ? toJson(task.result) : null,
        task.createdAt,
        task.updatedAt,
      );
    return task;
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? mapTask(row) : null;
  }

  update(id: string, patch: Partial<Task>): Task {
    const current = this.get(id);
    if (!current) throw new HubError('TASK_NOT_FOUND', `Task ${id} não encontrada`, { id });

    const next: Task = { ...current, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(
        // `session_id` entra no UPDATE porque o fallback MOVE a task para a
        // sessão do agente substituto: a tarefa é a mesma, quem executa é que
        // mudou. Sem isto a task continuaria apontando para a sessão que falhou.
        `UPDATE tasks SET session_id = ?, state = ?, attempts_json = ?, result_json = ?,
                          brief_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.sessionId,
        next.state,
        toJson(next.attempts),
        next.result ? toJson(next.result) : null,
        toJson(next.brief),
        next.updatedAt,
        id,
      );
    return next;
  }

  list(filter: { sessionId?: string; state?: TaskState } = {}): Task[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.state) {
      clauses.push('state = ?');
      params.push(filter.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
      .all(...params) as Row[];
    return rows.map(mapTask);
  }
}

class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: Db) {}

  append(event: EventEnvelope): void {
    this.db
      .prepare(
        `INSERT INTO events (id, seq, ts, session_id, task_id, agent_id, type, payload_json, cost_json, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.seq,
        event.ts,
        event.sessionId,
        event.taskId,
        event.agentId,
        event.type,
        toJson(event.payload),
        event.cost ? toJson(event.cost) : null,
        event.raw === null || event.raw === undefined ? null : toJson(event.raw),
      );
  }

  list(filter: {
    sessionId?: string;
    taskId?: string;
    sinceSeq?: number;
    types?: EventType[];
    limit?: number;
  }): EventEnvelope[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.taskId) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (typeof filter.sinceSeq === 'number') {
      clauses.push('seq > ?');
      params.push(filter.sinceSeq);
    }
    if (filter.types && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
      params.push(...filter.types);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(filter.limit ?? 500, 5000);
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY session_id, seq LIMIT ?`)
      .all(...params, limit) as Row[];
    return rows.map(mapEvent);
  }

  lastSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return num(row?.['seq']);
  }

  costOf(sessionId: string): BudgetUsage {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(cost_json, '$.usd')), 0) AS usd,
                COALESCE(SUM(
                  COALESCE(json_extract(cost_json, '$.inputTokens'), 0) +
                  COALESCE(json_extract(cost_json, '$.outputTokens'), 0)
                ), 0) AS tokens
         FROM events WHERE session_id = ?`,
      )
      .get(sessionId) as Row | undefined;
    return { usd: num(row?.['usd']), tokens: num(row?.['tokens']), seconds: 0 };
  }
}

class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Db) {}

  create(approval: Approval): Approval {
    this.db
      .prepare(
        `INSERT INTO approvals
         (id, session_id, task_id, risk, action, detail_json, state, requested_at, resolved_at, resolved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.taskId,
        approval.risk,
        approval.action,
        toJson(approval.detail),
        approval.state,
        approval.requestedAt,
        approval.resolvedAt,
        approval.resolvedBy,
      );
    return approval;
  }

  get(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? mapApproval(row) : null;
  }

  update(id: string, patch: Partial<Approval>): Approval {
    const current = this.get(id);
    if (!current) throw new HubError('ILLEGAL_STATE', `Aprovação ${id} não encontrada`, { id });
    const next: Approval = { ...current, ...patch, id };
    this.db
      .prepare('UPDATE approvals SET state = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
      .run(next.state, next.resolvedAt, next.resolvedBy, id);
    return next;
  }

  listPending(filter: { sessionId?: string } = {}): Approval[] {
    const rows = filter.sessionId
      ? (this.db
          .prepare(
            `SELECT * FROM approvals WHERE state = 'pending' AND session_id = ? ORDER BY requested_at`,
          )
          .all(filter.sessionId) as Row[])
      : (this.db
          .prepare(`SELECT * FROM approvals WHERE state = 'pending' ORDER BY requested_at`)
          .all() as Row[]);
    return rows.map(mapApproval);
  }
}

class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: Db) {}

  create(artifact: Artifact): Artifact {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, session_id, task_id, kind, path, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.sessionId,
        artifact.taskId,
        artifact.kind,
        artifact.path,
        artifact.hash,
        artifact.createdAt,
      );
    return artifact;
  }

  list(filter: { sessionId?: string; taskId?: string }): Artifact[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.taskId) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at`)
      .all(...params) as Row[];
    return rows.map(mapArtifact);
  }
}

class SqliteBudgetRepository implements BudgetRepository {
  constructor(private readonly db: Db) {}

  upsert(record: BudgetRecord): BudgetRecord {
    this.db
      .prepare(
        `INSERT INTO budgets (root_id, limits_json, consumed_json, reserved_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_id) DO UPDATE SET
           limits_json = excluded.limits_json,
           consumed_json = excluded.consumed_json,
           reserved_json = excluded.reserved_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.rootId,
        toJson(record.limits),
        toJson(record.consumed),
        toJson(record.reserved),
        record.updatedAt,
      );
    return record;
  }

  get(rootId: string): BudgetRecord | null {
    const row = this.db.prepare('SELECT * FROM budgets WHERE root_id = ?').get(rootId) as
      | Row
      | undefined;
    if (!row) return null;
    return {
      rootId: str(row['root_id']),
      limits: fromJson<BudgetLimits>(row['limits_json'], { usd: 0, tokens: 0, seconds: 0 }),
      consumed: fromJson<BudgetUsage>(row['consumed_json'], ZERO_USAGE),
      reserved: fromJson<BudgetUsage>(row['reserved_json'], ZERO_USAGE),
      updatedAt: str(row['updated_at']),
    };
  }

  ensure(rootId: string, limits: BudgetLimits): BudgetRecord {
    const existing = this.get(rootId);
    if (existing) return existing;
    return this.upsert({
      rootId,
      limits,
      consumed: ZERO_USAGE,
      reserved: ZERO_USAGE,
      updatedAt: nowIso(),
    });
  }
}

export class SqliteUnitOfWork implements UnitOfWork {
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly tasks: TaskRepository;
  readonly events: EventRepository;
  readonly approvals: ApprovalRepository;
  readonly artifacts: ArtifactRepository;
  readonly budgets: BudgetRepository;

  #depth = 0;

  constructor(private readonly db: Db) {
    this.projects = new SqliteProjectRepository(db);
    this.sessions = new SqliteSessionRepository(db);
    this.tasks = new SqliteTaskRepository(db);
    this.events = new SqliteEventRepository(db);
    this.approvals = new SqliteApprovalRepository(db);
    this.artifacts = new SqliteArtifactRepository(db);
    this.budgets = new SqliteBudgetRepository(db);
  }

  /** Transações aninhadas viram uma só — a mais externa comanda. */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return fn();
      } finally {
        this.#depth -= 1;
      }
    }

    this.db.exec('BEGIN');
    this.#depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#depth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}

function mapProject(row: Row): Project {
  return {
    id: str(row['id']),
    name: str(row['name']),
    path: str(row['path']),
    defaultBranch: str(row['default_branch']),
    createdAt: str(row['created_at']),
  };
}

function mapSession(row: Row): Session {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    agentId: str(row['agent_id']),
    nativeSessionId: strOrNull(row['native_session_id']),
    rootId: str(row['root_id']),
    parentId: strOrNull(row['parent_id']),
    depth: num(row['depth']),
    path: fromJson<string[]>(row['path_json'], []),
    state: str(row['state']) as SessionState,
    mode: str(row['mode']) as Session['mode'],
    isolation: str(row['isolation']) as Session['isolation'],
    workdir: str(row['workdir']),
    title: strOrNull(row['title']),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    endedAt: strOrNull(row['ended_at']),
  };
}

function mapTask(row: Row): Task {
  return {
    id: str(row['id']),
    sessionId: str(row['session_id']),
    requesterSessionId: strOrNull(row['requester_session_id']),
    brief: fromJson<Brief>(row['brief_json'], {} as Brief),
    state: str(row['state']) as TaskState,
    attempts: fromJson<TaskAttempt[]>(row['attempts_json'], []),
    result: nullableJson<TaskResult>(row['result_json']),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
  };
}

function mapEvent(row: Row): EventEnvelope {
  return {
    id: str(row['id']),
    seq: num(row['seq']),
    ts: str(row['ts']),
    sessionId: str(row['session_id']),
    taskId: strOrNull(row['task_id']),
    agentId: str(row['agent_id']),
    type: str(row['type']) as EventType,
    payload: fromJson<Record<string, unknown>>(row['payload_json'], {}),
    cost: nullableJson<EventEnvelope['cost']>(row['cost_json']),
    raw: nullableJson<unknown>(row['raw_json']),
  };
}

function mapApproval(row: Row): Approval {
  return {
    id: str(row['id']),
    sessionId: str(row['session_id']),
    taskId: strOrNull(row['task_id']),
    risk: str(row['risk']) as Approval['risk'],
    action: str(row['action']),
    detail: fromJson<Record<string, unknown>>(row['detail_json'], {}),
    state: str(row['state']) as Approval['state'],
    requestedAt: str(row['requested_at']),
    resolvedAt: strOrNull(row['resolved_at']),
    resolvedBy: strOrNull(row['resolved_by']),
  };
}

function mapArtifact(row: Row): Artifact {
  return {
    id: str(row['id']),
    sessionId: str(row['session_id']),
    taskId: strOrNull(row['task_id']),
    kind: str(row['kind']) as Artifact['kind'],
    path: str(row['path']),
    hash: strOrNull(row['hash']),
    createdAt: str(row['created_at']),
  };
}
