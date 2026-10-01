/* F1-01: ids, nowIso e objectiveHash (SPEC-04 A1; SPEC-02 §4.1).
 *
 * - objectiveHash: todos os casos de
 *   native/tests/conformance/domain/objective-hash.jsonl (gerado do TS), o
 *   exemplo executado da SPEC e vetores extras conferidos no Node 24.14.0.
 *   Teste TS equivalente: core/src/brief.test.ts (casos de objectiveHash).
 * - newId: forma `<prefixo>_<24 hex>` dos casos `newIdShape` de
 *   native/tests/conformance/domain/ids.jsonl, com a porta de UUID ligada à
 *   plataforma real (F0-06), e a derivação exata a partir do UUID. */
#include <stdlib.h>
#include <string.h>

#include "ah_ids.h"
#include "ah_platform_time.h"
#include "ah_test.h"
#include "ah_test_jsonl.h"
#include "ah_text.h"
#include "corpus_ids.h"
#include "corpus_objective_hash.h"

/* ---- Portas -------------------------------------------------------------- */

static ah_status real_uuid(void *ctx, char *out, size_t out_size) {
    (void)ctx;
    return ah_platform_uuid_v4(out, out_size);
}

static ah_status real_now(void *ctx, char *out, size_t out_size) {
    (void)ctx;
    return ah_platform_time_now_iso(out, out_size);
}

/* Porta falsa: copia o texto de ctx (ou devolve o erro em `fail`). */
typedef struct fake_port {
    const char *value;
    ah_status fail;
} fake_port;

static ah_status fake_text(void *ctx, char *out, size_t out_size) {
    const fake_port *f = ctx;
    size_t n;

    if (f->fail != AH_OK) {
        return f->fail;
    }
    n = strlen(f->value);
    if (n + 1 > out_size) {
        return AH_ERR_LIMIT;
    }
    memcpy(out, f->value, n + 1);
    return AH_OK;
}

static int hash_of(const char *s, size_t len, char out[AH_OBJECTIVE_HASH_SIZE]) {
    return ah_objective_hash(s, len, out, AH_OBJECTIVE_HASH_SIZE) == AH_OK;
}

static int hash_is(const char *s, size_t len, const char *expect) {
    char h[AH_OBJECTIVE_HASH_SIZE];

    if (!hash_of(s, len, h) || strcmp(h, expect) != 0) {
        fprintf(stderr, "  objectiveHash(\"%s\") = %s, esperado %s\n", s, h, expect);
        return 0;
    }
    return 1;
}

/* ---- objectiveHash: corpus ----------------------------------------------- */

typedef struct oh_ctx {
    int single;
    int pair;
} oh_ctx;

/* Decodifica `objective` do corpus: string, ou {"$repeat":[s, n]}. Posse: o
 * chamador libera com ah_text_free. */
static char *decode_text(const ah_json *v, size_t *len) {
    ah_text_buf b;
    const ah_json *rep;

    ah_text_buf_init(&b, 0);
    if (ah_json_type_of(v) == AH_JSON_STRING) {
        const char *s = ah_json_string(v);
        CHECK(ah_text_buf_append(&b, s, strlen(s)) == AH_OK);
    } else {
        rep = ah_json_get(v, "$repeat");
        CHECK(rep != NULL && ah_json_count(rep) == 2);
        if (rep != NULL && ah_json_count(rep) == 2) {
            const char *s = ah_json_string(ah_json_first(rep));
            double n = 0;
            int i;
            CHECK(s != NULL && ah_json_number(ah_json_next(ah_json_first(rep)), &n));
            for (i = 0; s != NULL && i < (int)n; i++) {
                CHECK(ah_text_buf_append(&b, s, strlen(s)) == AH_OK);
            }
        }
    }
    return ah_text_buf_take(&b, len);
}

