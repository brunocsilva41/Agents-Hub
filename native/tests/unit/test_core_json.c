/* F0-10: JSON compatível com JSON.parse/JSON.stringify (SPEC-02 §4.1).
 *
 * Os esperados foram gerados com o Node v24 rodando JSON.stringify sobre os
 * mesmos valores (script de referência descrito no relatório da F0-10), por
 * exemplo:
 *   JSON.stringify({b:1,'2':2,a:3,'1':4,'4294967295':5,'4294967294':7,'01':6,'-1':8})
 *   -> {"1":4,"2":2,"4294967294":7,"b":1,"a":3,"4294967295":5,"01":6,"-1":8}
 */
#include <stdlib.h>
#include <string.h>

#include <math.h>

#include "ah_json.h"
#include "ah_test.h"
#include "ah_text.h"
#include "json_pow2_expected.h"

#define LIT(s) (s), (sizeof(s) - 1)

/* Confere ah_json_stringify(v) == expected e libera v. */
static void check_stringify(ah_json *v, const char *expected) {
    char *s = NULL;
    size_t n = 0;
    CHECK(ah_json_stringify(v, &s, &n) == AH_OK);
    CHECK(s != NULL && strcmp(s, expected) == 0 && n == strlen(expected));
    if (s == NULL || strcmp(s, expected) != 0) {
        fprintf(stderr, "  esperado: %s\n  obtido:   %s\n", expected, s != NULL ? s : "(nulo)");
    }
    ah_text_free(s);
    ah_json_free(v);
}

static void test_key_order(void) {
    ah_json *o = ah_json_new_object();
    CHECK(ah_json_set(o, "b", ah_json_new_number(1)) == AH_OK);
    CHECK(ah_json_set(o, "2", ah_json_new_number(2)) == AH_OK);
    CHECK(ah_json_set(o, "a", ah_json_new_number(3)) == AH_OK);
    CHECK(ah_json_set(o, "1", ah_json_new_number(4)) == AH_OK);
    CHECK(ah_json_set(o, "4294967295", ah_json_new_number(5)) == AH_OK);
    CHECK(ah_json_set(o, "4294967294", ah_json_new_number(7)) == AH_OK);
    CHECK(ah_json_set(o, "01", ah_json_new_number(6)) == AH_OK);
    CHECK(ah_json_set(o, "-1", ah_json_new_number(8)) == AH_OK);
    check_stringify(o, "{\"1\":4,\"2\":2,\"4294967294\":7,\"b\":1,\"a\":3,\"4294967295\":5,"
                       "\"01\":6,\"-1\":8}");
}

static void test_strings(void) {
    /* JSON.stringify(['\u2028\u2029', '\u0001\u001f\u007f\b\f\n\r\t"\\/', 'é😀']) */
    ah_json *a = ah_json_new_array();
    CHECK(ah_json_push(a, ah_json_new_string("\xE2\x80\xA8\xE2\x80\xA9")) == AH_OK);
    CHECK(ah_json_push(a, ah_json_new_string("\x01\x1F\x7F\b\f\n\r\t\"\\/")) == AH_OK);
    CHECK(ah_json_push(a, ah_json_new_string("\xC3\xA9\xF0\x9F\x98\x80")) == AH_OK);
    check_stringify(a, "[\"\xE2\x80\xA8\xE2\x80\xA9\",\"\\u0001\\u001f\x7F\\b\\f\\n\\r\\t\\\"\\\\/\","
                       "\"\xC3\xA9\xF0\x9F\x98\x80\"]");

    /* Bytes inválidos viram U+FFFD (Buffer.toString('utf8') do Node). */
    check_stringify(ah_json_new_string("a\xFF" "b"), "\"a\xEF\xBF\xBD" "b\"");
}

static void test_numbers(void) {
    static const double v[] = {5, -0.0, 0.1, 1e21, 1e-7, 123456789012345680000.0, 1.5e-7,
                               0.000001, 9007199254740992.0, -1.25e300, 1.0 / 3.0, 100, 1e20,
                               5e-324, 1.7976931348623157e308, 0.1 + 0.2, 123.456, -42};
    ah_json *a = ah_json_new_array();
    size_t i;

    for (i = 0; i < sizeof v / sizeof v[0]; i++) {
        CHECK(ah_json_push(a, ah_json_new_number(v[i])) == AH_OK);
    }
    /* NaN e Infinity em tempo de execução, sem aritmética constante com zero. */
    CHECK(ah_json_push(a, ah_json_new_number(strtod("nan", NULL))) == AH_OK);
    CHECK(ah_json_push(a, ah_json_new_number(strtod("inf", NULL))) == AH_OK);
    check_stringify(a, "[5,0,0.1,1e+21,1e-7,123456789012345680000,1.5e-7,0.000001,"
                       "9007199254740992,-1.25e+300,0.3333333333333333,100,"
                       "100000000000000000000,5e-324,1.7976931348623157e+308,"
                       "0.30000000000000004,123.456,-42,null,null]");
}

