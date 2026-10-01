/* Tipos do domínio: enumerações e entidades (plano docs/17, F1-01;
 * SPEC-04 A1 "Entidades" e A3 "Estados"; SPEC-02 §3 e §4.2; fonte
 * core/src/domain.ts).
 *
 * Cada enumeração tem o texto exato do TS (é o que vai para o banco e para a
 * API) e um par `_name`/`_parse`. `_parse` compara bytes exatos e devolve
 * AH_ERR_NOT_FOUND para texto que não é um dos valores (o chamador decide o
 * erro de domínio). A ordem dos valores do enum é a ordem do tipo no TS e
 * não é contrato fora deste header (rank de modo: ah_session_mode_rank).
 *
 * Entidades: structs de dados com posse explícita. Todo `char *` é UTF-8
 * terminado em NUL, alocado com malloc e possuído pela struct; os
 * `ah_json *` também são da struct. `_clear` libera tudo o que a struct
 * possui e zera os campos (a struct em si é do chamador; `_clear(NULL)` é
 * no-op). Campo opcional/anulável do TS (`T | null`, `campo?`) é NULL quando
 * ausente ou null, salvo indicação. */
#ifndef AH_CORE_DOMAIN_H
#define AH_CORE_DOMAIN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ah_json.h"
#include "ah_status.h"

/* ---- Enumerações -------------------------------------------------------- */

/* TaskState (domain.ts:6-14): alinhado ao A2A v1.0. `submitted` e
 * `auth_required` existem no esquema e não são gerados (DV-12). */
typedef enum ah_task_state {
    AH_TASK_SUBMITTED,
    AH_TASK_WORKING,
    AH_TASK_INPUT_REQUIRED,
    AH_TASK_AUTH_REQUIRED,
    AH_TASK_COMPLETED,
    AH_TASK_FAILED,
    AH_TASK_CANCELED,
    AH_TASK_REJECTED,
    AH_TASK_STATE_COUNT
} ah_task_state;

/* SessionState (domain.ts:46-47). */
typedef enum ah_session_state {
    AH_SESSION_IDLE,
    AH_SESSION_RUNNING,
    AH_SESSION_WAITING_APPROVAL,
    AH_SESSION_PAUSED,
    AH_SESSION_COMPLETED,
    AH_SESSION_FAILED,
    AH_SESSION_KILLED,
    AH_SESSION_STATE_COUNT
} ah_session_state;

/* SessionMode (domain.ts:53): herdado do pai e nunca escalado. */
typedef enum ah_session_mode {
    AH_MODE_SUPERVISED,
    AH_MODE_SEMI,
    AH_MODE_AUTONOMOUS,
    AH_SESSION_MODE_COUNT
} ah_session_mode;

/* IsolationMode (domain.ts:66). `container` saiu do escopo (ADR 7.17) mas
 * fica aqui para ler linhas antigas como estão (DA-21); recusá-lo na
 * entrada é de quem valida a entrada (Brief, API, CLI). */
typedef enum ah_isolation_mode {
    AH_ISOLATION_NONE,
    AH_ISOLATION_WORKTREE,
    AH_ISOLATION_CONTAINER,
    AH_ISOLATION_MODE_COUNT
} ah_isolation_mode;

/* Approval.state (domain.ts:212). `expired` não é gerado (DV-12). */
typedef enum ah_approval_state {
    AH_APPROVAL_PENDING,
    AH_APPROVAL_APPROVED,
    AH_APPROVAL_DENIED,
    AH_APPROVAL_EXPIRED,
    AH_APPROVAL_STATE_COUNT
} ah_approval_state;

/* ArtifactKind (domain.ts:218). */
typedef enum ah_artifact_kind {
    AH_ARTIFACT_DIFF,
    AH_ARTIFACT_FILE,
    AH_ARTIFACT_REPORT,
    AH_ARTIFACT_LOG,
    AH_ARTIFACT_TRANSCRIPT,
    AH_ARTIFACT_KIND_COUNT
} ah_artifact_kind;

/* TaskAttempt.outcome (domain.ts:179), sem o `null` (ver
 * ah_task_attempt.has_outcome). */
typedef enum ah_attempt_outcome {
    AH_OUTCOME_SUCCESS,
    AH_OUTCOME_ERROR,
    AH_OUTCOME_INVALID,
    AH_OUTCOME_TIMEOUT,
    AH_ATTEMPT_OUTCOME_COUNT
} ah_attempt_outcome;