static void on_objective_hash(const ah_json *line, void *vctx) {
    oh_ctx *ctx = vctx;
    const char *kind = ah_test_json_str(line, "kind");
    const char *id = ah_test_json_str(line, "id");
    const ah_json *input = ah_json_get(line, "input");
    const ah_json *expect = ah_json_get(line, "expect");

    CHECK(kind != NULL && id != NULL && input != NULL && expect != NULL);
    if (kind == NULL || input == NULL || expect == NULL) {
        return;
    }
    if (strcmp(kind, "objectiveHash") == 0) {
        size_t len = 0;
        char *s = decode_text(ah_json_get(input, "objective"), &len);
        const char *want = ah_json_string(expect);
        int ok = s != NULL && want != NULL && hash_is(s, len, want);
        if (!ok) {
            fprintf(stderr, "  caso %s\n", id);
        }
        CHECK(ok);
        ah_text_free(s);
        ctx->single++;
    } else if (strcmp(kind, "objectiveHashPair") == 0) {
        const char *a = ah_test_json_str(input, "a");
        const char *b = ah_test_json_str(input, "b");
        const char *wa = ah_json_string(ah_json_first(expect));
        const char *wb = ah_json_string(ah_json_next(ah_json_first(expect)));
        int ok = a != NULL && b != NULL && wa != NULL && wb != NULL &&
                 hash_is(a, strlen(a), wa) && hash_is(b, strlen(b), wb);
        if (!ok) {
            fprintf(stderr, "  caso %s\n", id);
        }
        CHECK(ok);
        ctx->pair++;
    } else {
        fprintf(stderr, "  kind inesperado %s em %s\n", kind, id);
        CHECK(0);
    }
}

static void test_objective_hash_corpus(void) {
    oh_ctx ctx = {0, 0};
    size_t n = ah_test_jsonl_each(corpus_objective_hash, corpus_objective_hash_len,
                                  on_objective_hash, &ctx);

    /* objective-hash.jsonl: 33 casos (README do corpus), 29 + 4 pares. */
    CHECK(n == 33);
    CHECK(ctx.single == 29);
    CHECK(ctx.pair == 4);
}

static void test_objective_hash_spec_and_extra(void) {
    /* Aceite da F1-01 (exemplo executado de SPEC-04 A1). */
    CHECK(hash_is("Fix the bug.", 12, "280fd7e3571b7c85"));
    CHECK(hash_is("  fix THE   bug ", 16, "280fd7e3571b7c85"));
    /* Extras, conferidos com o objectiveHash do TS no Node 24.14.0. */
    CHECK(hash_is("x\x0bY\x0cZ", 5, "00d9bf1235b65cc6"));              /* VT e FF são \s */
    CHECK(hash_is("\xe1\x9a\x80" "a\xe2\x80\x80" "b\xe2\x81\x9f", 11,
                  "c8687a08aa5d6ed2"));                                 /* U+1680, U+2000, U+205F */
    CHECK(hash_is("a\xe1\xa0\x8e" "b", 5, "bf2f5dd9f20acb42"));         /* U+180E não é \s */
    CHECK(hash_is("\xce\x9f\xce\x94\xce\x9f\xce\xa3.", 9,
                  "3a2c9e1f2803431e")); /* ς decidido antes de sair o ponto */
    CHECK(hash_is("a ) ]", 5, "ca978112ca1bbdca"));
    CHECK(hash_is("a\xc2\xa0.\xe3\x80\x80", 7, "ca978112ca1bbdca"));
    /* Vazio = SHA-256 de "" (e3b0c442...). */
    CHECK(hash_is(NULL, 0, "e3b0c44298fc1c14"));
    /* NUL no meio é U+0000, um caractere comum: entra no hash. */
    {
        char h1[AH_OBJECTIVE_HASH_SIZE];
        char h2[AH_OBJECTIVE_HASH_SIZE];
        CHECK(hash_of("a\0b", 3, h1));
        CHECK(hash_of("ab", 2, h2));
        CHECK(strcmp(h1, h2) != 0);
    }
}

static void test_objective_hash_errors(void) {
    char h[AH_OBJECTIVE_HASH_SIZE];

    memcpy(h, "xxxxxxxxxxxxxxxx", AH_OBJECTIVE_HASH_SIZE);
    CHECK(ah_objective_hash("a\xff", 2, h, sizeof h) == AH_ERR_INVALID);
    CHECK(h[0] == '\0');
    CHECK(ah_objective_hash("abc", 3, h, AH_OBJECTIVE_HASH_SIZE - 1) == AH_ERR_LIMIT);
    CHECK(ah_objective_hash(NULL, 1, h, sizeof h) == AH_ERR_INVALID);
    CHECK(ah_objective_hash("abc", 3, NULL, 0) == AH_ERR_INVALID);
}

