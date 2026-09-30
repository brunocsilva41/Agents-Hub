# SPEC-02 — Banco e diretório de dados

> Especificação extraída do código TypeScript (main @ 82f40cc) para a reescrita em C
> ([ADR 07](../decisoes/07-reescrita-nativa.md)). Guia a migração do banco existente na
> primeira execução (7.15) e a saída do env por projeto para o cofre do SO (7.16).
> Toda afirmação traz `arquivo:linha`. Caminhos relativos a `packages/`, salvo indicação.
> O que não foi possível determinar pelo código está marcado **NÃO DETERMINADO**.

## 1. Onde fica e como abre

O banco é um único arquivo SQLite, `<home>/hub.db`, aberto pelo daemon com WAL.

- **Home.** `AGENTS_HUB_HOME`, senão `~/.agents-hub` (`daemon/src/config.ts:122-124`,
  `daemon/src/config.ts:306`). A variável é validada como string não vazia
  (`core/src/hub-env.ts:21`). O cliente lê a variável direto de `process.env`, sem essa
  validação (`client/src/operator-token.ts:18`).
- **Arquivo.** `dbFile = <home>/hub.db` (`daemon/src/config.ts:316`); `config.json` pode
  sobrescrever `dbFile` (seção 6.1).
- **Quem abre.** Só o daemon, em `createHub` (`daemon/src/hub.ts:74`, via
  `store/src/index.ts:25-27`). A CLI abre o arquivo apenas para backup/restore com o daemon
  parado (`cli/src/backup-cmd.ts:34`, `cli/src/backup-cmd.ts:86`).
- **Diretório.** Criado se faltar, exceto `:memory:` (`store/src/db.ts:17-19`).

### 1.1 PRAGMAs, nesta ordem (`store/src/db.ts:29-36`)

| PRAGMA | Valor | Observação |
|---|---|---|
| `auto_vacuum` | `INCREMENTAL` | Antes de qualquer tabela. Em banco que já tem tabelas fica pendente até um `VACUUM` (`store/src/db.ts:23-28`). |
| `journal_mode` | `WAL` | Gera `hub.db-wal` e `hub.db-shm`. |
| `foreign_keys` | `ON` | Por conexão. |
| `busy_timeout` | `5000` (ms) | |
| `synchronous` | `NORMAL` | |

Conferido num banco novo criado pelo store (seção 9): `journal_mode=wal`, `foreign_keys=1`,
`auto_vacuum=2`, `busy_timeout=5000`, `synchronous=1`, `page_size=4096`, `user_version=0`.
`user_version` **não é usado**; a versão do esquema mora na tabela `migrations`.

### 1.2 Tabela `migrations` e o executor (`store/src/db.ts:42-95`)

```sql
CREATE TABLE IF NOT EXISTS migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

- Criada em toda abertura (`store/src/db.ts:43-47`).
- **Guarda contra downgrade.** Se `MAX(version)` aplicada > maior versão conhecida pelo
  código, lança `HubError('HUB_CONFIG_INVALID')` e não abre (`store/src/db.ts:63-75`).
- Cada migração pendente roda em `BEGIN` … `COMMIT`, com o `INSERT` em `migrations` na
  mesma transação; falha → `ROLLBACK` e erro `Falha na migração N (nome)`
  (`store/src/db.ts:77-94`).
- `applied_at` = `new Date().toISOString()` (`store/src/db.ts:85`).
- O comentário em `store/src/db.ts:59` fala em "4 migrações de hoje"; está desatualizado
  (são 10). Só comentário, sem efeito.

## 2. Migrações 1 a 10

A última é a **10** (`store/src/migrations.ts:283`). Todas estão em
`store/src/migrations.ts`, na constante `MIGRATIONS` (`store/src/migrations.ts:11`).
Nenhuma apaga dado.

| v | Nome (`name`) | Efeito | Linhas |
|---|---|---|---|
| 1 | `schema inicial` | Cria `projects`, `sessions`, `tasks`, `events`, `approvals`, `artifacts`, `budgets` e 12 índices (4 em `sessions`, 3 em `tasks`, 3 em `events`, 1 em `approvals`, 1 em `artifacts`: `:42-45`, `:58-60`, `:75-77`, `:91`, `:102`). | 12-112 |
| 2 | `projeto com varias pastas` | Cria `project_folders` + `idx_project_folders_project`. Backfill: cada projeto vira uma pasta principal. | 113-144 |
| 3 | `pid por sessao` | `ALTER TABLE sessions ADD COLUMN pid INTEGER`. | 145-156 |
| 4 | `indice para retencao de eventos por sessao encerrada` | `CREATE INDEX idx_sessions_ended ON sessions(ended_at)`. | 157-168 |
| 5 | `confianca por projeto` | `ALTER TABLE projects ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0`. | 169-179 |
| 6 | `confianca com hash e contexto do hub` | `projects` ganha `trusted_hash TEXT` e `hub_context TEXT`. | 180-195 |
| 7 | `trilha de auditoria` | Cria `audit_log` + 3 índices. Sem FK de propósito. | 196-225 |
| 8 | `indices parciais para compactacao e somas de custo` | `idx_events_raw` e `idx_events_custo` (parciais). | 226-240 |
| 9 | `custo em colunas geradas e indices compostos de eventos` | Colunas geradas `cost_tokens`/`cost_usd`; `idx_events_custo_soma`; troca `idx_events_type`/`idx_events_task` por compostos; remove `idx_events_custo`. | 241-281 |
| 10 | `integridade de eventos e pastas` | Normaliza pastas principais duplicadas; índice único parcial; gatilho de FK de `events.task_id`; `idx_events_ts`. | 282-318 |

### 2.1 SQL que não é só `CREATE`

**v2 — backfill** (`store/src/migrations.ts:141-142`):

```sql
INSERT INTO project_folders (id, project_id, path, label, is_primary, created_at)
SELECT 'pfd_' || id, id, path, name, 1, created_at FROM projects;
```

As pastas criadas assim têm id `pfd_prj_…`, diferente do formato normal `pfd_<24 hex>`
(seção 4.1). Bancos migrados a partir de antes da v2 podem conter os dois formatos.

**v9 — colunas geradas** (`store/src/migrations.ts:255-265`):

```sql
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
```

Ordem dos `DROP`/`CREATE` da v9: cria `idx_events_custo_soma`, remove `idx_events_custo`,
cria `idx_events_type_sessao`, remove `idx_events_type`, cria `idx_events_task_sessao`,
remove `idx_events_task` (`store/src/migrations.ts:268-279`).

**v10 — normalização antes do índice único** (`store/src/migrations.ts:294-300`). Fica
principal a pasta mais antiga (`created_at`, depois `rowid`); as outras viram comuns:

```sql
UPDATE project_folders SET is_primary = 0
 WHERE is_primary = 1
   AND rowid <> (SELECT p2.rowid FROM project_folders p2
                  WHERE p2.project_id = project_folders.project_id AND p2.is_primary = 1
                  ORDER BY p2.created_at, p2.rowid LIMIT 1);
