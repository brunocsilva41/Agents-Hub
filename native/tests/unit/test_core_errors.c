/* F1-01: HubErrorCode (os 32 códigos de core/src/errors.ts:6-42, SPEC-04 A1)
 * e HubError ({code, message, details}, errors.ts:44-58).
 *
 * Também confere que todo `expected_code` do corpus
 * native/tests/conformance/domain-errors/route-errors.jsonl (gerado do TS,
 * F4-14) é um código conhecido com o mesmo texto. Esse corpus fixa código e
 * status por rota; não fixa texto de mensagem (nenhuma linha tem `message`). */
#include <string.h>

#include "ah_errors.h"
#include "ah_test.h"
#include "ah_test_jsonl.h"
#include "ah_text.h"
#include "corpus_route_errors.h"

/* Literais de HubErrorCode na ordem de core/src/errors.ts:6-42. */
static const char *const TS_CODES[] = {
    "AGENT_NOT_FOUND",         "AGENT_NOT_INSTALLED",   "AGENT_NOT_AUTHENTICATED",
    "SESSION_NOT_FOUND",       "TASK_NOT_FOUND",        "PROJECT_NOT_FOUND",
    "PROJECT_FOLDER_CONFLICT", "PROJECT_CONFIG_INVALID", "HUB_CONFIG_INVALID",
    "AGENT_CONFIG_INVALID",    "CONFIG_CHANGED",        "FOLDER_NOT_FOUND",
    "APPROVAL_NOT_FOUND",      "FOLDER_IS_PRIMARY",     "INVALID_BRIEF",
    "INVALID_QUERY",           "INVALID_ID",            "INVALID_JSON",
    "INVALID_PATH",            "MALFORMED_URL",         "PAYLOAD_TOO_LARGE",
    "POLICY_DENIED",           "APPROVAL_REQUIRED",     "BUDGET_EXCEEDED",
    "DEPTH_EXCEEDED",          "CYCLE_DETECTED",        "CONCURRENCY_EXCEEDED",
    "TIMEOUT",                 "ADAPTER_FAILURE",       "CAPABILITY_UNRESOLVED",
    "ILLEGAL_STATE",           "CODEX_GATE_NOT_GUARANTEED",
};

static void test_codes(void) {
    size_t n = sizeof TS_CODES / sizeof TS_CODES[0];
    size_t i;

    CHECK(n == 32);
    CHECK((size_t)AH_ERROR_CODE_COUNT == 32);
    for (i = 0; i < n; i++) {
        ah_error_code c = AH_ERROR_CODE_COUNT;
        const char *name = ah_error_code_name((ah_error_code)i);
        CHECK(name != NULL && strcmp(name, TS_CODES[i]) == 0);
        CHECK(ah_error_code_parse(TS_CODES[i], strlen(TS_CODES[i]), &c) == AH_OK);
        CHECK(c == (ah_error_code)i);
    }
    /* Pontos citados na SPEC-04 A1. */
    CHECK(strcmp(ah_error_code_name(AH_ERROR_INVALID_BRIEF), "INVALID_BRIEF") == 0);
    CHECK(strcmp(ah_error_code_name(AH_ERROR_CODEX_GATE_NOT_GUARANTEED),
                 "CODEX_GATE_NOT_GUARANTEED") == 0);
    CHECK(ah_error_code_name(AH_ERROR_CODE_COUNT) == NULL);
    CHECK(ah_error_code_name((ah_error_code)-1) == NULL);
}

static void test_parse_rejects(void) {
    ah_error_code c = AH_ERROR_TIMEOUT;

    CHECK(ah_error_code_parse("timeout", 7, &c) == AH_ERR_NOT_FOUND);  /* sensível a caixa */
    CHECK(ah_error_code_parse("TIMEOU", 6, &c) == AH_ERR_NOT_FOUND);   /* prefixo */
    CHECK(ah_error_code_parse("TIMEOUTS", 8, &c) == AH_ERR_NOT_FOUND); /* sufixo */
    CHECK(ah_error_code_parse("TIMEOUT ", 8, &c) == AH_ERR_NOT_FOUND);
    CHECK(ah_error_code_parse("", 0, &c) == AH_ERR_NOT_FOUND);
    CHECK(ah_error_code_parse("NOT_FOUND", 9, &c) == AH_ERR_NOT_FOUND);
    CHECK(c == AH_ERROR_TIMEOUT); /* intacto */
    CHECK(ah_error_code_parse(NULL, 1, &c) == AH_ERR_INVALID);
    CHECK(ah_error_code_parse("TIMEOUT", 7, NULL) == AH_ERR_INVALID);
    /* Tamanho explícito: o texto não precisa terminar em NUL. */
    CHECK(ah_error_code_parse("TIMEOUTxyz", 7, &c) == AH_OK && c == AH_ERROR_TIMEOUT);
}

typedef struct route_ctx {
    int lines;
    int seen[AH_ERROR_CODE_COUNT];
} route_ctx;