/* ---- newId --------------------------------------------------------------- */

static int id_shape(const char *id, const char *prefix) {
    size_t i;

    if (strlen(id) != 28 || memcmp(id, prefix, 3) != 0 || id[3] != '_') {
        return 0;
    }
    for (i = 4; i < 28; i++) {
        char c = id[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return 0;
        }
    }
    return 1;
}

typedef struct shape_ctx {
    int count;
} shape_ctx;

static void on_ids(const ah_json *line, void *vctx) {
    shape_ctx *ctx = vctx;
    const char *kind = ah_test_json_str(line, "kind");
    const ah_json *input = ah_json_get(line, "input");
    const ah_json *expect = ah_json_get(line, "expect");
    const ah_id_uuid_port port = {real_uuid, NULL};
    const char *prefix;
    const char *pattern;
    double samples = 0;
    double length = 0;
    bool all = false;
    char want_pattern[64];
    ah_id_prefix p;
    int i;

    /* daemonRouteId e clientIsHubId são da borda HTTP e do cliente
     * (F1-15, F1-20), não desta tarefa. */
    if (kind == NULL || strcmp(kind, "newIdShape") != 0) {
        return;
    }
    prefix = ah_test_json_str(input, "prefix");
    pattern = ah_test_json_str(expect, "pattern");
    CHECK(prefix != NULL && pattern != NULL);
    CHECK(ah_json_number(ah_json_get(input, "samples"), &samples));
    CHECK(ah_json_number(ah_json_get(expect, "length"), &length));
    CHECK(ah_json_bool(ah_json_get(expect, "allMatch"), &all) && all);
    if (prefix == NULL || pattern == NULL) {
        return;
    }
    /* O corpus registra os prefixos na ordem de ids.ts:7, a mesma do enum. */
    p = (ah_id_prefix)ctx->count;
    CHECK(ah_id_prefix_name(p) != NULL && strcmp(ah_id_prefix_name(p), prefix) == 0);
    /* A regra checada aqui é exatamente a do corpus. */
    snprintf(want_pattern, sizeof want_pattern, "^%s_[0-9a-f]{24}$", prefix);
    CHECK(strcmp(pattern, want_pattern) == 0);
    CHECK(length == 28);
    for (i = 0; i < (int)samples; i++) {
        char id[AH_ID_SIZE];
        CHECK(ah_id_new(&port, p, id, sizeof id) == AH_OK);
        CHECK(id_shape(id, prefix));
        CHECK(strlen(id) == (size_t)length);
    }
    ctx->count++;
}

static void test_new_id_corpus(void) {
    shape_ctx ctx = {0};

    ah_test_jsonl_each(corpus_ids, corpus_ids_len, on_ids, &ctx);
    CHECK(ctx.count == 9);
    CHECK(ctx.count == (int)AH_ID_PREFIX_COUNT);
}

static void test_new_id_derivation(void) {
    fake_port f = {"0123abcd-ef01-4567-89ab-cdef01234567", AH_OK};
    ah_id_uuid_port port = {fake_text, &f};
    char id[AH_ID_SIZE];
    char a[AH_ID_SIZE];
    char b[AH_ID_SIZE];
    const ah_id_uuid_port real = {real_uuid, NULL};

    /* replaceAll('-', '').slice(0, 24) */
    CHECK(ah_id_new(&port, AH_ID_SES, id, sizeof id) == AH_OK);
    CHECK(strcmp(id, "ses_0123abcdef01456789abcdef") == 0);
    CHECK(ah_id_new(&port, AH_ID_AUD, id, sizeof id) == AH_OK);
    CHECK(strcmp(id, "aud_0123abcdef01456789abcdef") == 0);

    /* Dois ids reais seguidos diferem (CSPRNG da plataforma). */
    CHECK(ah_id_new(&real, AH_ID_EVT, a, sizeof a) == AH_OK);
    CHECK(ah_id_new(&real, AH_ID_EVT, b, sizeof b) == AH_OK);
    CHECK(strcmp(a, b) != 0);

    /* Erros: argumentos, teto, erro da porta repassado e porta fora do
     * formato de UUID v4. */
    CHECK(ah_id_new(&port, AH_ID_PREFIX_COUNT, id, sizeof id) == AH_ERR_INVALID);
    CHECK(ah_id_new(NULL, AH_ID_SES, id, sizeof id) == AH_ERR_INVALID);
    CHECK(ah_id_new(&port, AH_ID_SES, id, AH_ID_SIZE - 1) == AH_ERR_LIMIT);
    CHECK(id[0] == '\0');
    f.fail = AH_ERR_IO;
    CHECK(ah_id_new(&port, AH_ID_SES, id, sizeof id) == AH_ERR_IO);
    CHECK(id[0] == '\0');
    f.fail = AH_OK;
    f.value = "0123ABCD-ef01-4567-89ab-cdef01234567"; /* maiúscula */
    CHECK(ah_id_new(&port, AH_ID_SES, id, sizeof id) == AH_ERR_INTERNAL);
    f.value = "0123abcd-ef01-1567-89ab-cdef01234567"; /* versão 1 */
    CHECK(ah_id_new(&port, AH_ID_SES, id, sizeof id) == AH_ERR_INTERNAL);
    f.value = "0123abcd-ef01-4567-c9ab-cdef01234567"; /* variante errada */
    CHECK(ah_id_new(&port, AH_ID_SES, id, sizeof id) == AH_ERR_INTERNAL);
    f.value = "0123abcdef01456789abcdef01234567"; /* sem hífens */
    CHECK(ah_id_new(&port, AH_ID_SES, id, sizeof id) == AH_ERR_INTERNAL);
    CHECK(id[0] == '\0');
}

