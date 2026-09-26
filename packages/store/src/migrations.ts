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
  {
    version: 4,
    name: 'indice para retencao de eventos por sessao encerrada',
    sql: `
-- A compactação de \`events.raw_json\` (ADR 06.3: eventos para sempre,
-- \`raw_json\` comprimido depois de N dias) filtra por sessão encerrada há
-- tempo suficiente. Sem índice em \`ended_at\`, cada passada faria full scan
-- de \`sessions\` para achar candidatas — barato hoje, caro quando o banco
-- tiver anos de sessões.
CREATE INDEX idx_sessions_ended ON sessions(ended_at);
`,
  },
  {
    version: 5,
    name: 'confianca por projeto',
    sql: `
-- Confiança do usuário no projeto (vistoria 2026-09-25, item 0.7 do GOAL).
-- \`.agents-hub/config.yaml\` é versionado no repositório: sem isto, clonar um
-- repo com \`validation.command\` executava o comando na máquina de quem
-- clonou. A confiança mora AQUI, fora do repo, e nasce desligada.
ALTER TABLE projects ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 6,
    name: 'confianca com hash e contexto do hub',
    sql: `
-- Item 1.9 do GOAL (vistoria 2026-09-25): \`env\` (\`*_BASE_URL\`), \`prompts\` e
-- \`memory\` do \`.agents-hub/config.yaml\` do repositório também precisam de
-- confiança, e ela é trust-on-first-use: grava-se o hash do conteúdo sensível
-- confiado; se o repo mudar esse conteúdo, a confiança fica suspensa até o
-- usuário reconfirmar. NULL = confiança anterior ao hash (também suspensa).
ALTER TABLE projects ADD COLUMN trusted_hash TEXT;
-- Contexto (memória, instruções, env por agente) configurado PELO USUÁRIO no
-- Hub — painel, \`hub project env|prompt\`, \`hub import\`. Mora aqui, fora do
-- repositório, e por isso é confiável sem \`hub project trust\`. JSON.
ALTER TABLE projects ADD COLUMN hub_context TEXT;
`,
  },
  {
    version: 7,
    name: 'trilha de auditoria',
    sql: `
-- Trilha de auditoria (item 1.10 do GOAL): decisões do gate, aprovações e
-- mudanças de política/confiança — quem, quando, ação, decisão, motivo.
--
-- \`approvals\` guarda só o que pediu humano, e com \`resolved_by\` vindo do
-- corpo da requisição (falsificável até o item 1.6). \`events\` é timeline, e
-- nem toda decisão do gate vira evento. Tabela própria, só-acréscimo, sem FK:
-- a auditoria precisa sobreviver a qualquer limpeza das outras tabelas.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  session_id  TEXT,
  project_id  TEXT,
  approval_id TEXT,
  action      TEXT NOT NULL,
  decision    TEXT,
  risk        TEXT,
  reason      TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_ts      ON audit_log(ts);
CREATE INDEX idx_audit_session ON audit_log(session_id, ts);
CREATE INDEX idx_audit_project ON audit_log(project_id, ts);
`,
  },
  {
    version: 8,
    name: 'indices parciais para compactacao e somas de custo',
    sql: `
-- Vistoria 2026-09-25 (09-store-core, MÉDIOs de compactação e agregados):
-- a passada de compactação de \`raw_json\` sem nada a fazer lia TODOS os
-- eventos das sessões encerradas (775 ms com 100k eventos, a cada hora), e o
-- grafo/custo por sessão fazia \`json_extract\` em todo evento da árvore.
-- Índices parciais: só entram as linhas que interessam a cada consulta, então
-- o custo passa a ser proporcional ao que falta compactar / aos eventos com
-- custo, não ao tamanho da tabela.
CREATE INDEX idx_events_raw   ON events(session_id) WHERE raw_json IS NOT NULL;
CREATE INDEX idx_events_custo ON events(session_id) WHERE cost_json IS NOT NULL;
`,
  },
  {
    version: 9,
    name: 'custo em colunas geradas e indices compostos de eventos',
    sql: `
-- Vistoria 2026-09-25 (R09-08): o índice parcial da migração 8 só cortava as
-- linhas SEM custo; cada soma ainda lia a linha inteira e rodava
-- \`json_extract\` três vezes por evento com custo (grafo da raiz com 100k
-- eventos: ~70 ms no thread principal, crescendo linear com a árvore).
--
-- Colunas GERADAS (VIRTUAL, então nenhum dado é reescrito e não há segunda
-- fonte de verdade: o valor sai sempre de \`cost_json\`). A regra de "custo que
-- conta" é a mesma de antes — estimativa parcial (\`provisional\`) fica de fora,
-- porque o custo final do turno já a substitui. \`cost_tokens\` é NULL para o
-- que não conta, e é por ele que as somas filtram.
ALTER TABLE events ADD COLUMN cost_tokens INTEGER GENERATED ALWAYS AS (
  CASE WHEN cost_json IS NOT NULL
        AND COALESCE(json_extract(cost_json, '$.provisional'), 0) = 0
  THEN COALESCE(json_extract(cost_json, '$.inputTokens'), 0) +
       COALESCE(json_extract(cost_json, '$.outputTokens'), 0)
  END) VIRTUAL;
ALTER TABLE events ADD COLUMN cost_usd REAL GENERATED ALWAYS AS (
  CASE WHEN cost_json IS NOT NULL
        AND COALESCE(json_extract(cost_json, '$.provisional'), 0) = 0
  THEN json_extract(cost_json, '$.usd')
  END) VIRTUAL;
-- O índice guarda os valores calculados na escrita: a soma por sessão lê só o
-- índice, sem abrir o JSON de cada evento a cada consulta.
CREATE INDEX idx_events_custo_soma ON events(session_id, cost_usd, cost_tokens)
  WHERE cost_tokens IS NOT NULL;
DROP INDEX idx_events_custo;

-- \`list({types})\` e \`list({taskId})\` ordenam por (session_id, seq): com os
-- índices de uma coluna só o SQLite montava uma B-TREE temporária com TODOS
-- os eventos do tipo (570 ms para 5000 de 100k). Compostos, a ordem sai
-- pronta do índice. Os antigos são prefixo dos novos e saem.
CREATE INDEX idx_events_type_sessao ON events(type, session_id, seq);
DROP INDEX idx_events_type;
CREATE INDEX idx_events_task_sessao ON events(task_id, session_id, seq);
DROP INDEX idx_events_task;
`,
  },
  {
    version: 10,
    name: 'integridade de eventos e pastas',
    sql: `
-- Vistoria 2026-09-25 (R09-17): lacunas de integridade que só a convenção do
-- chamador evitava.

-- Uma pasta principal por projeto. A guarda existia só no daemon
-- (\`project-registry.ts\`); um caminho que escrevesse direto no store criava
-- duas "principais" e a sessão sem pasta escolhida caía numa delas ao acaso.
-- Antes do índice único, normaliza bancos que já tenham a duplicidade SEM
-- apagar nada: fica principal a pasta mais antiga, as outras viram comuns.
UPDATE project_folders SET is_primary = 0
 WHERE is_primary = 1
   AND rowid <> (SELECT p2.rowid FROM project_folders p2
                  WHERE p2.project_id = project_folders.project_id AND p2.is_primary = 1
                  ORDER BY p2.created_at, p2.rowid LIMIT 1);
CREATE UNIQUE INDEX idx_project_folders_primaria ON project_folders(project_id)
  WHERE is_primary = 1;

-- \`events.task_id\` nasceu sem FK e o SQLite não acrescenta FK a tabela
-- existente sem reconstruí-la (cópia de TODOS os eventos). O gatilho dá a
-- mesma garantia para o que entra daqui em diante; linhas antigas órfãs, se
-- houver, ficam como estão (nada de dado apagado na migração).
CREATE TRIGGER trg_events_task_existe
BEFORE INSERT ON events
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: events.task_id sem task');
END;

-- Consultas por janela de tempo (auditoria da timeline, retenção futura) não
-- tinham índice em \`ts\`.
CREATE INDEX idx_events_ts ON events(ts);
`,
  },
];
