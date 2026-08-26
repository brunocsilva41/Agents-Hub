/**
 * Migrações versionadas. Cada entrada roda uma única vez, em ordem, dentro de
 * uma transação. Nunca edite uma migração já aplicada — adicione outra.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'schema inicial',
    sql: `
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     TEXT NOT NULL
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  agent_id          TEXT NOT NULL,
  native_session_id TEXT,
  root_id           TEXT NOT NULL,
  parent_id         TEXT REFERENCES sessions(id),
  depth             INTEGER NOT NULL DEFAULT 0,
  path_json         TEXT NOT NULL DEFAULT '[]',
  state             TEXT NOT NULL,
  mode              TEXT NOT NULL,
  isolation         TEXT NOT NULL,
  workdir           TEXT NOT NULL,
  title             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  ended_at          TEXT
);
CREATE INDEX idx_sessions_root    ON sessions(root_id);
CREATE INDEX idx_sessions_parent  ON sessions(parent_id);
CREATE INDEX idx_sessions_project ON sessions(project_id, state);
CREATE INDEX idx_sessions_agent   ON sessions(agent_id, state);

CREATE TABLE tasks (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  requester_session_id  TEXT REFERENCES sessions(id),
  brief_json            TEXT NOT NULL,
  state                 TEXT NOT NULL,
  attempts_json         TEXT NOT NULL DEFAULT '[]',
  result_json           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_tasks_session   ON tasks(session_id);
CREATE INDEX idx_tasks_state     ON tasks(state);
CREATE INDEX idx_tasks_requester ON tasks(requester_session_id);

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  task_id      TEXT,
  agent_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  cost_json    TEXT,
  raw_json     TEXT,
  UNIQUE (session_id, seq)
);
CREATE INDEX idx_events_session ON events(session_id, seq);
CREATE INDEX idx_events_task    ON events(task_id);
CREATE INDEX idx_events_type    ON events(type);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  task_id      TEXT REFERENCES tasks(id),
  risk         TEXT NOT NULL,
  action       TEXT NOT NULL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT
);
CREATE INDEX idx_approvals_state ON approvals(state, requested_at);

CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id    TEXT REFERENCES tasks(id),
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  hash       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_session ON artifacts(session_id);

CREATE TABLE budgets (
  root_id       TEXT PRIMARY KEY,
  limits_json   TEXT NOT NULL,
  consumed_json TEXT NOT NULL,
  reserved_json TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`,
  },
];