static void test_prefix_names(void) {
    static const char *const want[] = {"prj", "pfd", "ses", "tsk", "evt",
                                       "apv", "art", "run", "aud"};
    int i;

    for (i = 0; i < (int)AH_ID_PREFIX_COUNT; i++) {
        CHECK(strcmp(ah_id_prefix_name((ah_id_prefix)i), want[i]) == 0);
    }
    CHECK(ah_id_prefix_name(AH_ID_PREFIX_COUNT) == NULL);
}

/* ---- nowIso -------------------------------------------------------------- */

static void test_now_iso(void) {
    const ah_clock_port real = {real_now, NULL};
    fake_port f = {"2026-10-01T12:34:56.789Z", AH_OK};
    ah_clock_port port = {fake_text, &f};
    char t[AH_ISO_TIME_SIZE];

    CHECK(AH_ISO_TIME_SIZE == AH_PLATFORM_ISO_TIME_SIZE);
    CHECK(ah_now_iso(&real, t, sizeof t) == AH_OK);
    CHECK(strlen(t) == 24 && t[10] == 'T' && t[23] == 'Z');

    CHECK(ah_now_iso(&port, t, sizeof t) == AH_OK);
    CHECK(strcmp(t, "2026-10-01T12:34:56.789Z") == 0);

    CHECK(ah_now_iso(&port, t, AH_ISO_TIME_SIZE - 1) == AH_ERR_LIMIT);
    CHECK(ah_now_iso(NULL, t, sizeof t) == AH_ERR_INVALID);
    f.value = "2026-10-01T12:34:56Z"; /* sem milissegundos */
    CHECK(ah_now_iso(&port, t, sizeof t) == AH_ERR_INTERNAL);
    CHECK(t[0] == '\0');
    f.value = "2026-10-01 12:34:56.789Z";
    CHECK(ah_now_iso(&port, t, sizeof t) == AH_ERR_INTERNAL);
    f.value = "2026-10-01T12:34:56.789z";
    CHECK(ah_now_iso(&port, t, sizeof t) == AH_ERR_INTERNAL);
    f.value = "2026-10-01T12:34:56.78xZ";
    CHECK(ah_now_iso(&port, t, sizeof t) == AH_ERR_INTERNAL);
    /* Texto maior que o buffer: o erro da porta é repassado. */
    f.value = "2026-10-01T12:34:56.789+00:00";
    CHECK(ah_now_iso(&port, t, sizeof t) == AH_ERR_LIMIT);
    f.fail = AH_ERR_IO;
    CHECK(ah_now_iso(&port, t, sizeof t) == AH_ERR_IO);
}

int main(void) {
    test_objective_hash_corpus();
    test_objective_hash_spec_and_extra();
    test_objective_hash_errors();
    test_prefix_names();
    test_new_id_corpus();
    test_new_id_derivation();
    test_now_iso();
    return AH_TEST_END("test_core_ids");
}