/* RiskLevel (policy.ts:12), na ordem do tipo do TS. É o tipo do campo
 * Approval.risk; rank e decisão são da política, não deste módulo. */
typedef enum ah_risk_level {
    AH_RISK_READ,
    AH_RISK_WRITE,
    AH_RISK_EXEC,
    AH_RISK_ESCALATE,
    AH_RISK_IRREVERSIBLE,
    AH_RISK_BUDGET,
    AH_RISK_LEVEL_COUNT
} ah_risk_level;

/* Texto do valor, ou NULL fora do enum. Posse: estático. */
const char *ah_task_state_name(ah_task_state v);
const char *ah_session_state_name(ah_session_state v);
const char *ah_session_mode_name(ah_session_mode v);
const char *ah_isolation_mode_name(ah_isolation_mode v);
const char *ah_approval_state_name(ah_approval_state v);
const char *ah_artifact_kind_name(ah_artifact_kind v);
const char *ah_attempt_outcome_name(ah_attempt_outcome v);
const char *ah_risk_level_name(ah_risk_level v);

/* Valor cujo texto é exatamente os `len` bytes de `s`. AH_ERR_NOT_FOUND se
 * não houver (*out intacto); AH_ERR_INVALID se `out` NULL ou `s` NULL com
 * len > 0. */
ah_status ah_task_state_parse(const char *s, size_t len, ah_task_state *out);
ah_status ah_session_state_parse(const char *s, size_t len, ah_session_state *out);
ah_status ah_session_mode_parse(const char *s, size_t len, ah_session_mode *out);
ah_status ah_isolation_mode_parse(const char *s, size_t len, ah_isolation_mode *out);
ah_status ah_approval_state_parse(const char *s, size_t len, ah_approval_state *out);
ah_status ah_artifact_kind_parse(const char *s, size_t len, ah_artifact_kind *out);
ah_status ah_attempt_outcome_parse(const char *s, size_t len, ah_attempt_outcome *out);
ah_status ah_risk_level_parse(const char *s, size_t len, ah_risk_level *out);

/* isTerminalTaskState (domain.ts:16-25): completed, failed, canceled,
 * rejected. Valor fora do enum: false. */
bool ah_task_state_is_terminal(ah_task_state s);

/* isTerminalSessionState (domain.ts:41-44): completed, failed, killed.
 * Valor fora do enum: false. */
bool ah_session_state_is_terminal(ah_session_state s);

/* MODE_RANK (domain.ts:55-59): supervised 0, semi 1, autonomous 2; -1 fora
 * do enum. */
int ah_session_mode_rank(ah_session_mode m);

/* narrowestMode (domain.ts:62-64): o de menor rank; empate fica com `a`.
 * Modo fora do enum vale como o mais restritivo (supervised): a regra de
 * não-escalação não pode afrouxar por valor inválido. */
ah_session_mode ah_session_mode_narrowest(ah_session_mode a, ah_session_mode b);

/* ---- Valores de orçamento ----------------------------------------------- */

/* BudgetUsage e BudgetLimits (budget.ts:3-13): três dimensões. O livro-caixa
 * (BudgetLedger, saneamento) é de outra tarefa (F1-06); aqui só o dado, que
 * as entidades TaskResult e BudgetRecord carregam. */
typedef struct ah_budget_usage {
    double usd;
    double tokens;
    double seconds;
} ah_budget_usage;

typedef struct ah_budget_limits {
    double usd;
    double tokens;
    double seconds;
} ah_budget_limits;

/* ---- Entidades ----------------------------------------------------------- */

/* Project (domain.ts:68-100). `trusted` ausente = false (por isso bool);
 * `trusted_hash` NULL = ausente ou null (o store sempre devolve null quando
 * não há hash, repositories.ts:910-911). */
typedef struct ah_project {
    char *id;
    char *name;
    char *path;
    char *default_branch;
    char *created_at;
    bool trusted;
    char *trusted_hash;
} ah_project;

void ah_project_clear(ah_project *p);

/* ProjectHubContext (domain.ts:108-114). `prompts`: objeto agentId → texto;
 * `env`: objeto agentId → objeto nome → valor. NULL = ausente. O `env` é
 * sensível (SPEC-02 §5): não vai para log nem mensagem de erro. */
typedef struct ah_project_hub_context {
    char *memory;
    ah_json *prompts;
    ah_json *env;
} ah_project_hub_context;

