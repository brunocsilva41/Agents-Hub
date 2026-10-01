/* F1-01: enumerações e entidades do domínio (SPEC-04 A1 e A3; SPEC-02 §4.2;
 * core/src/domain.ts).
 *
 * - textos exatos de cada enumeração (o que vai para o banco e para a API);
 * - estados terminais; MODE_RANK e narrowestMode, com os casos
 *   `narrowestMode` de native/tests/conformance/domain/policy-intersect.jsonl;
 * - posse das entidades: `_clear` libera tudo e zera (com ASan, dupla
 *   liberação ou liberação inválida derrubam o teste). */
#include <stdlib.h>
#include <string.h>

#include "ah_domain.h"
#include "ah_test.h"
#include "ah_test_jsonl.h"
#include "corpus_policy_intersect.h"

#define COUNT_OF(a) (sizeof(a) / sizeof((a)[0]))

/* ---- Textos -------------------------------------------------------------- */

/* Confere name/parse de uma enumeração contra a lista do TS. */
#define CHECK_ENUM(type, prefix, count, ...)                                              \
    do {                                                                                  \
        static const char *const want[] = {__VA_ARGS__};                                  \
        size_t i_;                                                                        \
        type out_;                                                                        \
        CHECK(COUNT_OF(want) == (size_t)(count));                                         \
        for (i_ = 0; i_ < COUNT_OF(want); i_++) {                                         \
            const char *n_ = prefix##_name((type)i_);                                     \
            CHECK(n_ != NULL && strcmp(n_, want[i_]) == 0);                               \
            out_ = (type)(count);                                                         \
            CHECK(prefix##_parse(want[i_], strlen(want[i_]), &out_) == AH_OK);            \
            CHECK(out_ == (type)i_);                                                      \
        }                                                                                 \
        CHECK(prefix##_name((type)(count)) == NULL);                                      \
        out_ = (type)0;                                                                   \
        CHECK(prefix##_parse("x", 1, &out_) == AH_ERR_NOT_FOUND && out_ == (type)0);      \
        CHECK(prefix##_parse("", 0, &out_) == AH_ERR_NOT_FOUND);                          \
        CHECK(prefix##_parse(want[0], strlen(want[0]), NULL) == AH_ERR_INVALID);          \
        CHECK(prefix##_parse(NULL, 1, &out_) == AH_ERR_INVALID);                          \
    } while (0)

static void test_enum_texts(void) {
    CHECK_ENUM(ah_task_state, ah_task_state, AH_TASK_STATE_COUNT, "submitted", "working",
               "input_required", "auth_required", "completed", "failed", "canceled",
               "rejected");
    CHECK_ENUM(ah_session_state, ah_session_state, AH_SESSION_STATE_COUNT, "idle", "running",
               "waiting_approval", "paused", "completed", "failed", "killed");
    CHECK_ENUM(ah_session_mode, ah_session_mode, AH_SESSION_MODE_COUNT, "supervised", "semi",
               "autonomous");
    CHECK_ENUM(ah_isolation_mode, ah_isolation_mode, AH_ISOLATION_MODE_COUNT, "none",
               "worktree", "container");
    CHECK_ENUM(ah_approval_state, ah_approval_state, AH_APPROVAL_STATE_COUNT, "pending",
               "approved", "denied", "expired");
    CHECK_ENUM(ah_artifact_kind, ah_artifact_kind, AH_ARTIFACT_KIND_COUNT, "diff", "file",
               "report", "log", "transcript");
    CHECK_ENUM(ah_attempt_outcome, ah_attempt_outcome, AH_ATTEMPT_OUTCOME_COUNT, "success",
               "error", "invalid", "timeout");
    CHECK_ENUM(ah_risk_level, ah_risk_level, AH_RISK_LEVEL_COUNT, "read", "write", "exec",
               "escalate", "irreversible", "budget");
}

static void test_parse_exact(void) {
    ah_session_state s = AH_SESSION_IDLE;
    ah_isolation_mode m = AH_ISOLATION_NONE;

    CHECK(ah_session_state_parse("Running", 7, &s) == AH_ERR_NOT_FOUND);
    CHECK(ah_session_state_parse("run", 3, &s) == AH_ERR_NOT_FOUND);
    CHECK(ah_session_state_parse("running ", 8, &s) == AH_ERR_NOT_FOUND);
    CHECK(ah_session_state_parse("runningX", 7, &s) == AH_OK && s == AH_SESSION_RUNNING);
    /* Linha antiga do banco com `container` é lida como está (DA-21). */
    CHECK(ah_isolation_mode_parse("container", 9, &m) == AH_OK && m == AH_ISOLATION_CONTAINER);
}

/* ---- Terminais e modos --------------------------------------------------- */

static void test_terminal(void) {
    static const bool task_terminal[AH_TASK_STATE_COUNT] = {
        false, false, false, false, true, true, true, true,
    };
    static const bool session_terminal[AH_SESSION_STATE_COUNT] = {
        false, false, false, false, true, true, true,
    };
    int i;

    for (i = 0; i < (int)AH_TASK_STATE_COUNT; i++) {
        CHECK(ah_task_state_is_terminal((ah_task_state)i) == task_terminal[i]);
    }
    for (i = 0; i < (int)AH_SESSION_STATE_COUNT; i++) {
        CHECK(ah_session_state_is_terminal((ah_session_state)i) == session_terminal[i]);
    }
    CHECK(!ah_task_state_is_terminal(AH_TASK_STATE_COUNT));
    CHECK(!ah_session_state_is_terminal(AH_SESSION_STATE_COUNT));
}

static void test_mode_rank(void) {
    CHECK(ah_session_mode_rank(AH_MODE_SUPERVISED) == 0);
    CHECK(ah_session_mode_rank(AH_MODE_SEMI) == 1);
    CHECK(ah_session_mode_rank(AH_MODE_AUTONOMOUS) == 2);
    CHECK(ah_session_mode_rank(AH_SESSION_MODE_COUNT) == -1);
    /* Fora do enum vale o mais restritivo (nunca afrouxa). */
    CHECK(ah_session_mode_narrowest(AH_SESSION_MODE_COUNT, AH_MODE_AUTONOMOUS) ==
          AH_MODE_SUPERVISED);
    CHECK(ah_session_mode_narrowest(AH_MODE_AUTONOMOUS, AH_SESSION_MODE_COUNT) ==
          AH_MODE_SUPERVISED);
}

typedef struct mode_ctx {
    int cases;
} mode_ctx;

static void on_policy_intersect(const ah_json *line, void *vctx) {
    mode_ctx *ctx = vctx;
    const char *kind = ah_test_json_str(line, "kind");
    const ah_json *input = ah_json_get(line, "input");
    const char *a;
    const char *b;
    const char *want;
    ah_session_mode ma = AH_SESSION_MODE_COUNT;
    ah_session_mode mb = AH_SESSION_MODE_COUNT;
    ah_session_mode got;

    /* intersect e inheritMode são da política (F2), não desta tarefa. */
    if (kind == NULL || strcmp(kind, "narrowestMode") != 0) {
        return;
    }
    a = ah_test_json_str(input, "a");
    b = ah_test_json_str(input, "b");
    want = ah_json_string(ah_json_get(line, "expect"));
    CHECK(a != NULL && b != NULL && want != NULL);
    if (a == NULL || b == NULL || want == NULL) {
        return;
    }
    CHECK(ah_session_mode_parse(a, strlen(a), &ma) == AH_OK);
    CHECK(ah_session_mode_parse(b, strlen(b), &mb) == AH_OK);
    got = ah_session_mode_narrowest(ma, mb);
    CHECK(ah_session_mode_name(got) != NULL && strcmp(ah_session_mode_name(got), want) == 0);
    ctx->cases++;
}

static void test_narrowest_corpus(void) {
    mode_ctx ctx = {0};

    ah_test_jsonl_each(corpus_policy_intersect, corpus_policy_intersect_len,
                       on_policy_intersect, &ctx);
    /* policy-intersect/0036..0045: 10 casos (os 9 pares e um repetido). */
    CHECK(ctx.cases == 10);
}

/* ---- Posse das entidades ------------------------------------------------- */

static char *dup(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = malloc(n);

    CHECK(p != NULL);
    if (p != NULL) {
        memcpy(p, s, n);
    }
    return p;
}

static char **dup_list(size_t n, const char *s) {
    char **l = calloc(n, sizeof *l);
    size_t i;

    CHECK(l != NULL);
    for (i = 0; l != NULL && i < n; i++) {
        l[i] = dup(s);
    }
    return l;
}

static void test_clear_project_and_folder(void) {
    ah_project p;
    ah_project_hub_context c;
    ah_project_folder f;

    memset(&p, 0, sizeof p);
    p.id = dup("prj_0123456789abcdef01234567");
    p.name = dup("hub");
    p.path = dup("/w/hub");
    p.default_branch = dup("main");
    p.created_at = dup("2026-10-01T00:00:00.000Z");
    p.trusted = true;
    p.trusted_hash = dup("abc");
    ah_project_clear(&p);
    CHECK(p.id == NULL && p.name == NULL && p.path == NULL && p.default_branch == NULL &&
          p.created_at == NULL && p.trusted_hash == NULL && !p.trusted);
    ah_project_clear(&p); /* idempotente */
    ah_project_clear(NULL);

    memset(&c, 0, sizeof c);
    c.memory = dup("lembrar");
    c.prompts = ah_json_new_object();
    c.env = ah_json_new_object();
    ah_project_hub_context_clear(&c);
    CHECK(c.memory == NULL && c.prompts == NULL && c.env == NULL);
    ah_project_hub_context_clear(NULL);

    memset(&f, 0, sizeof f);
    f.id = dup("pfd_prj_abc");
    f.project_id = dup("prj_abc");
    f.path = dup("/w/hub");
    f.label = NULL; /* null */
    f.is_primary = true;
    f.created_at = dup("2026-10-01T00:00:00.000Z");
    ah_project_folder_clear(&f);
    CHECK(f.id == NULL && f.project_id == NULL && f.path == NULL && f.created_at == NULL &&
          !f.is_primary);
    ah_project_folder_clear(NULL);
}

static void test_clear_session(void) {
    ah_session s;

    memset(&s, 0, sizeof s);
    s.id = dup("ses_a");
    s.project_id = dup("prj_a");
    s.agent_id = dup("claude");
    s.native_session_id = dup("n-1");
    s.root_id = dup("ses_a");
    s.parent_id = NULL;
    s.depth = 0;
    s.path = dup_list(3, "claude:280fd7e3571b7c85");
    s.path_len = 3;
    s.state = AH_SESSION_RUNNING;
    s.mode = AH_MODE_SEMI;
    s.isolation = AH_ISOLATION_WORKTREE;
    s.workdir = dup("/w/hub");
    s.title = dup("t");
    s.created_at = dup("2026-10-01T00:00:00.000Z");
    s.updated_at = dup("2026-10-01T00:00:00.000Z");
    s.ended_at = NULL;
    s.has_pid = true;
    s.pid = 4242;
    ah_session_clear(&s);
    CHECK(s.id == NULL && s.path == NULL && s.path_len == 0 && s.native_session_id == NULL &&
          s.workdir == NULL && s.title == NULL && !s.has_pid && s.pid == 0);
    ah_session_clear(&s);
    ah_session_clear(NULL);
}

static void test_clear_task(void) {
    ah_task t;
    ah_task_result *r;

    memset(&t, 0, sizeof t);
    t.id = dup("tsk_a");
    t.session_id = dup("ses_a");
    t.requester_session_id = NULL;
    t.brief = ah_json_new_object();
    t.state = AH_TASK_WORKING;
    t.attempts = calloc(2, sizeof *t.attempts);
    CHECK(t.attempts != NULL);
    if (t.attempts != NULL) {
        t.attempts_len = 2;
        t.attempts[0].n = 1;
        t.attempts[0].agent_id = dup("claude");
        t.attempts[0].started_at = dup("2026-10-01T00:00:00.000Z");
        t.attempts[0].ended_at = dup("2026-10-01T00:00:01.000Z");
        t.attempts[0].has_outcome = true;
        t.attempts[0].outcome = AH_OUTCOME_ERROR;
        t.attempts[0].error = dup("falhou");
        t.attempts[1].n = 2;
        t.attempts[1].agent_id = dup("codex");
        t.attempts[1].started_at = dup("2026-10-01T00:00:02.000Z");
    }
    r = calloc(1, sizeof *r);
    CHECK(r != NULL);
    if (r != NULL) {
        r->summary = dup("feito");
        r->artifacts = dup_list(2, "/w/a.diff");
        r->artifacts_len = 2;
        r->usage.usd = 0.5;
        r->has_validation = true;
        r->validation_passed = false;
        r->checks = calloc(2, sizeof *r->checks);
        if (r->checks != NULL) {
            r->checks_len = 2;
            r->checks[0].name = dup("testes");
            r->checks[0].passed = false;
            r->checks[0].detail = dup("1 falha");
            r->checks[1].name = dup("lint");
            r->checks[1].passed = true;
        }
    }
    t.result = r;
    t.created_at = dup("2026-10-01T00:00:00.000Z");
    t.updated_at = dup("2026-10-01T00:00:00.000Z");
    ah_task_clear(&t);
    CHECK(t.id == NULL && t.brief == NULL && t.attempts == NULL && t.attempts_len == 0 &&
          t.result == NULL && t.created_at == NULL);
    ah_task_clear(&t);
    ah_task_clear(NULL);
    ah_task_result_clear(NULL);
    ah_task_attempt_clear(NULL);
}

static void test_clear_approval_artifact_budget(void) {
    ah_approval a;
    ah_artifact art;
    ah_budget_record b;

    memset(&a, 0, sizeof a);
    a.id = dup("apv_a");
    a.session_id = dup("ses_a");
    a.task_id = dup("tsk_a");
    a.risk = AH_RISK_IRREVERSIBLE;
    a.action = dup("rm -rf build");
    a.detail = ah_json_new_object();
    a.state = AH_APPROVAL_DENIED;
    a.requested_at = dup("2026-10-01T00:00:00.000Z");
    a.resolved_at = dup("2026-10-01T00:00:01.000Z");
    a.resolved_by = dup("cli:bruno");
    ah_approval_clear(&a);
    CHECK(a.id == NULL && a.detail == NULL && a.resolved_by == NULL &&
          a.state == AH_APPROVAL_PENDING);
    ah_approval_clear(NULL);

    memset(&art, 0, sizeof art);
    art.id = dup("art_a");
    art.session_id = dup("ses_a");
    art.kind = AH_ARTIFACT_DIFF;
    art.path = dup("/home/artifacts/a.diff");
    art.created_at = dup("2026-10-01T00:00:00.000Z");
    ah_artifact_clear(&art);
    CHECK(art.id == NULL && art.path == NULL && art.hash == NULL);
    ah_artifact_clear(NULL);

    memset(&b, 0, sizeof b);
    b.root_id = dup("ses_a");
    b.limits.usd = 1;
    b.consumed.tokens = 10;
    b.reserved.seconds = 5;
    b.updated_at = dup("2026-10-01T00:00:00.000Z");
    ah_budget_record_clear(&b);
    CHECK(b.root_id == NULL && b.updated_at == NULL && b.limits.usd == 0 &&
          b.consumed.tokens == 0 && b.reserved.seconds == 0);
    ah_budget_record_clear(NULL);
}

int main(void) {
    test_enum_texts();
    test_parse_exact();
    test_terminal();
    test_mode_rank();
    test_narrowest_corpus();
    test_clear_project_and_folder();
    test_clear_session();
    test_clear_task();
    test_clear_approval_artifact_budget();
    return AH_TEST_END("test_core_domain");
}