/* Todas as potências de 2 representáveis em double, de 2^-1074 a 2^1023,
 * contra JSON.stringify do Node (json_pow2_expected.h, gerado com node -e).
 * Nelas o intervalo de arredondamento é assimétrico: o decimal mais próximo
 * nem sempre faz ida e volta e o vizinho de cima faz. */
static void test_powers_of_two(void) {
    int e;
    int failures = 0;
    for (e = AH_POW2_MIN_EXP; e <= AH_POW2_MAX_EXP; e++) {
        ah_json *v = ah_json_new_number(ldexp(1.0, e));
        char *s = NULL;
        const char *exp = ah_pow2_js[e - AH_POW2_MIN_EXP];
        CHECK(v != NULL && ah_json_stringify(v, &s, NULL) == AH_OK);
        if (s == NULL || strcmp(s, exp) != 0) {
            if (failures++ < 10) {
                fprintf(stderr, "  2^%d: esperado %s, obtido %s\n", e, exp, s != NULL ? s : "(nulo)");
            }
        }
        ah_text_free(s);
        ah_json_free(v);
    }
    CHECK(failures == 0);
    CHECK(sizeof ah_pow2_js / sizeof ah_pow2_js[0] ==
          (size_t)(AH_POW2_MAX_EXP - AH_POW2_MIN_EXP + 1));
}

static void test_nested_and_null(void) {
    ah_json *o = ah_json_new_object();
    ah_json *arr = ah_json_new_array();
    ah_json *inner = ah_json_new_object();
    CHECK(ah_json_set(inner, "b", ah_json_new_null()) == AH_OK);
    CHECK(ah_json_set(inner, "c", ah_json_new_bool(true)) == AH_OK);
    CHECK(ah_json_set(inner, "d", ah_json_new_bool(false)) == AH_OK);
    CHECK(ah_json_push(arr, ah_json_new_number(1)) == AH_OK);
    CHECK(ah_json_push(arr, inner) == AH_OK);
    CHECK(ah_json_set(o, "a", arr) == AH_OK);
    CHECK(ah_json_set(o, "e", ah_json_new_object()) == AH_OK);
    CHECK(ah_json_set(o, "f", ah_json_new_array()) == AH_OK);
    check_stringify(o, "{\"a\":[1,{\"b\":null,\"c\":true,\"d\":false}],\"e\":{},\"f\":[]}");

    /* toJson(value ?? null) */
    check_stringify(NULL, "null");
}

static void test_set_replaces_in_place(void) {
    ah_json *o = ah_json_new_object();
    const ah_json *it;
    double d = 0;
    CHECK(ah_json_set(o, "x", ah_json_new_number(1)) == AH_OK);
    CHECK(ah_json_set(o, "y", ah_json_new_number(2)) == AH_OK);
    CHECK(ah_json_set(o, "x", ah_json_new_string("novo")) == AH_OK);
    CHECK(ah_json_count(o) == 2);
    it = ah_json_first(o);
    CHECK(it != NULL && strcmp(ah_json_key(it), "x") == 0);
    CHECK(it != NULL && strcmp(ah_json_string(it), "novo") == 0);
    it = ah_json_next(it);
    CHECK(it != NULL && strcmp(ah_json_key(it), "y") == 0 && ah_json_number(it, &d) && d == 2);
    CHECK(ah_json_next(it) == NULL);
    check_stringify(o, "{\"x\":\"novo\",\"y\":2}");
}

typedef struct parse_case {
    const char *in;
    const char *out; /* NULL = JSON.parse lança */
} parse_case;