CREATE UNIQUE INDEX idx_project_folders_primaria ON project_folders(project_id)
  WHERE is_primary = 1;
```

**v10 — gatilho** (`store/src/migrations.ts:306-312`). Vale só para `INSERT` novo; linhas
órfãs antigas ficam como estão (`store/src/migrations.ts:302-305`):

```sql
CREATE TRIGGER trg_events_task_existe
BEFORE INSERT ON events
WHEN NEW.task_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: events.task_id sem task');
END;
```

**Recursos do SQLite usados pelo esquema:** colunas geradas (`GENERATED ALWAYS … VIRTUAL`,
`store/src/migrations.ts:255-265`), `json_extract` (mesmas linhas) e índices parciais
(`store/src/migrations.ts:237`, `:268-269`, `:299-300`). A versão mínima de SQLite que os
suporta **NÃO DETERMINADA** aqui (o TS usa o SQLite embutido no Node; `node --version` desta
máquina: v24.14.0).

## 3. Esquema final (após a migração 10)

Conferido com `sqlite_master` e `PRAGMA table_xinfo` num banco novo (seção 9). Todas as
tabelas são tabelas com `rowid` (nenhuma `WITHOUT ROWID`).

**Atenção:** em tabela com `rowid`, `TEXT PRIMARY KEY` **aceita NULL** no SQLite
(`table_xinfo` mostra `notnull=0` para todos os `id`). O código TS sempre grava id
(ex.: `store/src/repositories.ts:86-98`); a restrição NOT NULL do id não existe no esquema.

Todas as FKs são `ON DELETE NO ACTION` / `ON UPDATE NO ACTION` (conferido em
`PRAGMA foreign_key_list`).

**Índices automáticos.** Toda tabela com `TEXT PRIMARY KEY` tem o índice
`sqlite_autoindex_<tabela>_1` sobre a PK: `projects`, `project_folders`, `sessions`, `tasks`,
`events`, `approvals`, `artifacts`, `budgets` (sobre `root_id`) e `audit_log`. As restrições
UNIQUE geram `sqlite_autoindex_projects_2` (`path`), `sqlite_autoindex_project_folders_2`
(`path`) e `sqlite_autoindex_events_2` (`session_id, seq`). `migrations` não tem índice
automático (`INTEGER PRIMARY KEY` é o próprio `rowid`). Conferido com `PRAGMA index_list`
num banco novo (seção 9).

### 3.1 `projects`

Criada em `store/src/migrations.ts:16-22`; colunas extras em :177, :189, :193.

| Coluna | Tipo | NULL | Default | Notas |
|---|---|---|---|---|
| `id` | TEXT | (sim, ver acima) | | PK. `prj_…` (`store/src/repositories.ts:89`). |
| `name` | TEXT | não | | |
| `path` | TEXT | não | | **UNIQUE**. Pasta principal (`core/src/domain.ts:71-79`). |
| `default_branch` | TEXT | não | `'main'` | |
| `created_at` | TEXT | não | | ISO 8601 UTC. |
| `trusted` | INTEGER | não | `0` | v5. Só `1` é verdadeiro (`store/src/repositories.ts:912`). |
| `trusted_hash` | TEXT | sim | | v6. Hash do conteúdo sensível confiado; `NULL` com `trusted=1` = confiança suspensa (`core/src/domain.ts:91-99`). Desconfiar zera o hash (`store/src/repositories.ts:107-113`). |
| `hub_context` | TEXT | sim | | v6. JSON de `ProjectHubContext`. **Sensível** (seção 5). |

Índices: `sqlite_autoindex_projects_1` (PK), `sqlite_autoindex_projects_2` (UNIQUE `path`).

### 3.2 `project_folders`

`store/src/migrations.ts:127-136`, índice único parcial em :299-300.

| Coluna | Tipo | NULL | Default | Notas |
|---|---|---|---|---|
| `id` | TEXT | | | PK. `pfd_…` (`store/src/repositories.ts:155`) ou `pfd_prj_…` (backfill v2). |
| `project_id` | TEXT | não | | FK → `projects(id)`. |
| `path` | TEXT | não | | **UNIQUE global**: uma pasta pertence a no máximo um projeto (`store/src/migrations.ts:124-126`). |
| `label` | TEXT | sim | | |
| `is_primary` | INTEGER | não | `0` | Só `1` é verdadeiro (`store/src/repositories.ts:923-925`). |
| `created_at` | TEXT | não | | |

Índices: `idx_project_folders_project (project_id)`;
`idx_project_folders_primaria` **UNIQUE** `(project_id) WHERE is_primary = 1`; autoindex da
PK e do UNIQUE `path`.

Única tabela com `DELETE` no store (`store/src/repositories.ts:172-174`).

### 3.3 `sessions`

`store/src/migrations.ts:24-45`; `pid` em :154; `idx_sessions_ended` em :166.

| Coluna | Tipo | NULL | Default | Notas |
|---|---|---|---|---|
| `id` | TEXT | | | PK. `ses_…`. |
| `project_id` | TEXT | não | | FK → `projects(id)`. |
| `agent_id` | TEXT | não | | Muda no handoff (`store/src/repositories.ts:231-237`). |
| `native_session_id` | TEXT | sim | | Id da sessão no CLI nativo (`core/src/domain.ts:143-144`). |
| `root_id` | TEXT | não | | Raiz da árvore; na raiz, `root_id = id` (`core/src/domain.ts:145-146`). |
| `parent_id` | TEXT | sim | | FK → `sessions(id)`. |
| `depth` | INTEGER | não | `0` | Raiz = 0 (`core/src/domain.ts:148-149`). |
| `path_json` | TEXT | não | `'[]'` | Array JSON de `"<agentId>:<objectiveHash>"` da raiz até aqui (`core/src/domain.ts:150-151`); hash = 16 hex de SHA-256 (`core/src/ids.ts:18-29`). |
| `state` | TEXT | não | | Seção 4.2. |
| `mode` | TEXT | não | | `supervised` \| `semi` \| `autonomous` (`core/src/domain.ts:53`). |
| `isolation` | TEXT | não | | `none` \| `worktree` \| `container` (`core/src/domain.ts:66`). O ADR 7.17 remove `container` no C. |
| `workdir` | TEXT | não | | Diretório real onde o agente roda. |
| `title` | TEXT | sim | | |
| `created_at` | TEXT | não | | |
| `updated_at` | TEXT | não | | Reescrito em todo `update` (`store/src/repositories.ts:228`). |
| `ended_at` | TEXT | sim | | Base da retenção (seção 7). |
| `pid` | INTEGER | sim | | PID da run viva; `NULL` sem run, em processo compartilhado (OpenCode) ou após término limpo (`core/src/domain.ts:161-171`). |

Índices: `idx_sessions_root (root_id)`, `idx_sessions_parent (parent_id)`,
`idx_sessions_project (project_id, state)`, `idx_sessions_agent (agent_id, state)`,
`idx_sessions_ended (ended_at)`, autoindex da PK.

### 3.4 `tasks`

`store/src/migrations.ts:47-60`.

| Coluna | Tipo | NULL | Default | Notas |
|---|---|---|---|---|
| `id` | TEXT | | | PK. `tsk_…`. |
| `session_id` | TEXT | não | | FK → `sessions(id)`. Muda no fallback (`store/src/repositories.ts:372-377`). |
| `requester_session_id` | TEXT | sim | | FK → `sessions(id)`. `NULL` = pedido humano (`core/src/domain.ts:186-187`). |
| `brief_json` | TEXT | não | | JSON do `Brief` (`core/src/brief.ts:74-111`). |
| `state` | TEXT | não | | Seção 4.2. |
| `attempts_json` | TEXT | não | `'[]'` | Array de `TaskAttempt` (`core/src/domain.ts:174-181`). |
| `result_json` | TEXT | sim | | `TaskResult` ou `NULL` (`core/src/domain.ts:196-202`; `store/src/repositories.ts:353`). |
| `created_at` / `updated_at` | TEXT | não | | |

Índices: `idx_tasks_session`, `idx_tasks_state`, `idx_tasks_requester`, autoindex da PK.

### 3.5 `events`

`store/src/migrations.ts:62-77`, alterada nas v8, v9 e v10.

| Coluna | Tipo | NULL | Default | Notas |
|---|---|---|---|---|
| `id` | TEXT | | | PK. `evt_…` (`core/src/events.ts:126`). |
| `seq` | INTEGER | não | | Monotônico por sessão, começa em 1 (`core/src/events.ts:112-116`). |
| `ts` | TEXT | não | | ISO 8601 UTC (`core/src/events.ts:128`). |
| `session_id` | TEXT | não | | FK → `sessions(id)`. |
| `task_id` | TEXT | sim | | **Sem FK declarada**; gatilho `trg_events_task_existe` (v10). |
| `agent_id` | TEXT | não | | |
| `type` | TEXT | não | | Um dos 22 `EventType` (`core/src/events.ts:10-37`). |
| `payload_json` | TEXT | não | | Objeto JSON; `{}` quando ausente (`core/src/events.ts:133`). |
| `cost_json` | TEXT | sim | | `EventCost` ou `NULL` (seção 4.4). |
| `raw_json` | TEXT | sim | | Evento nativo do agente, íntegro (`core/src/events.ts:83-87`); `NULL` se ausente (`store/src/repositories.ts:429`) ou compactado. |
| `cost_tokens` | INTEGER | — | gerada | v9, VIRTUAL (`hidden=2` no `table_xinfo`). |
| `cost_usd` | REAL | — | gerada | v9, VIRTUAL. |

Restrição: `UNIQUE (session_id, seq)` (autoindex `sqlite_autoindex_events_2`).

Índices finais:

| Índice | Colunas | Parcial |
|---|---|---|
| `idx_events_session` | `(session_id, seq)` | — |
| `idx_events_raw` | `(session_id)` | `WHERE raw_json IS NOT NULL` |
| `idx_events_custo_soma` | `(session_id, cost_usd, cost_tokens)` | `WHERE cost_tokens IS NOT NULL` |
| `idx_events_type_sessao` | `(type, session_id, seq)` | — |
| `idx_events_task_sessao` | `(task_id, session_id, seq)` | — |
| `idx_events_ts` | `(ts)` | — |

Não existem mais: `idx_events_task`, `idx_events_type`, `idx_events_custo` (removidos na v9).

### 3.6 `approvals`

`store/src/migrations.ts:79-91`.

| Coluna | Tipo | NULL | Default | Notas |
|---|---|---|---|---|
| `id` | TEXT | | | PK. `apv_…` (prefixo em `core/src/ids.ts:7`). |
| `session_id` | TEXT | não | | FK → `sessions(id)`. |
| `task_id` | TEXT | sim | | FK → `tasks(id)`. |
| `risk` | TEXT | não | | `read` \| `write` \| `exec` \| `escalate` \| `irreversible` \| `budget` (`core/src/policy.ts:12`). |
| `action` | TEXT | não | | Texto legível. |
| `detail_json` | TEXT | não | `'{}'` | Objeto JSON. |
| `state` | TEXT | não | | Seção 4.2. |
| `requested_at` | TEXT | não | | |
| `resolved_at` / `resolved_by` | TEXT | sim | | |

Índice: `idx_approvals_state (state, requested_at)`.

### 3.7 `artifacts`

`store/src/migrations.ts:93-102`.

| Coluna | Tipo | NULL | Notas |
|---|---|---|---|
| `id` | TEXT | | PK. `art_…`. |
| `session_id` | TEXT | não | FK → `sessions(id)`. |
| `task_id` | TEXT | sim | FK → `tasks(id)`. |
| `kind` | TEXT | não | Tipo declara `diff` \| `file` \| `report` \| `log` \| `transcript` (`core/src/domain.ts:218`); o único escritor grava `diff` (`daemon/src/artifact-capture.ts:55`). |
| `path` | TEXT | não | Caminho **absoluto** do arquivo em `<home>/artifacts/…` (seção 6.4). |
| `hash` | TEXT | sim | O escritor grava `NULL` (`daemon/src/artifact-capture.ts:57`). |
| `created_at` | TEXT | não | |

Índice: `idx_artifacts_session (session_id)`.

### 3.8 `budgets`

`store/src/migrations.ts:104-110`. Uma linha por árvore (raiz).

| Coluna | Tipo | NULL | Notas |
|---|---|---|---|
| `root_id` | TEXT | | PK. Id da sessão-raiz. **Sem FK.** |
| `limits_json` | TEXT | não | `{"usd","tokens","seconds"}` (`core/src/budget.ts:3-7`). |
| `consumed_json` | TEXT | não | `{"usd","tokens","seconds"}` (`core/src/budget.ts:9-13`). |
| `reserved_json` | TEXT | não | Idem; reservado por tasks em andamento (`core/src/domain.ts:234-235`). |
| `updated_at` | TEXT | não | |

Gravação por `INSERT … ON CONFLICT(root_id) DO UPDATE` (`store/src/repositories.ts:637-656`).
JSON ilegível vira `{0,0,0}` na leitura (`store/src/repositories.ts:663-665`). O que
significa um limite `0` (ilimitado ou bloqueado) **NÃO DETERMINADO** neste documento
(pertence à especificação de orçamento).

### 3.9 `audit_log`

`store/src/migrations.ts:207-223`. Só acréscimo, sem FK: "precisa sobreviver a qualquer
limpeza das outras tabelas" (`store/src/migrations.ts:205-206`).

| Coluna | Tipo | NULL | Default | Notas |
|---|---|---|---|---|
| `id` | TEXT | | | PK. `aud_…` (`daemon/src/audit.ts:52`). |
| `ts` | TEXT | não | | `nowIso()` (`daemon/src/audit.ts:53`). |
| `actor` | TEXT | não | | `cli:<usuário>`, `web`, `gate`, `policy`, `daemon`… (`core/src/audit.ts:28-34`). |
| `kind` | TEXT | não | | Um de 13 `AuditKind` (`core/src/audit.ts:10-23`). |
| `session_id`, `project_id`, `approval_id` | TEXT | sim | | Sem FK. |
| `action` | TEXT | não | | |
| `decision`, `risk`, `reason` | TEXT | sim | | |
| `detail_json` | TEXT | não | `'{}'` | |

Índices: `idx_audit_ts (ts)`, `idx_audit_session (session_id, ts)`,
`idx_audit_project (project_id, ts)`. Listagem ordena por `ts DESC, rowid DESC`, limite
padrão 200, teto 5000 (`store/src/repositories.ts:684`, `store/src/repositories.ts:736-741`).

## 4. Semântica das colunas

### 4.1 Ids e timestamps

- **Ids:** `<prefixo>_<24 hex>`, os 24 primeiros hex de um UUID v4 sem hífens
  (`core/src/ids.ts:9-11`). Prefixos: `prj`, `pfd`, `ses`, `tsk`, `evt`, `apv`, `art`,
  `run`, `aud` (`core/src/ids.ts:7`). Exceção: backfill da v2 (seção 2.1).
- **Timestamps no banco:** texto ISO 8601 em **UTC**, com milissegundos e `Z`
  (`new Date().toISOString()`, `core/src/ids.ts:31-33`). Comparações de retenção são por
  string (`s.ended_at < ?`, `store/src/repositories.ts:531`), o que depende desse formato
  fixo.
- **Booleanos:** INTEGER 0/1; só `1` é verdadeiro (`store/src/repositories.ts:912`, `:925`).
- **JSON:** gravado com `JSON.stringify(value ?? null)` (`store/src/db.ts:100-102`). Leitura
  tolerante: vazio, inválido ou `null` vira o valor padrão (`store/src/db.ts:104-121`).

### 4.2 Estados

| Tabela.coluna | Valores | Terminais | Fonte |
|---|---|---|---|
| `sessions.state` | `idle`, `running`, `waiting_approval`, `paused`, `completed`, `failed`, `killed` | `completed`, `failed`, `killed` | `core/src/domain.ts:40`, `:46-47` |
| `tasks.state` | `submitted`, `working`, `input_required`, `auth_required`, `completed`, `failed`, `canceled`, `rejected` | `completed`, `failed`, `canceled`, `rejected` | `core/src/domain.ts:6-21` |
| `approvals.state` | `pending`, `approved`, `denied`, `expired` | — | `core/src/domain.ts:212` |

- "Ativa" = `running` ou `waiting_approval` (`store/src/repositories.ts:326`).
- `expired` está no tipo, mas `grep` não achou escritor em `core`, `store` ou `daemon`.
- Na subida, sessões `running`/`waiting_approval` sem aprovação pendente viram `killed`,
  com `ended_at` preenchido e `pid = NULL`; se havia `pid`, o processo órfão é morto antes
  (`daemon/src/session-manager.ts:706-742`).

### 4.3 `payload_json` e `raw_json`

- `payload_json`: objeto JSON livre por tipo de evento (`core/src/events.ts:81`). O formato
  por tipo **NÃO DETERMINADO** aqui (pertence à especificação de eventos).
- `raw_json`: o evento original do agente, preservado para depurar o mapeamento
  (`core/src/events.ts:83-87`). É o único campo que a retenção zera (seção 7).
- Nenhuma redação de segredo no caminho de gravação: `append` grava `payload`/`raw` como
  vieram, só serializados com `toJson` (`store/src/repositories.ts:413-431`).
- Máscara com `***` existe em outro caminho, o da descoberta/absorção de configs de agentes,
  e não na gravação de eventos: `adapters/src/discovery/util.ts:120-149` e
  `daemon/src/absorption.ts:39-125` (`redactUrl`, `redactArgs`, `mascararValores`).

### 4.4 Custo (`cost_json`, `cost_usd`, `cost_tokens`)

`cost_json` é um `EventCost` (`core/src/events.ts:39-70`), todos os campos opcionais:
`inputTokens`, `outputTokens`, `cachedTokens`, `cacheWriteTokens`, `usd`, `provisional`,
`partId`, `cumulative`, `credits`.

- **Unidade:** `EventCost` só declara `number` para tokens e `usd` (`core/src/events.ts:40-46`);
  unidade monetária e inteireza dos tokens **NÃO DETERMINADAS** pelo tipo. No banco,
  `cost_tokens` é declarada `INTEGER` e `cost_usd` `REAL` (`store/src/migrations.ts:255`, `:261`).
- **Regra de soma:** evento com `provisional = true` **não conta** (`core/src/events.ts:47-57`).
  As colunas geradas aplicam a regra: `cost_tokens = inputTokens + outputTokens` (sem cache),
  `cost_usd = usd`; ambos `NULL` se não conta (`store/src/migrations.ts:255-265`).
- Somas por sessão e do grafo usam só `cost_tokens IS NOT NULL`
  (`store/src/repositories.ts:49-50`, `:298-304`, `:498-507`). `costOf` devolve
  `seconds: 0` (`store/src/repositories.ts:506`).

## 5. Dados sensíveis

| Onde | O quê | Formato |
|---|---|---|
| `projects.hub_context` | **Env por agente, em texto puro**, digitado pelo usuário (`hub project env`, painel, `hub import`), além de `memory` e `prompts` | JSON `{"memory"?: string, "prompts"?: {agentId: string}, "env"?: {agentId: {VAR: valor}}}` (`core/src/domain.ts:108-114`) |
| `<home>/operator-token` | Token de operador, 32 bytes aleatórios em hex (64 chars) + `\n` | Arquivo (seção 6.2) |
| `events.payload_json` / `events.raw_json` | O que o agente produziu, sem redação (seção 4.3). Pode conter segredo que o agente leu ou imprimiu | JSON |

- Escrita do env: `ProjectRegistry.setContext` → `sanitizeHubContext` → `setHubContext`
  (`daemon/src/project-registry.ts:163-167`, `daemon/src/repo-trust.ts:171-192`,
  `store/src/repositories.ts:129-131`). A sanitização filtra nomes pela lista de permissão
  (`daemon/src/repo-trust.ts:182-189`); **não cifra** o valor.
- O próprio SECURITY.md registra: o env informado pelo Hub "fica em **texto puro** no banco do
  Hub" e "Não existe cofre" (`SECURITY.md:351-355`).
- `hub_context` ilegível é tratado como `{}` sem derrubar o daemon
  (`store/src/repositories.ts:115-127`).
- `trusted_hash` é hash, não segredo.
- **Não há** token de API, senha ou credencial de CLI em outra coluna: o Hub não lê os
  arquivos de credencial dos CLIs (`SECURITY.md:351-352`).

**Para o ADR 7.16:** o que sai para o cofre do SO é `projects.hub_context → $.env`. O formato
da referência que ficará no banco, o nome das entradas no cofre e o destino de
`memory`/`prompts` (não são segredo) **não estão decididos** (o ADR 07 não os define).

## 6. Diretório `AGENTS_HUB_HOME`

`loadConfig` cria `home`, `worktrees/`, `artifacts/` e `logs/` em toda carga
(`daemon/src/config.ts:352-355`). O resto nasce sob demanda.

| Caminho | O que é | Quem cria | Fonte |
|---|---|---|---|
| `hub.db`, `hub.db-wal`, `hub.db-shm` | Banco (WAL) | daemon | `daemon/src/config.ts:316`; `store/src/db.ts:33` |
| `config.json` | Config global (6.1) | usuário / `hub policy` / `hub hooks install codex` | `daemon/src/config.ts:307` |
| `config.json.bak-AAAAMMDD-HHMMSS[-N]` | Backup versionado antes de regravar `config.json`; hora **local** | `gravarComBackup` | `daemon/src/safe-write.ts:34-39`, `:46-60`, `:79-87`; usos em `daemon/src/policy-service.ts:131`, `daemon/src/config.ts:394` |
| `operator-token` | Token de operador (6.2) | daemon | `daemon/src/operator-auth.ts:54-56`, `:69-96` |
| `logs/daemon-AAAA-MM-DD.log` | stdout/stderr do daemon autostartado, append, um por dia; data em **UTC** | CLI (autostart) | `cli/src/daemon-control.ts:72-75`; filtro em `cli/src/logs-cmd.ts:16` |
| `worktrees/<projeto>/<sessionId>/` | Worktree git da sessão, branch `hub/<sessionId>` | daemon | `daemon/src/worktree.ts:239-240`; nome da pasta `daemon/src/worktree.ts:616-625` |
| `artifacts/<sessionId>/baseline.json` | Linha de base do diff | daemon | `daemon/src/diff-capture.ts:186-188` |
| `artifacts/<sessionId>/changes.patch` | Diff capturado (é o `artifacts.path`) | daemon | `daemon/src/diff-capture.ts:327-330` |
| `probes.json` | Cache de probe dos agentes (6.3) | daemon | `daemon/src/hub.ts:76`; `adapters/src/registry.ts:162-167` |
| `opencode-config/opencode.json` | Agentes `hub-*` do OpenCode; `OPENCODE_CONFIG_DIR` | adapter OpenCode | `daemon/src/hub.ts:86`; `adapters/src/opencode/permissions.ts:176-188` |
| `run/<sessionId>-settings.json` | Settings por sessão com o hook do gate (Claude/OpenClaude); apagado ao fim | daemon | `daemon/src/session-settings.ts:31-33`, `:45-60` |
| `manifests/` | Opcional. Se existir, **substitui** os manifestos embutidos | usuário | `daemon/src/config.ts:313`, `:320` |
| `backups/hub-AAAAMMDD-HHMMSS.db` | Destino padrão de `hub backup`; hora **local** | CLI / daemon | `cli/src/backup-cmd.ts:32`; `daemon/src/maintenance-routes.ts:57`; `store/src/backup.ts:36-42` |
| `hub.db.pre-restore-AAAAMMDD-HHMMSS[-N]` (+ `-wal`/`-shm` no caminho cru) | Cópia de segurança antes de restaurar | CLI | `store/src/backup.ts:187-207` |
| `hub.db.restore-tmp-<pid>` | Temporário do restore, renomeado por cima | CLI | `store/src/backup.ts:212-214` |
| `smoke-projeto/` | Repositório descartável do smoke do `hub doctor` | CLI | `cli/src/doctor-cmd.ts:386-387` |
| `*.tmp-<pid>-…` | Temporários de escrita atômica (`operator-token`, `config.json`) | daemon / CLI | `daemon/src/operator-auth.ts:80`; `daemon/src/safe-write.ts:65` |

Fora do home: o OpenCode sem `configDir` usaria `<tmp>/agents-hub-opencode-config`
(`adapters/src/opencode/adapter.ts:134`), mas o daemon sempre passa o do home
(`daemon/src/hub.ts:86`).

### 6.1 `config.json`

Precedência: padrões < `config.json` < variáveis de ambiente < overrides
(`daemon/src/config.ts:292-300`, `:301-358`). BOM é removido (`daemon/src/config.ts:271`).
JSON inválido ou fora do schema → `HubError('HUB_CONFIG_INVALID')` com linha/coluna
(`daemon/src/config.ts:273-288`). Chaves desconhecidas são aceitas (`.passthrough()`,
`daemon/src/config.ts:237`); `policy` é estrito: `PartialPolicyDocumentSchema =
PolicyDocumentSchema.deepPartial()` (`core/src/policy.ts:245`), sobre objetos `.strict()`
(`core/src/policy.ts:142-144`).

Schema em `daemon/src/config.ts:205-237`:

| Chave | Tipo / faixa | Padrão | Fonte do padrão |
|---|---|---|---|
| `home` | string ≥1 | `AGENTS_HUB_HOME` ou `~/.agents-hub` | `:306` |
| `dbFile` | string ≥1 | `<home>/hub.db` | `:316` |
| `worktreeRoot` | string ≥1 | `<home>/worktrees` | `:317` |
| `artifactRoot` | string ≥1 | `<home>/artifacts` | `:318` |
| `logDir` | string ≥1 | `<home>/logs` | `:319` |
| `manifestsDir` | string ≥1 | `<home>/manifests` se existir, senão os embutidos | `:320` |
| `host` | string ≥1 | `127.0.0.1` | `:321` |
| `port` | int 1–65535 | `4747` (`AGENTS_HUB_PORT` sobrepõe) | `:322`, `:310-311` |
| `webRoot` | string ≥1 | painel embutido | `:323` |
| `opencodePort` | int 1–65535 | `4790` | `:324` |
| `maxSseConnections` | int 1–100000 | `100` | `:88`, `:325` |
| `policy` | `PartialPolicyDocumentSchema` (estrito) | `DEFAULT_POLICY`, mesclado campo a campo | `:332-335`; `core/src/policy.ts:245`, `:510` |
| `retention.worktreeDays` | number | `7` | `:116-120` |
| `retention.sweepIntervalMinutes` | number | `60` | `:116-120` |
| `retention.rawEventDays` | number | `7` | `:116-120` |
| `codexGate.bypassHookTrust` | boolean | `false` | `:65-67` |
| `gate.failMode` | `open` \| `closed` | ausente (fechado dentro de sessão do Hub, aberto fora) | `:69-86` |

Linhas desta tabela sem arquivo são de `daemon/src/config.ts`.

Observações conferidas no código:

- `home` e os caminhos são espalhados com `...onDisk` **depois** de calculados
  (`daemon/src/config.ts:314-326`). Um `home` no `config.json` muda `config.home` (e portanto
  onde ficam `operator-token`, `probes.json`, `run/`, `backups/`), mas não `dbFile`,
  `worktreeRoot`, `artifactRoot` e `logDir`, que já foram derivados do home original — a
  menos que também estejam no arquivo. O arquivo em si é sempre lido do home original
  (`daemon/src/config.ts:307`).
- `retention.*` não tem faixa no schema (`daemon/src/config.ts:219-225`).
- `saveConfig` grava a config efetiva inteira sem `home` (`daemon/src/config.ts:360-368`).
  As gravações de política e do bypass do Codex regravam só a chave alterada, com backup
  (`daemon/src/policy-service.ts:131`; `daemon/src/config.ts:380-396`).
- O conteúdo de `policy` **NÃO DETERMINADO** neste documento (ver `core/src/policy.ts`).

### 6.2 `operator-token`

- 32 bytes aleatórios em hex minúsculo, seguido de `\n`
  (`daemon/src/operator-auth.ts:79`, `:82`). Validação: `^[0-9a-f]{64}$`
  (`core/src/operator-token.ts:30`).
- Reaproveitado se válido; senão, gerado de novo. Rotação = apagar e reiniciar
  (`daemon/src/operator-auth.ts:58-77`).
- Criado em temporário com modo `0600`, restringido e só então renomeado
  (`daemon/src/operator-auth.ts:80-84`). No Windows, `icacls <arq> /inheritance:r
  /grant:r <usuário>:F` (`daemon/src/operator-auth.ts:122-127`). No POSIX, `chmod 0600` a
  cada subida (`daemon/src/operator-auth.ts:73-75`).

### 6.3 `probes.json`

Array JSON de `ProbeResult`: `agentId`, `installed`, `version`, `authenticated`
(`boolean|null`), `binPath`, `error`, `checkedAt` (`adapters/src/types.ts:239-248`).
Validade: 24 h se instalado, 5 min se não (`adapters/src/registry.ts:48`, `:141-146`).
Arquivo corrompido é ignorado (`adapters/src/registry.ts:148-160`).

### 6.4 Arquivos em disco não estão no banco

`hub restore` avisa que worktrees e artefatos não fazem parte do banco
(`cli/src/backup-cmd.ts:93-97`). `artifacts.path` e `sessions.workdir` guardam caminhos
**absolutos**; se o C mudar o home ou o layout, esses valores apontam para o lugar antigo.

## 7. Retenção e compactação

Eventos nunca são apagados; só `raw_json` vira `NULL`
(`store/src/repositories.ts:509-517`).

- **Quem:** `EventRetentionCompactor` (`daemon/src/event-retention.ts:103-185`), iniciado
  depois da reconciliação (`daemon/src/hub.ts:213-214`).
- **Quando:** uma passada na largada e depois a cada `sweepIntervalMinutes` (mínimo 1)
  (`daemon/src/event-retention.ts:116-133`). Passadas não se sobrepõem
  (`daemon/src/event-retention.ts:141-146`).
- **Corte:** `agora − rawEventDays` dias, em ISO UTC (`daemon/src/event-retention.ts:149-151`).
- **SQL**, em lotes de `COMPACTION_BATCH = 2000`, cedendo o loop entre lotes
  (`daemon/src/event-retention.ts:101`, `:154-161`; `store/src/repositories.ts:518-537`):

  ```sql
  UPDATE events SET raw_json = NULL
  WHERE rowid IN (
    SELECT e.rowid FROM sessions s
    JOIN events e ON e.session_id = s.id AND e.raw_json IS NOT NULL
    WHERE s.ended_at IS NOT NULL AND s.ended_at < ?
    LIMIT ?
  )
  ```

- **Devolução de espaço:** se `auto_vacuum = incremental` e há páginas livres,
  `PRAGMA incremental_vacuum(128)` em lotes e, no fim, `PRAGMA wal_checkpoint(TRUNCATE)`
  (`daemon/src/event-retention.ts:22`, `:171-184`; `store/src/repositories.ts:786-802`).
- **Banco antigo sem `auto_vacuum`:** na subida, se o dado vivo
  (`(page_count − freelist_count) × page_size`) ≤ 64 MiB, roda `PRAGMA auto_vacuum =
  INCREMENTAL; VACUUM;` + checkpoint `TRUNCATE`; acima disso só registra no log
  (`daemon/src/event-retention.ts:33`, `:40-74`; `store/src/repositories.ts:814-818`;
  `daemon/src/hub.ts:183-197`). Falha não derruba a subida (`daemon/src/hub.ts:195-197`).
- **Worktrees:** o `WorktreeReaper` recolhe worktree de sessão encerrada há mais de
  `worktreeDays` (`daemon/src/reaper.ts:83-94`); o branch `hub/<sessionId>` fica
  (`daemon/src/config.ts:96-97`).

## 8. Backup e restauração

### 8.1 Backup (`store/src/backup.ts:52-89`)

- Abre **conexão própria** com `busy_timeout = 5000` e `auto_vacuum = INCREMENTAL` (só
  pendente na origem), e roda `VACUUM INTO ?` com o destino como parâmetro
  (`store/src/backup.ts:68-79`). A cópia enxerga o WAL e já sai `INCREMENTAL`.
- Recusa sobrescrever destino existente (`store/src/backup.ts:57-65`); apaga o parcial em
  caso de falha (`store/src/backup.ts:80-82`).
- Confere a cópia com `conferirBanco` e devolve `{path, bytes, schemaVersion}`
  (`store/src/backup.ts:87-88`).
- Com o daemon no ar, a CLI pede `POST /maintenance/backup` (token de operador, `out`
  absoluto, registrado na auditoria como `maintenance.backup`); parado, faz localmente
  (`cli/src/backup-cmd.ts:30-34`; `daemon/src/maintenance-routes.ts:47-73`).

### 8.2 Verificação de versão (`conferirBanco`, `store/src/backup.ts:96-153`)

1. Abre como SQLite; falha → `INVALID_PATH`.
2. `PRAGMA integrity_check` precisa ser exatamente `ok`.
3. Precisa existir a tabela `migrations`.
4. `MAX(version)` > maior versão conhecida → `HUB_CONFIG_INVALID` ("Atualize o Hub").
5. Versão **menor** é aceita; o banco é migrado na próxima abertura pelo daemon.

### 8.3 Restauração (`store/src/backup.ts:168-217`)

Só com o daemon parado; a CLI recusa se `/health` responder (`cli/src/backup-cmd.ts:62-66`).
Sem `--write`, só mostra o plano (`cli/src/backup-cmd.ts:73-84`). Ordem:

1. Recusa backup = banco atual; roda `conferirBanco` no backup antes de tocar em algo
   (`store/src/backup.ts:177-183`).
2. Guarda o atual em `hub.db.pre-restore-AAAAMMDD-HHMMSS[-N]` via `VACUUM INTO`; se falhar,
   copia `.db`, `-wal` e `-shm` crus (`store/src/backup.ts:185-208`).
3. Apaga `-wal`/`-shm` do atual (`store/src/backup.ts:210`).
4. Copia o backup para `hub.db.restore-tmp-<pid>` e renomeia por cima
   (`store/src/backup.ts:211-214`).

## 9. Como isto foi conferido

Script em diretório temporário (fora do repositório e fora de `~/.agents-hub`) que importa
`packages/store/dist/index.js`, abre um banco **novo** com `openDatabase`, e despeja
PRAGMAs, `migrations`, `sqlite_master`, `PRAGMA table_xinfo`, `PRAGMA foreign_key_list` e
`PRAGMA index_list`/`index_info`.
O `dist` tem as 10 migrações (`grep -c "version:" packages/store/dist/migrations.js` → 10).
O banco real do usuário **não foi aberto**.

Testes do TS que fixam este comportamento (ADR 7.10): `store/src/db.test.ts`,
`store/src/integridade.test.ts`, `store/src/backup.test.ts`, `store/src/events-page.test.ts`,
`store/src/repositories.test.ts`, `daemon/src/event-retention.test.ts`,
`daemon/src/espaco-do-banco.test.ts`.

## 10. Consequências para a migração em C (ADR 7.15)

Fatos do código relevantes para a migração. O desenho da migração **não está
decidido**.

- Banco de origem: `migrations.version` de 1 a 10. Banco com versão > 10 hoje é recusado
  pelo TS (`store/src/db.ts:63-75`); banco com versão < 10 é migrado em ordem.
- `events.cost_tokens`/`cost_usd` são colunas geradas: não há dado a copiar, mas a
  definição é usada por `idx_events_custo_soma` (`store/src/migrations.ts:268-269`).
- `events.task_id` não tem FK; pode haver linhas órfãs anteriores à v10.
- `project_folders.id` pode ter o formato `pfd_prj_…` (backfill v2).
- `TEXT PRIMARY KEY` aceita NULL no SQLite (seção 3).
- Banco pode estar com `auto_vacuum = none`: anterior ao R09-07 e com mais de 64 MiB de dado
  vivo (`daemon/src/event-retention.ts:33`, `:48`), ou quando a conversão na subida falhou
  (`daemon/src/hub.ts:195-197`).
- `projects.hub_context → $.env` é o único segredo do usuário no banco (seção 5).
- Caminhos absolutos em `sessions.workdir` e `artifacts.path` (seção 6.4).
