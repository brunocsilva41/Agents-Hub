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
  {
    version: 2,
    name: 'projeto com varias pastas',
    sql: `
-- Um projeto passa a agrupar N pastas.
--
-- Motivação: um "projeto" real raramente é uma pasta só — frontend e backend em
-- repositórios separados, ou um monorepo mais os scripts de infraestrutura ao
-- lado. Antes disso o usuário precisava criar dois projetos e perdia a
-- unificação de custo, política e histórico entre eles.
--
-- \`path\` é UNIQUE GLOBALMENTE, não por projeto. Uma pasta pertence a no
-- máximo um projeto — se pertencesse a dois, não haveria resposta para "qual
-- política vale aqui?", e adivinhar a resposta é como se age no alvo errado.
CREATE TABLE project_folders (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path       TEXT NOT NULL UNIQUE,
  label      TEXT,
  -- A pasta principal é a que a sessão usa quando ninguém escolhe outra.
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_project_folders_project ON project_folders(project_id);

-- Backfill: todo projeto existente vira um projeto de uma pasta só, a dele.
-- Sem isto, projetos criados antes desta migração ficariam sem pasta nenhuma e
-- nenhuma sessão nova conseguiria escolher onde rodar.
INSERT INTO project_folders (id, project_id, path, label, is_primary, created_at)
SELECT 'pfd_' || id, id, path, name, 1, created_at FROM projects;
`,
  },
  {
    version: 3,
    name: 'pid por sessao',
    sql: `
-- A reconciliação na subida do daemon (\`reconcileOnStartup\`) só corrigia o
-- registro no banco (marcava sessão viva como \`killed\`) sem nunca matar o
-- processo real, porque não sabia qual PID pertencia a qual sessão. Nulo por
-- padrão: nem toda sessão tem um processo dedicado (o OpenCode roda num
-- servidor HTTP compartilhado por N sessões, não um filho por sessão).
ALTER TABLE sessions ADD COLUMN pid INTEGER;
`,
  },
];
