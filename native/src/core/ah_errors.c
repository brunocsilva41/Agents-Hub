#include "ah_errors.h"

#include <stdlib.h>
#include <string.h>

static const char *const CODE_NAMES[AH_ERROR_CODE_COUNT] = {
    "AGENT_NOT_FOUND",
    "AGENT_NOT_INSTALLED",
    "AGENT_NOT_AUTHENTICATED",
    "SESSION_NOT_FOUND",
    "TASK_NOT_FOUND",
    "PROJECT_NOT_FOUND",
    "PROJECT_FOLDER_CONFLICT",
    "PROJECT_CONFIG_INVALID",
    "HUB_CONFIG_INVALID",
    "AGENT_CONFIG_INVALID",
    "CONFIG_CHANGED",
    "FOLDER_NOT_FOUND",
    "APPROVAL_NOT_FOUND",
    "FOLDER_IS_PRIMARY",
    "INVALID_BRIEF",
    "INVALID_QUERY",
    "INVALID_ID",
    "INVALID_JSON",
    "INVALID_PATH",
    "MALFORMED_URL",
    "PAYLOAD_TOO_LARGE",
    "POLICY_DENIED",
    "APPROVAL_REQUIRED",
    "BUDGET_EXCEEDED",
    "DEPTH_EXCEEDED",
    "CYCLE_DETECTED",
    "CONCURRENCY_EXCEEDED",
    "TIMEOUT",
    "ADAPTER_FAILURE",
    "CAPABILITY_UNRESOLVED",
    "ILLEGAL_STATE",
    "CODEX_GATE_NOT_GUARANTEED",
};

/* SPEC-04 A1: "HubErrorCode tem 32 códigos". */
_Static_assert(AH_ERROR_CODE_COUNT == 32, "HubErrorCode tem 32 códigos (core/src/errors.ts)");

const char *ah_error_code_name(ah_error_code code) {
    if ((unsigned)code >= (unsigned)AH_ERROR_CODE_COUNT) {
        return NULL;
    }
    return CODE_NAMES[code];
}

ah_status ah_error_code_parse(const char *s, size_t len, ah_error_code *out) {
    int i;

    if (out == NULL || (s == NULL && len != 0)) {
        return AH_ERR_INVALID;
    }
    for (i = 0; i < (int)AH_ERROR_CODE_COUNT; i++) {
        const char *name = CODE_NAMES[i];
        if (strlen(name) == len && (len == 0 || memcmp(name, s, len) == 0)) {
            *out = (ah_error_code)i;
            return AH_OK;
        }
    }
    return AH_ERR_NOT_FOUND;
}

static char *dup_text(const char *s) {
    size_t n = strlen(s);
    char *p = malloc(n + 1);

    if (p != NULL) {
        memcpy(p, s, n + 1);
    }
    return p;
}

ah_status ah_hub_error_new(ah_error_code code, const char *message, ah_json *details,
                           ah_hub_error **out) {
    ah_hub_error *err;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (ah_error_code_name(code) == NULL || message == NULL ||
        (details != NULL && ah_json_type_of(details) != AH_JSON_OBJECT)) {
        return AH_ERR_INVALID;
    }
    err = calloc(1, sizeof *err);
    if (err == NULL) {
        return AH_ERR_NOMEM;
    }
    err->code = code;
    err->message = dup_text(message);
    err->details = details != NULL ? details : ah_json_new_object();
    if (err->message == NULL || err->details == NULL) {
        /* `details` do chamador continua dele em erro. */
        if (details == NULL) {
            ah_json_free(err->details);
        }
        free(err->message);
        free(err);
        return AH_ERR_NOMEM;
    }
    *out = err;
    return AH_OK;
}

void ah_hub_error_free(ah_hub_error *err) {
    if (err == NULL) {
        return;
    }
    free(err->message);
    ah_json_free(err->details);
    free(err);
}

ah_status ah_hub_error_to_json(const ah_hub_error *err, ah_json **out) {
    ah_json *obj;
    ah_json *v;
    ah_status st;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (err == NULL || ah_error_code_name(err->code) == NULL || err->message == NULL ||
        err->details == NULL) {
        return AH_ERR_INVALID;
    }
    obj = ah_json_new_object();
    if (obj == NULL) {
        return AH_ERR_NOMEM;
    }
    v = ah_json_new_string(ah_error_code_name(err->code));
    st = v != NULL ? ah_json_set(obj, "code", v) : AH_ERR_NOMEM;
    if (st == AH_OK) {
        v = ah_json_new_string(err->message);
        st = v != NULL ? ah_json_set(obj, "message", v) : AH_ERR_NOMEM;
    }
    if (st == AH_OK) {
        v = ah_json_duplicate(err->details);
        st = v != NULL ? ah_json_set(obj, "details", v) : AH_ERR_NOMEM;
    }
    if (st != AH_OK) {
        ah_json_free(v);
        ah_json_free(obj);
        return st;
    }
    *out = obj;
    return AH_OK;
}