static void test_parse_grammar(void) {
    /* Veredito do JSON.parse do Node para cada entrada (ok + re-stringify, ou erro). */
    static const parse_case cases[] = {
        {"", NULL},
        {" ", NULL},
        {"null", "null"},
        {"[1] x", NULL},
        {"01", NULL},
        {"+1", NULL},
        {".5", NULL},
        {"1.", NULL},
        {"{\"a\":1,}", NULL},
        {"[1,]", NULL},
        {"\xC2\xA0[]", NULL}, /* NBSP não é espaço JSON */
        {" \t\n\r[]\r\n", "[]"},
        {"\"\x01\"", NULL},
        {"{\"a\"}", NULL},
        {"tru", NULL},
        {"1e5", "100000"},
        {"-0", "0"},
        {"\"\\x\"", NULL},
        {"[[[]]]", "[[[]]]"},
        {"{\"a\":1,\"b\":2,\"a\":3}", "{\"a\":3,\"b\":2}"}, /* chave repetida */
        {"\"\\ud83d\\ude00\"", "\"\xF0\x9F\x98\x80\""},      /* par de surrogates */
        {"{\"b\":1,\"2\":2}", "{\"2\":2,\"b\":1}"},
        {"\"\\u00e9\\/\"", "\"\xC3\xA9/\""},
        {"[1e400]", "[null]"}, /* JSON.parse -> Infinity -> null */
        {"\xEF\xBB\xBF{}", NULL}, /* BOM não é espaço JSON */
    };
    size_t i;

    for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        ah_json *v = NULL;
        ah_status st = ah_json_parse(cases[i].in, strlen(cases[i].in), &v);
        if (cases[i].out == NULL) {
            CHECK(st == AH_ERR_INVALID && v == NULL);
            if (st != AH_ERR_INVALID) {
                fprintf(stderr, "  caso %zu (%s) deveria ser inválido\n", i, cases[i].in);
            }
        } else {
            CHECK(st == AH_OK && v != NULL);
            if (st == AH_OK) {
                check_stringify(v, cases[i].out);
            } else {
                fprintf(stderr, "  caso %zu (%s) deveria ser válido\n", i, cases[i].in);
            }
        }
    }
}

static void test_parse_limitations(void) {
    ah_json *v = NULL;
    ah_json *fb = ah_json_new_object();

    /* "\u0000": JSON válido que o cJSON não guarda -> AH_ERR_LIMIT, distinto
     * de inválido; parse_or repassa o erro e não aplica o padrão. */
    CHECK(ah_json_parse(LIT("\"a\\u0000b\""), &v) == AH_ERR_LIMIT && v == NULL);
    CHECK(ah_json_parse(LIT("{\"k\\u0000\":1}"), &v) == AH_ERR_LIMIT && v == NULL);
    v = fb;
    CHECK(ah_json_parse_or(LIT("[\"\\u0000\"]"), fb, &v) == AH_ERR_LIMIT && v == NULL);
    /* Com NUL mas inválido no resto: continua sendo inválido -> padrão. */
    CHECK(ah_json_parse(LIT("[\"\\u0000\",]"), &v) == AH_ERR_INVALID && v == NULL);
    CHECK(ah_json_parse_or(LIT("[\"\\u0000\",]"), fb, &v) == AH_OK);
    check_stringify(v, "{}");

    CHECK(ah_json_parse(LIT("\"\\ud800x\""), &v) == AH_OK);
    check_stringify(v, "\"\xEF\xBF\xBDx\"");
    ah_json_free(fb);
}

/* Monta `d` arrays aninhados em `buf`, com `inner` (pode ser "") no meio. */
static size_t nested(char *buf, size_t d, const char *inner) {
    size_t n = strlen(inner);
    memset(buf, '[', d);
    memcpy(buf + d, inner, n);
    memset(buf + d + n, ']', d);
    buf[2 * d + n] = '\0';
    return 2 * d + n;
}

