#include "ah_domain.h"

#include <stdlib.h>
#include <string.h>

/* Textos exatos do TS (core/src/domain.ts; RiskLevel em policy.ts:12). */
static const char *const TASK_STATE[AH_TASK_STATE_COUNT] = {
    "submitted", "working", "input_required", "auth_required",
    "completed", "failed",  "canceled",       "rejected",
};
static const char *const SESSION_STATE[AH_SESSION_STATE_COUNT] = {
    "idle", "running", "waiting_approval", "paused", "completed", "failed", "killed",
};
static const char *const SESSION_MODE[AH_SESSION_MODE_COUNT] = {
    "supervised", "semi", "autonomous",
};
static const char *const ISOLATION_MODE[AH_ISOLATION_MODE_COUNT] = {
    "none", "worktree", "container",
};
static const char *const APPROVAL_STATE[AH_APPROVAL_STATE_COUNT] = {
    "pending", "approved", "denied", "expired",
};
static const char *const ARTIFACT_KIND[AH_ARTIFACT_KIND_COUNT] = {
    "diff", "file", "report", "log", "transcript",
};
static const char *const ATTEMPT_OUTCOME[AH_ATTEMPT_OUTCOME_COUNT] = {
    "success", "error", "invalid", "timeout",
};
static const char *const RISK_LEVEL[AH_RISK_LEVEL_COUNT] = {
    "read", "write", "exec", "escalate", "irreversible", "budget",
};

static const char *name_of(const char *const *names, int count, int v) {
    if (v < 0 || v >= count) {
        return NULL;
    }
    return names[v];
}

static ah_status parse_in(const char *const *names, int count, const char *s, size_t len,
                          int *out) {
    int i;

    if (s == NULL && len != 0) {
        return AH_ERR_INVALID;
    }
    for (i = 0; i < count; i++) {
        if (strlen(names[i]) == len && (len == 0 || memcmp(names[i], s, len) == 0)) {
            *out = i;
            return AH_OK;
        }
    }
    return AH_ERR_NOT_FOUND;
}

#define AH_DEFINE_ENUM_TEXT(prefix, type, table, count)                              \
    const char *prefix##_name(type v) {                                             \
        return name_of(table, (int)(count), (int)v);                                \
    }                                                                               \
    ah_status prefix##_parse(const char *s, size_t len, type *out) {                \
        int v = 0;                                                                  \
        ah_status st;                                                               \
        if (out == NULL) {                                                          \
            return AH_ERR_INVALID;                                                  \
        }                                                                           \
        st = parse_in(table, (int)(count), s, len, &v);                             \
        if (st == AH_OK) {                                                          \
            *out = (type)v;                                                         \
        }                                                                           \
        return st;                                                                  \
    }

AH_DEFINE_ENUM_TEXT(ah_task_state, ah_task_state, TASK_STATE, AH_TASK_STATE_COUNT)
AH_DEFINE_ENUM_TEXT(ah_session_state, ah_session_state, SESSION_STATE, AH_SESSION_STATE_COUNT)
AH_DEFINE_ENUM_TEXT(ah_session_mode, ah_session_mode, SESSION_MODE, AH_SESSION_MODE_COUNT)
AH_DEFINE_ENUM_TEXT(ah_isolation_mode, ah_isolation_mode, ISOLATION_MODE, AH_ISOLATION_MODE_COUNT)
AH_DEFINE_ENUM_TEXT(ah_approval_state, ah_approval_state, APPROVAL_STATE, AH_APPROVAL_STATE_COUNT)
AH_DEFINE_ENUM_TEXT(ah_artifact_kind, ah_artifact_kind, ARTIFACT_KIND, AH_ARTIFACT_KIND_COUNT)
AH_DEFINE_ENUM_TEXT(ah_attempt_outcome, ah_attempt_outcome, ATTEMPT_OUTCOME,
                    AH_ATTEMPT_OUTCOME_COUNT)
AH_DEFINE_ENUM_TEXT(ah_risk_level, ah_risk_level, RISK_LEVEL, AH_RISK_LEVEL_COUNT)

bool ah_task_state_is_terminal(ah_task_state s) {
    /* TERMINAL_TASK_STATES (domain.ts:16-21). */
    return s == AH_TASK_COMPLETED || s == AH_TASK_FAILED || s == AH_TASK_CANCELED ||
           s == AH_TASK_REJECTED;
}

bool ah_session_state_is_terminal(ah_session_state s) {
    /* TERMINAL_SESSION_STATES (domain.ts:40). */
    return s == AH_SESSION_COMPLETED || s == AH_SESSION_FAILED || s == AH_SESSION_KILLED;
}

int ah_session_mode_rank(ah_session_mode m) {
    switch (m) {
    case AH_MODE_SUPERVISED:
        return 0;
    case AH_MODE_SEMI:
        return 1;
    case AH_MODE_AUTONOMOUS:
        return 2;
    default:
        return -1;
    }
}