void ah_project_hub_context_clear(ah_project_hub_context *c);

/* ProjectFolder (domain.ts:128-137). `path` é único globalmente. */
typedef struct ah_project_folder {
    char *id;
    char *project_id;
    char *path;
    char *label; /* NULL = null */
    bool is_primary;
    char *created_at;
} ah_project_folder;

void ah_project_folder_clear(ah_project_folder *f);

/* Session (domain.ts:139-172). `path`: cadeia "agentId:objectiveHash" da
 * raiz até aqui, `path_len` itens. Raiz: root_id igual a id, depth 0.
 * `pid` só vale com `has_pid` (pid: number | null). */
typedef struct ah_session {
    char *id;
    char *project_id;
    char *agent_id;
    char *native_session_id; /* NULL = null */
    char *root_id;
    char *parent_id; /* NULL = null */
    int64_t depth;
    char **path;
    size_t path_len;
    ah_session_state state;
    ah_session_mode mode;
    ah_isolation_mode isolation;
    char *workdir;
    char *title; /* NULL = null */
    char *created_at;
    char *updated_at;
    char *ended_at; /* NULL = null */
    bool has_pid;
    int64_t pid;
} ah_session;

void ah_session_clear(ah_session *s);

/* TaskAttempt (domain.ts:174-181). `outcome` só vale com `has_outcome`. */
typedef struct ah_task_attempt {
    int64_t n;
    char *agent_id;
    char *started_at;
    char *ended_at; /* NULL = null */
    bool has_outcome;
    ah_attempt_outcome outcome;
    char *error; /* NULL = null */
} ah_task_attempt;

void ah_task_attempt_clear(ah_task_attempt *a);

/* Item de TaskResult.validation.checks (domain.ts:201). */
typedef struct ah_validation_check {
    char *name;
    bool passed;
    char *detail; /* NULL = ausente */
} ah_validation_check;

/* TaskResult (domain.ts:196-202). `validation` (passed + checks) só vale com
 * `has_validation`; `checks` tem `checks_len` itens. */
typedef struct ah_task_result {
    char *summary;
    char **artifacts;
    size_t artifacts_len;
    ah_budget_usage usage;
    bool has_validation;
    bool validation_passed;
    ah_validation_check *checks;
    size_t checks_len;
} ah_task_result;

void ah_task_result_clear(ah_task_result *r);

/* Task (domain.ts:183-194). `brief` é o Brief já normalizado como objeto JSON
 * (o mesmo que vai para `tasks.brief_json`, SPEC-02 §3.4); o tipo e a
 * validação do Brief são da F1-03. `attempts` tem `attempts_len` itens;
 * `result` NULL = null (alocado com malloc e liberado pelo _clear). */
typedef struct ah_task {
    char *id;
    char *session_id;
    char *requester_session_id; /* NULL = null (pedido humano) */
    ah_json *brief;
    ah_task_state state;
    ah_task_attempt *attempts;
    size_t attempts_len;
    ah_task_result *result;
    char *created_at;
    char *updated_at;
} ah_task;

void ah_task_clear(ah_task *t);

/* Approval (domain.ts:204-216). `detail` é objeto JSON. */
typedef struct ah_approval {
    char *id;
    char *session_id;
    char *task_id; /* NULL = null */
    ah_risk_level risk;
    char *action;
    ah_json *detail;
    ah_approval_state state;
    char *requested_at;
    char *resolved_at; /* NULL = null */
    char *resolved_by; /* NULL = null */
} ah_approval;

void ah_approval_clear(ah_approval *a);

/* Artifact (domain.ts:220-228). */
typedef struct ah_artifact {
    char *id;
    char *session_id;
    char *task_id; /* NULL = null */
    ah_artifact_kind kind;
    char *path;
    char *hash; /* NULL = null */
    char *created_at;
} ah_artifact;

void ah_artifact_clear(ah_artifact *a);

/* BudgetRecord (domain.ts:230-237): uma linha por árvore (raiz). */
typedef struct ah_budget_record {
    char *root_id;
    ah_budget_limits limits;
    ah_budget_usage consumed;
    ah_budget_usage reserved; /* reservado por tasks em andamento */
    char *updated_at;
} ah_budget_record;

void ah_budget_record_clear(ah_budget_record *b);

#endif /* AH_CORE_DOMAIN_H */