static void test_depth(void) {
    static char buf[2 * (AH_JSON_MAX_DEPTH + 1) + 8];
    ah_json *v = NULL;
    ah_json *fb = ah_json_new_object();
    ah_json *deep;
    size_t len;
    size_t i;
    char *s = NULL;

    /* Caso limite simétrico: AH_JSON_MAX_DEPTH contêineres com um escalar
     * dentro são lidos E escritos (escalar não conta nível). */
    len = nested(buf, AH_JSON_MAX_DEPTH, "1");
    CHECK(ah_json_parse(buf, len, &v) == AH_OK);
    CHECK(ah_json_stringify(v, &s, NULL) == AH_OK);
    CHECK(s != NULL && strcmp(s, buf) == 0);
    ah_text_free(s);
    s = NULL;
    ah_json_free(v);
    v = NULL;

    len = nested(buf, AH_JSON_MAX_DEPTH, "{}");
    CHECK(ah_json_parse(buf, len, &v) == AH_ERR_LIMIT && v == NULL);
    len = nested(buf, AH_JSON_MAX_DEPTH + 1, "");
    CHECK(ah_json_parse(buf, len, &v) == AH_ERR_LIMIT && v == NULL);
    /* O TS leria: parse_or repassa LIMIT em vez do padrão. */
    v = fb;
    CHECK(ah_json_parse_or(buf, len, fb, &v) == AH_ERR_LIMIT && v == NULL);

    /* Escrita: árvore montada pela API com AH_JSON_MAX_DEPTH contêineres
     * passa; com um a mais, AH_ERR_LIMIT. */
    deep = ah_json_new_number(1);
    for (i = 0; i < AH_JSON_MAX_DEPTH; i++) {
        ah_json *a = ah_json_new_array();
        CHECK(ah_json_push(a, deep) == AH_OK);
        deep = a;
    }
    CHECK(ah_json_stringify(deep, &s, NULL) == AH_OK);
    ah_text_free(s);
    s = NULL;
    {
        ah_json *a = ah_json_new_array();
        CHECK(ah_json_push(a, deep) == AH_OK);
        deep = a;
    }
    CHECK(ah_json_stringify(deep, &s, NULL) == AH_ERR_LIMIT && s == NULL);
    ah_json_free(deep);
    ah_json_free(fb);
}

static void test_parse_or(void) {
    ah_json *fb = ah_json_new_object();
    ah_json *v = NULL;
    const ah_json *m;
    double d = 0;
    bool b = false;

    CHECK(ah_json_set(fb, "padrao", ah_json_new_bool(true)) == AH_OK);

    /* vazio, NULL, inválido e null -> cópia do padrão */
    CHECK(ah_json_parse_or("", 0, fb, &v) == AH_OK);
    check_stringify(v, "{\"padrao\":true}");
    CHECK(ah_json_parse_or(NULL, 0, fb, &v) == AH_OK);
    check_stringify(v, "{\"padrao\":true}");
    CHECK(ah_json_parse_or(LIT("{quebrado"), fb, &v) == AH_OK);
    check_stringify(v, "{\"padrao\":true}");
    CHECK(ah_json_parse_or(LIT("null"), fb, &v) == AH_OK);
    check_stringify(v, "{\"padrao\":true}");

    /* válido -> o valor lido, com acesso tipado */
    CHECK(ah_json_parse_or(LIT("{\"n\":2.5,\"s\":\"x\",\"b\":false,\"z\":null,\"a\":[1,2]}"),
                           fb, &v) == AH_OK);
    CHECK(v != NULL && ah_json_type_of(v) == AH_JSON_OBJECT);
    CHECK(ah_json_number(ah_json_get(v, "n"), &d) && d == 2.5);
    CHECK(ah_json_string(ah_json_get(v, "s")) != NULL &&
          strcmp(ah_json_string(ah_json_get(v, "s")), "x") == 0);
    CHECK(ah_json_bool(ah_json_get(v, "b"), &b) && b == false);
    m = ah_json_get(v, "z");
    CHECK(m != NULL && ah_json_type_of(m) == AH_JSON_NULL);
    CHECK(ah_json_count(ah_json_get(v, "a")) == 2);
    CHECK(ah_json_get(v, "ausente") == NULL);
    CHECK(ah_json_string(ah_json_get(v, "n")) == NULL);
    CHECK(!ah_json_number(ah_json_get(v, "s"), &d));
    /* Um valor escalar lido também não é "null". */
    ah_json_free(v);
    CHECK(ah_json_parse_or(LIT("0"), fb, &v) == AH_OK);
    check_stringify(v, "0");

    /* padrão NULL -> *out NULL */
    v = fb; /* qualquer não-NULL, para ver que é zerado */
    CHECK(ah_json_parse_or(LIT("x"), NULL, &v) == AH_OK && v == NULL);
    ah_json_free(fb);
}

int main(void) {
    test_key_order();
    test_strings();
    test_numbers();
    test_powers_of_two();
    test_nested_and_null();
    test_set_replaces_in_place();
    test_parse_grammar();
    test_parse_limitations();
    test_depth();
    test_parse_or();
    return AH_TEST_END("test_core_json");
}