ah_session_mode ah_session_mode_narrowest(ah_session_mode a, ah_session_mode b) {
    int ra = ah_session_mode_rank(a);
    int rb = ah_session_mode_rank(b);

    if (ra < 0 || rb < 0) {
        return AH_MODE_SUPERVISED;
    }
    /* MODE_RANK[a] <= MODE_RANK[b] ? a : b */
    return ra <= rb ? a : b;
}

/* ---- Liberação das entidades --------------------------------------------- */

static void free_text(char **p) {
    free(*p);
    *p = NULL;
}

static void free_text_list(char ***list, size_t *len) {
    size_t i;

    if (*list != NULL) {
        for (i = 0; i < *len; i++) {
            free((*list)[i]);
        }
    }
    free(*list);
    *list = NULL;
    *len = 0;
}

static void free_json(ah_json **p) {
    ah_json_free(*p);
    *p = NULL;
}

void ah_project_clear(ah_project *p) {
    if (p == NULL) {
        return;
    }
    free_text(&p->id);
    free_text(&p->name);
    free_text(&p->path);
    free_text(&p->default_branch);
    free_text(&p->created_at);
    free_text(&p->trusted_hash);
    p->trusted = false;
}

void ah_project_hub_context_clear(ah_project_hub_context *c) {
    if (c == NULL) {
        return;
    }
    free_text(&c->memory);
    free_json(&c->prompts);
    free_json(&c->env);
}

void ah_project_folder_clear(ah_project_folder *f) {
    if (f == NULL) {
        return;
    }
    free_text(&f->id);
    free_text(&f->project_id);
    free_text(&f->path);
    free_text(&f->label);
    free_text(&f->created_at);
    f->is_primary = false;
}

void ah_session_clear(ah_session *s) {
    if (s == NULL) {
        return;
    }
    free_text(&s->id);
    free_text(&s->project_id);
    free_text(&s->agent_id);
    free_text(&s->native_session_id);
    free_text(&s->root_id);
    free_text(&s->parent_id);
    free_text_list(&s->path, &s->path_len);
    free_text(&s->workdir);
    free_text(&s->title);
    free_text(&s->created_at);
    free_text(&s->updated_at);
    free_text(&s->ended_at);
    s->depth = 0;
    s->state = AH_SESSION_IDLE;
    s->mode = AH_MODE_SUPERVISED;
    s->isolation = AH_ISOLATION_NONE;
    s->has_pid = false;
    s->pid = 0;
}

void ah_task_attempt_clear(ah_task_attempt *a) {
    if (a == NULL) {
        return;
    }
    free_text(&a->agent_id);
    free_text(&a->started_at);
    free_text(&a->ended_at);
    free_text(&a->error);
    a->n = 0;
    a->has_outcome = false;
    a->outcome = AH_OUTCOME_SUCCESS;
}

void ah_task_result_clear(ah_task_result *r) {
    size_t i;

    if (r == NULL) {
        return;
    }
    free_text(&r->summary);
    free_text_list(&r->artifacts, &r->artifacts_len);
    if (r->checks != NULL) {
        for (i = 0; i < r->checks_len; i++) {
            free(r->checks[i].name);
            free(r->checks[i].detail);
        }
    }
    free(r->checks);
    r->checks = NULL;
    r->checks_len = 0;
    r->has_validation = false;
    r->validation_passed = false;
    memset(&r->usage, 0, sizeof r->usage);
}

void ah_task_clear(ah_task *t) {
    size_t i;

    if (t == NULL) {
        return;
    }
    free_text(&t->id);
    free_text(&t->session_id);
    free_text(&t->requester_session_id);
    free_json(&t->brief);
    if (t->attempts != NULL) {
        for (i = 0; i < t->attempts_len; i++) {
            ah_task_attempt_clear(&t->attempts[i]);
        }
    }
    free(t->attempts);
    t->attempts = NULL;
    t->attempts_len = 0;
    ah_task_result_clear(t->result);
    free(t->result);
    t->result = NULL;
    free_text(&t->created_at);
    free_text(&t->updated_at);
    t->state = AH_TASK_SUBMITTED;
}

void ah_approval_clear(ah_approval *a) {
    if (a == NULL) {
        return;
    }
    free_text(&a->id);
    free_text(&a->session_id);
    free_text(&a->task_id);
    free_text(&a->action);
    free_json(&a->detail);
    free_text(&a->requested_at);
    free_text(&a->resolved_at);
    free_text(&a->resolved_by);
    a->risk = AH_RISK_READ;
    a->state = AH_APPROVAL_PENDING;
}

void ah_artifact_clear(ah_artifact *a) {
    if (a == NULL) {
        return;
    }
    free_text(&a->id);
    free_text(&a->session_id);
    free_text(&a->task_id);
    free_text(&a->path);
    free_text(&a->hash);
    free_text(&a->created_at);
    a->kind = AH_ARTIFACT_DIFF;
}

void ah_budget_record_clear(ah_budget_record *b) {
    if (b == NULL) {
        return;
    }
    free_text(&b->root_id);
    free_text(&b->updated_at);
    memset(&b->limits, 0, sizeof b->limits);
    memset(&b->consumed, 0, sizeof b->consumed);
    memset(&b->reserved, 0, sizeof b->reserved);
}