static void on_route_error(const ah_json *line, void *vctx) {
    route_ctx *ctx = vctx;
    const char *code = ah_test_json_str(line, "expected_code");
    ah_error_code c = AH_ERROR_CODE_COUNT;

    ctx->lines++;
    CHECK(code != NULL);
    if (code == NULL) {
        return;
    }
    CHECK(ah_error_code_parse(code, strlen(code), &c) == AH_OK);
    if (c < AH_ERROR_CODE_COUNT) {
        CHECK(strcmp(ah_error_code_name(c), code) == 0);
        ctx->seen[c]++;
    } else {
        fprintf(stderr, "  código desconhecido no corpus: %s\n", code);
    }
    /* O corpus não fixa mensagem; se passar a fixar, este teste precisa
     * conferir o texto (aceite da F1-01). */
    CHECK(ah_json_get(line, "message") == NULL);
    CHECK(ah_json_get(line, "expected_message") == NULL);
}

static void test_route_errors_corpus(void) {
    route_ctx ctx;
    int distinct = 0;
    int i;

    memset(&ctx, 0, sizeof ctx);
    ah_test_jsonl_each(corpus_route_errors, corpus_route_errors_len, on_route_error, &ctx);
    /* README de domain-errors: 147 casos. */
    CHECK(ctx.lines == 147);
    for (i = 0; i < (int)AH_ERROR_CODE_COUNT; i++) {
        distinct += ctx.seen[i] != 0;
    }
    CHECK(distinct == 25);
    /* Códigos que nenhuma rota lança (README de domain-errors). */
    CHECK(ctx.seen[AH_ERROR_AGENT_NOT_AUTHENTICATED] == 0);
    CHECK(ctx.seen[AH_ERROR_APPROVAL_REQUIRED] == 0);
    CHECK(ctx.seen[AH_ERROR_ILLEGAL_STATE] == 35);
}

static int json_text_is(const ah_json *v, const char *expect) {
    char *s = NULL;
    int ok = ah_json_stringify(v, &s, NULL) == AH_OK && strcmp(s, expect) == 0;

    if (!ok) {
        fprintf(stderr, "  JSON %s != %s\n", s ? s : "(nulo)", expect);
    }
    ah_text_free(s);
    return ok;
}

static void test_hub_error(void) {
    ah_hub_error *e = NULL;
    ah_json *j = NULL;
    ah_json *details;

    /* Sem detalhes: `details` = {} (errors.ts:48). */
    CHECK(ah_hub_error_new(AH_ERROR_POLICY_DENIED, "negado pela política", NULL, &e) == AH_OK);
    CHECK(e != NULL && e->code == AH_ERROR_POLICY_DENIED);
    CHECK(strcmp(e->message, "negado pela política") == 0);
    CHECK(ah_json_type_of(e->details) == AH_JSON_OBJECT && ah_json_count(e->details) == 0);
    CHECK(ah_hub_error_to_json(e, &j) == AH_OK);
    CHECK(json_text_is(j, "{\"code\":\"POLICY_DENIED\",\"message\":\"negado pela "
                          "política\",\"details\":{}}"));
    ah_json_free(j);
    ah_hub_error_free(e);

    /* Com detalhes: posse passa ao erro; toJSON copia. */
    details = ah_json_new_object();
    CHECK(details != NULL);
    CHECK(ah_json_set(details, "issues", ah_json_new_array()) == AH_OK);
    CHECK(ah_hub_error_new(AH_ERROR_INVALID_BRIEF, "Brief inválido", details, &e) == AH_OK);
    CHECK(e->details == details);
    CHECK(ah_hub_error_to_json(e, &j) == AH_OK);
    CHECK(json_text_is(j, "{\"code\":\"INVALID_BRIEF\",\"message\":\"Brief inválido\","
                          "\"details\":{\"issues\":[]}}"));
    ah_hub_error_free(e);
    /* A cópia sobrevive ao erro. */
    CHECK(json_text_is(j, "{\"code\":\"INVALID_BRIEF\",\"message\":\"Brief inválido\","
                          "\"details\":{\"issues\":[]}}"));
    ah_json_free(j);

    /* Mensagem vazia é válida; escapes de JSON.stringify. */
    CHECK(ah_hub_error_new(AH_ERROR_TIMEOUT, "", NULL, &e) == AH_OK);
    CHECK(ah_hub_error_to_json(e, &j) == AH_OK);
    CHECK(json_text_is(j, "{\"code\":\"TIMEOUT\",\"message\":\"\",\"details\":{}}"));
    ah_json_free(j);
    ah_hub_error_free(e);

    /* Recusas: código fora do enum, mensagem NULL, details que não é
     * objeto (continua do chamador). */
    static ah_hub_error lixo;
    e = &lixo; /* valor anterior qualquer: precisa virar NULL */
    CHECK(ah_hub_error_new(AH_ERROR_CODE_COUNT, "x", NULL, &e) == AH_ERR_INVALID);
    CHECK(e == NULL);
    CHECK(ah_hub_error_new(AH_ERROR_TIMEOUT, NULL, NULL, &e) == AH_ERR_INVALID);
    details = ah_json_new_array();
    CHECK(ah_hub_error_new(AH_ERROR_TIMEOUT, "x", details, &e) == AH_ERR_INVALID);
    CHECK(e == NULL);
    ah_json_free(details);
    CHECK(ah_hub_error_new(AH_ERROR_TIMEOUT, "x", NULL, NULL) == AH_ERR_INVALID);
    CHECK(ah_hub_error_to_json(NULL, &j) == AH_ERR_INVALID && j == NULL);
    ah_hub_error_free(NULL);
}

int main(void) {
    test_codes();
    test_parse_rejects();
    test_route_errors_corpus();
    test_hub_error();
    return AH_TEST_END("test_core_errors");
}
